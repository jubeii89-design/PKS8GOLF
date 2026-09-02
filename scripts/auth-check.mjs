/**
 * Step 0: nobody writes without having passed the door.
 *
 * The case that matters is the one that used to work — posting a score for a
 * player who never signed up, never paid, and never joined.
 *
 * Usage:  node scripts/auth-check.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../server/db.mjs";
import { Roster } from "../server/roster.mjs";

const PORT = 8831;
const DATA_DIR = mkdtempSync(join(tmpdir(), "auth-check-"));
const SECRET = "auth-check-secret";

// A failed check exits early; without this the relay would outlive the test,
// hold the port, and make the NEXT run fail for the wrong reason.
const children = [];
const killRelayOnExit = () => { for (const c of children) { try { c.kill("SIGKILL"); } catch {} } };
process.on("exit", killRelayOnExit);
process.on("uncaughtException", (e) => { console.error(e); killRelayOnExit(); process.exit(1); });

let pass = 0, fail = 0;
const check = (cond, msg) => {
  if (cond) { console.log("ok:", msg); pass++; }
  else { console.error("FAIL:", msg); fail++; }
};

// --- one real, paid-up player to contrast against the forgeries ---
const seedDb = new Db(DATA_DIR);
const seedRoster = new Roster(seedDb);
const created = seedRoster.signup({ name: "Real Player", email: "real@example.com" });
seedRoster.attachOrder(created.playerId, "ORDER-1");
seedRoster.markPaid("ORDER-1");
const { pin } = seedRoster.issuePin(created.playerId);
seedDb.close();

// Tokens signed with a secret the relay does NOT share are the realistic
// forgery: the attacker knows the format but not the key.
process.env.SESSION_SECRET = "a-different-secret-entirely";
const { issueToken: signWithWrongKey } = await import("../server/auth.mjs");

const relay = spawn(process.execPath, ["server/relay.mjs"], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR, AS400_URL: "http://127.0.0.1:9/x", SESSION_SECRET: SECRET },
  stdio: ["ignore", "pipe", "pipe"],
});
children.push(relay);
relay.stdout.on("data", (d) => process.stdout.write(`  relay| ${d}`));

const base = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 80; i++) {
  try { await fetch(`${base}/health`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
}

const post = (path, body, token) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

const fakeRound = { playerId: "TOTALLY_FAKE", playerName: "Cheater McFraud", score: 9999, record: "TOURT-fake" };

// --- the exact attack that worked before Step 0 ---
check((await post("/round", fakeRound)).status === 401, "posting a score with no token is refused");
check((await post("/round", fakeRound, "not-a-real-token")).status === 401, "a made-up token is refused");
check(
  (await post("/round", fakeRound, signWithWrongKey({ playerId: "TOTALLY_FAKE", roundId: "r1" }))).status === 401,
  "a well-formed token signed with the wrong key is refused",
);
check(
  (await post("/round", fakeRound, signWithWrongKey({ playerId: "X", roundId: "r2" }, Date.now() - 864e5))).status === 401,
  "an expired token is refused",
);
check((await post("/moves", { moves: [{ seq: 0, action: "place" }] })).status === 401,
  "streaming moves with no token is refused");

const board = await (await fetch(`${base}/leaderboard?playerId=x`)).json();
check(board.rows.length === 0, `nothing reached the leaderboard (${board.rows.length} rows)`);

// --- a real join, and identity taken from the token rather than the body ---
const joined = await (await post("/join", { playerId: created.playerId, pin })).json();
check(joined.ok === true, `a paid player joins (${joined.reason ?? "ok"})`);

const accepted = await post("/round", { ...fakeRound, record: "TOURT-real" }, joined.token);
check(accepted.ok, `a validly signed token is accepted (${accepted.status})`);

const after = await (await fetch(`${base}/leaderboard?playerId=${created.playerId}`)).json();
check(after.rows.length === 1, "the round was recorded");
check(after.rows[0]?.isYou === true, `the round is filed under the TOKEN's player, not the body's "${fakeRound.playerId}"`);
check(after.rows[0]?.playerName === "You", "the board names them from the roster, not from the request");

relay.kill("SIGTERM");
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
