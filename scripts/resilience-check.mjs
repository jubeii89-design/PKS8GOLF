/**
 * The things that decide whether a tournament survives its own morning.
 *
 * Each of these was measured as a real problem before it was fixed, so each
 * check names the number it is holding the line on.
 *
 * Usage:  node scripts/resilience-check.mjs
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../server/db.mjs";
import { Roster } from "../server/roster.mjs";
import { playRound } from "./lib/play-round.mjs";

const RELAY_PORT = 8961;
const DEAD_AS400 = "http://127.0.0.1:9/unreachable";
const DATA_DIR = mkdtempSync(join(tmpdir(), "resilience-"));
const BACKUP_DIR = mkdtempSync(join(tmpdir(), "resilience-backups-"));

const children = [];
const killRelayOnExit = () => { for (const c of children) { try { c.kill("SIGKILL"); } catch {} } };
process.on("exit", killRelayOnExit);
process.on("uncaughtException", (e) => { console.error(e); killRelayOnExit(); process.exit(1); });

let pass = 0, fail = 0;
const check = (cond, msg) => {
  if (cond) { console.log("ok:", msg); pass++; }
  else { console.error("FAIL:", msg); fail++; }
};

// --- a field of 40; enough to show contention without a slow test ---
const FIELD = 40;
const seedDb = new Db(DATA_DIR);
const seedRoster = new Roster(seedDb);
const field = [];
for (let i = 0; i < FIELD; i++) {
  const c = seedRoster.signup({ name: `Player ${String(i).padStart(3, "0")}`, email: `p${i}@example.com` });
  seedRoster.attachOrder(c.playerId, `O${i}`);
  seedRoster.markPaid(`O${i}`);
  field.push({ playerId: c.playerId, pin: (await seedRoster.issuePin(c.playerId)).pin });
}
seedDb.close();

const relay = spawn(process.execPath, ["server/relay.mjs"], {
  env: {
    ...process.env,
    PORT: String(RELAY_PORT), DATA_DIR, SESSION_SECRET: "resilience",
    // Deliberately unreachable: the point is that a dead mainframe must not be
    // felt by the players.
    AS400_URL: DEAD_AS400,
    BACKUP_DIR, BACKUP_INTERVAL_MS: "1500", BACKUP_KEEP: "3",
    ADMIN_TOKEN: "resilience-admin",
    PIN_ATTEMPT_LIMIT: "5",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
children.push(relay);
const logLines = [];
relay.stdout.on("data", (d) => logLines.push(String(d)));

const base = `http://127.0.0.1:${RELAY_PORT}`;
for (let i = 0; i < 80; i++) {
  try { await fetch(`${base}/health`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
}
const post = (p, b, t) => fetch(`${base}${p}`, {
  method: "POST",
  headers: { "Content-Type": "application/json", ...(t ? { Authorization: `Bearer ${t}` } : {}) },
  body: JSON.stringify(b),
});
const pct = (a, p) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))];

// --- 1. a shotgun start must not serialise behind password hashing ---
// Was: median 1.9s, worst 3.6s for 100 joins, because scryptSync held the loop.
const joinMs = [];
const joins = await Promise.all(field.map(async (p) => {
  const t = Date.now();
  const r = await (await post("/join", { playerId: p.playerId, pin: p.pin })).json();
  joinMs.push(Date.now() - t);
  return r;
}));
check(joins.every((j) => j.ok), `all ${FIELD} joined at once (${joins.filter((j) => !j.ok).length} failed)`);
check(pct(joinMs, 0.95) < 1500, `join p95 under 1.5s with hashing off the event loop (${pct(joinMs, 0.95)}ms)`);

// --- 2. a dead mainframe must not be the players' problem ---
// Was: median 6.1s per round, because the full retry ladder ran inline.
const roundMs = [];
const rounds = await Promise.all(joins.map(async (j) => {
  const { moves, trueScore } = playRound(j.seed);
  await post("/moves", { moves }, j.token);
  const t = Date.now();
  const r = await (await post("/round", { score: trueScore }, j.token)).json();
  roundMs.push(Date.now() - t);
  return r;
}));
check(rounds.every((r) => r.recorded), `every round recorded despite the AS400 being unreachable`);
check(
  pct(roundMs, 0.95) < 3000,
  `round p95 under 3s with a DEAD mainframe (${pct(roundMs, 0.95)}ms; was 6136ms inline)`,
);
check(rounds.every((r) => r.as400Pending), "and each one is queued for delivery rather than dropped");

const health = await (await fetch(`${base}/health`)).json();
check(health.as400Pending === FIELD, `all ${FIELD} records are waiting in the queue (${health.as400Pending})`);

// --- 3. the door resists guessing ---
const victim = field[0];
let lockedAt = null;
for (let i = 1; i <= 8 && lockedAt === null; i++) {
  const r = await post("/join", { playerId: victim.playerId, pin: String(900000 + i) });
  if (r.status === 429) lockedAt = i;
}
check(lockedAt !== null, `wrong PINs are eventually locked out (after ${lockedAt} tries)`);

// The right PIN is refused too while locked — otherwise the lock is decorative.
const whileLocked = await post("/join", { playerId: victim.playerId, pin: victim.pin });
check(whileLocked.status === 429, "even the correct PIN is refused while locked out");

// Another player is unaffected: the lock is per player, not global.
const bystander = await (await post("/join", { playerId: field[1].playerId, pin: field[1].pin })).json();
check(bystander.ok === true, "a different player is unaffected by someone else's lockout");

// An organiser can clear it.
check((await post("/admin/unlock", { playerId: victim.playerId })).status === 403,
  "clearing a lockout needs the admin token");
const unlocked = await (await post("/admin/unlock", { playerId: victim.playerId }, "resilience-admin")).json();
check(unlocked.wasLocked === true, "an organiser can clear a lockout");
const afterUnlock = await (await post("/join", { playerId: victim.playerId, pin: victim.pin })).json();
check(afterUnlock.ok === true, "and the player can get straight back in");

// --- 4. the data is being copied somewhere ---
await new Promise((r) => setTimeout(r, 2000)); // let a scheduled backup fire
const backups = readdirSync(BACKUP_DIR).filter((f) => f.endsWith(".db"));
check(backups.length > 0, `backups are being written (${backups.length} so far)`);

// A backup is only worth having if it opens and holds the data, so open the
// newest snapshot directly and count what is actually in it.
const { DatabaseSync } = await import("node:sqlite");
const newest = backups.sort().reverse()[0];
const snap = new DatabaseSync(join(BACKUP_DIR, newest));
const players = snap.prepare("SELECT COUNT(*) AS n FROM players").get().n;
const finished = snap.prepare("SELECT COUNT(*) AS n FROM rounds WHERE finished_at IS NOT NULL").get().n;
snap.close();
check(players === FIELD, `the snapshot holds the whole roster (${players}/${FIELD})`);
check(finished > 0, `and the rounds played before it was taken (${finished})`);

relay.kill("SIGTERM");
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
