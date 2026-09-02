/**
 * Proves the relay does the three things the AS400 cannot do alone:
 * accepts a move batch, confirms an AS400 delivery, and serves standings.
 *
 * Runs against a stub AS400 so nothing touches the live mainframe.
 *
 * Usage:  node scripts/relay-check.mjs
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RELAY_PORT = 8791;
const AS400_PORT = 8792;
const DATA_DIR = mkdtempSync(join(tmpdir(), "relay-check-"));
// Writes now need a session. Sign with the same secret the relay is given.
const SECRET = "relay-check-secret";
// auth.mjs reads the secret when it loads, so set it before importing.
process.env.SESSION_SECRET = SECRET;
const { issueToken } = await import("../server/auth.mjs");
const tokenFor = (playerId) => issueToken({ playerId, roundId: `round-${playerId}` });

let pass = 0;
let fail = 0;
const check = (cond, msg) => {
  if (cond) { console.log("ok:", msg); pass++; }
  else { console.error("FAIL:", msg); fail++; }
};

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

// --- relay under test ---
const relay = spawn(process.execPath, ["server/relay.mjs"], {
  env: {
    ...process.env,
    PORT: String(RELAY_PORT),
    DATA_DIR,
    SESSION_SECRET: SECRET,
    AS400_URL: `http://127.0.0.1:${AS400_PORT}/pgm`,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
relay.stdout.on("data", (d) => process.stdout.write(`  relay| ${d}`));
relay.stderr.on("data", (d) => process.stderr.write(`  relay! ${d}`));

const base = `http://127.0.0.1:${RELAY_PORT}`;
for (let i = 0; i < 50; i++) {
  try { await fetch(`${base}/health`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
}

// --- 1. the audit trail has somewhere to land ---
const moves = [
  { tournamentId: "T1", playerId: "GORDONSTITT0001", seq: 0, action: "round-start", card: 101, cell: null, scoreAfter: 0, ts: new Date().toISOString() },
  { tournamentId: "T1", playerId: "GORDONSTITT0001", seq: 1, action: "place", card: 105, cell: { grid: 0, col: 1, row: 1 }, scoreAfter: 3, ts: new Date().toISOString() },
];
const moveRes = await fetch(`${base}/moves`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenFor("GORDONSTITT0001")}` },
  body: JSON.stringify({ moves }),
});
check(moveRes.ok, "relay accepts a move batch");
check((await moveRes.json()).received === 2, "relay reports both moves received");
const movesFile = readFileSync(join(DATA_DIR, "moves.jsonl"), "utf8").trim().split("\n");
check(movesFile.length === 2, `moves persisted to disk (${movesFile.length} lines)`);
check(JSON.parse(movesFile[1]).seq === 1, "persisted move keeps its sequence number");

// --- 2. AS400 delivery is confirmed, not assumed ---
const record = "TOURT22422GORDONSTITT0001100005" + "3E".repeat(18) + "037" + "AJ".repeat(18);
const roundRes = await fetch(`${base}/round`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenFor("GORDONSTITT0001")}` },
  body: JSON.stringify({ score: 37, record }),
});
const roundBody = await roundRes.json();
check(roundBody.recorded === true, "relay records the round");
check(roundBody.as400Delivered === true, "relay CONFIRMS the AS400 accepted the record");
check(received.length === 1 && received[0] === record, "stub AS400 actually received the exact record");

// --- 3. a failed AS400 send is queued, not lost ---
as400ShouldFail = true;
const failRes = await fetch(`${base}/round`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenFor("SECONDPLAYER001")}` },
  body: JSON.stringify({ score: 51, record: record.replace("GORDONSTITT0001", "SECONDPLAYER001") }),
});
const failBody = await failRes.json();
check(failBody.recorded === true, "a round is recorded even when the AS400 is down");
check(failBody.as400Delivered === false, "relay does not claim delivery when the AS400 failed");
check(failBody.as400Pending === true, "the undelivered record is queued for retry");
as400ShouldFail = false;

// --- 4. standings: the read path the AS400 cannot provide ---
const lbRes = await fetch(`${base}/leaderboard?playerId=GORDONSTITT0001`);
const { rows } = await lbRes.json();
check(rows.length === 2, `standings include every player seen (${rows.length})`);
check(rows[0].score === 51 && rows[0].rank === 1, "higher score ranks first");
check(rows[1].playerName === "You" && rows[1].isYou === true, "the asking player is flagged as You");
check(rows[0].playerName === "SECONDPLAYER001", "other players are identified on the board");

// --- 5. a restart does not empty the field ---
relay.kill("SIGTERM");
await new Promise((r) => setTimeout(r, 300));
const relay2 = spawn(process.execPath, ["server/relay.mjs"], {
  env: { ...process.env, PORT: String(RELAY_PORT), DATA_DIR, SESSION_SECRET: SECRET, AS400_URL: `http://127.0.0.1:${AS400_PORT}/pgm` },
  stdio: ["ignore", "pipe", "pipe"],
});
relay2.stdout.on("data", (d) => process.stdout.write(`  relay2| ${d}`));
for (let i = 0; i < 50; i++) {
  try { await fetch(`${base}/health`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
}
const after = await (await fetch(`${base}/leaderboard?playerId=GORDONSTITT0001`)).json();
check(after.rows.length === 2, "standings survive a relay restart");

relay2.kill("SIGTERM");
as400.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
