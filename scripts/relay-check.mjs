/**
 * Proves the relay does the things the AS400 cannot do alone: accept a move
 * batch, confirm an AS400 delivery, serve standings, and survive a restart.
 *
 * Players are seeded through the real roster rather than invented, because the
 * database now insists a round belongs to someone who actually exists — which
 * is the point of Step 1.
 *
 * Runs against a stub AS400 so nothing touches the live mainframe.
 *
 * Usage:  node scripts/relay-check.mjs
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../server/db.mjs";
import { Roster } from "../server/roster.mjs";

const RELAY_PORT = 8791;
const AS400_PORT = 8792;
const DATA_DIR = mkdtempSync(join(tmpdir(), "relay-check-"));
const SECRET = "relay-check-secret";

let pass = 0, fail = 0;
const check = (cond, msg) => {
  if (cond) { console.log("ok:", msg); pass++; }
  else { console.error("FAIL:", msg); fail++; }
};

// --- seed a paid-up field, the way signup would have ---
const seedDb = new Db(DATA_DIR);
const seedRoster = new Roster(seedDb);
function enrol(name, email) {
  const created = seedRoster.signup({ name, email });
  seedRoster.attachOrder(created.playerId, `ORDER-${created.playerId}`);
  seedRoster.markPaid(`ORDER-${created.playerId}`);
  const { pin } = seedRoster.issuePin(created.playerId);
  return { playerId: created.playerId, pin, name };
}
const gordon = enrol("Gordon Stitt", "gordon@example.com");
const ada = enrol("Ada Lovelace", "ada@example.com");
seedDb.close();

// --- stub AS400: records what it receives, so delivery can be verified ---
const received = [];
let as400ShouldFail = false;
const as400 = createServer((req, res) => {
  if (as400ShouldFail) { res.writeHead(500); res.end("boom"); return; }
  received.push(new URL(req.url, "http://x").searchParams.get("HDATASTREAM"));
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("OK");
});
await new Promise((r) => as400.listen(AS400_PORT, r));

const relayEnv = {
  ...process.env,
  PORT: String(RELAY_PORT),
  DATA_DIR,
  SESSION_SECRET: SECRET,
  AS400_URL: `http://127.0.0.1:${AS400_PORT}/pgm`,
};
let relay = spawn(process.execPath, ["server/relay.mjs"], { env: relayEnv, stdio: ["ignore", "pipe", "pipe"] });
relay.stdout.on("data", (d) => process.stdout.write(`  relay| ${d}`));
relay.stderr.on("data", (d) => process.stderr.write(`  relay! ${d}`));

const base = `http://127.0.0.1:${RELAY_PORT}`;
const waitForRelay = async () => {
  for (let i = 0; i < 80; i++) {
    try { await fetch(`${base}/health`); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error("relay never came up");
};
await waitForRelay();

const post = (path, body, token) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

// --- join with real credentials ---
const joinGordon = await (await post("/join", { playerId: gordon.playerId, pin: gordon.pin })).json();
check(joinGordon.ok === true, `a paid player joins (${joinGordon.reason ?? "ok"})`);
check(typeof joinGordon.token === "string", "join issues a session token");
check(typeof joinGordon.seed === "string" && joinGordon.seed.length > 0, "join issues a deck seed");

const joinAda = await (await post("/join", { playerId: ada.playerId, pin: ada.pin })).json();
check(joinAda.ok === true, "a second player joins independently");
check(joinAda.seed !== joinGordon.seed, "each player gets their own deck");

// --- 1. the audit trail has somewhere to land ---
const moves = [
  { seq: 0, action: "round-start", card: 101, cell: null, scoreAfter: 0, ts: new Date().toISOString() },
  { seq: 1, action: "place", card: 105, cell: { grid: 0, col: 1, row: 1 }, scoreAfter: 3, ts: new Date().toISOString() },
];
const moveRes = await post("/moves", { moves }, joinGordon.token);
check(moveRes.ok, "relay accepts a move batch");
check((await moveRes.json()).stored === 2, "relay stores both moves");

// A retried flush must not duplicate — the client re-sends what it could not confirm.
const again = await (await post("/moves", { moves }, joinGordon.token)).json();
check(again.stored === 0, `a repeated flush stores nothing new (${again.stored})`);

// --- 2. AS400 delivery is confirmed, not assumed ---
const record = "TOURT22422" + gordon.playerId + "100005" + "3E".repeat(18) + "037" + "AJ".repeat(18);
const roundBody = await (await post("/round", { score: 37, record }, joinGordon.token)).json();
check(roundBody.recorded === true, "relay records the round");
check(roundBody.as400Delivered === true, "relay CONFIRMS the AS400 accepted the record");
check(received.length === 1 && received[0] === record, "stub AS400 actually received the exact record");

// --- 3. a failed AS400 send is queued, not lost ---
as400ShouldFail = true;
const adaRecord = record.replace(gordon.playerId, ada.playerId);
const failBody = await (await post("/round", { score: 51, record: adaRecord }, joinAda.token)).json();
check(failBody.recorded === true, "a round is recorded even when the AS400 is down");
check(failBody.as400Delivered === false, "relay does not claim delivery when the AS400 failed");
check(failBody.as400Pending === true, "the undelivered record is queued for retry");
as400ShouldFail = false;

// --- 4. standings: the read path the AS400 cannot provide ---
const { rows } = await (await fetch(`${base}/leaderboard?playerId=${gordon.playerId}`)).json();
check(rows.length === 2, `standings include every player seen (${rows.length})`);
check(rows[0].score === 51 && rows[0].rank === 1, "higher score ranks first");
check(rows[1].playerName === "You" && rows[1].isYou === true, "the asking player is flagged as You");
check(rows[0].playerName === "Ada Lovelace", `other players keep their real name (${rows[0].playerName})`);

// --- 5. a restart does not empty the field ---
relay.kill("SIGTERM");
await new Promise((r) => setTimeout(r, 400));
relay = spawn(process.execPath, ["server/relay.mjs"], { env: relayEnv, stdio: ["ignore", "pipe", "pipe"] });
relay.stdout.on("data", (d) => process.stdout.write(`  relay2| ${d}`));
await waitForRelay();

const after = await (await fetch(`${base}/leaderboard?playerId=${gordon.playerId}`)).json();
check(after.rows.length === 2, "standings survive a relay restart");
const health = await (await fetch(`${base}/health`)).json();
check(health.registered === 2 && health.paid === 2, `roster survives a restart (${health.registered}/${health.paid})`);
check(health.as400Pending === 1, `the undelivered record is still queued after a restart (${health.as400Pending})`);

// --- 6. the questions the JSONL logs could not answer ---
const opsDb = new Db(DATA_DIR);
check(opsDb.paidButNeverPlayed().length === 0, "nobody paid-but-never-played (both finished)");
check(opsDb.moveCount(joinGordon.roundId) === 2, "moves are queryable by round");
opsDb.close();

relay.kill("SIGTERM");
as400.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
