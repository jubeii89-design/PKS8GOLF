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
import { issueToken } from "../server/auth.mjs";

const PORT = 8831;
const DATA_DIR = mkdtempSync(join(tmpdir(), "auth-check-"));
const SECRET = "test-session-secret";

let pass = 0, fail = 0;
const check = (cond, msg) => {
  if (cond) { console.log("ok:", msg); pass++; }
  else { console.error("FAIL:", msg); fail++; }
};

const relay = spawn(process.execPath, ["server/relay.mjs"], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR, AS400_URL: "http://127.0.0.1:9/x", SESSION_SECRET: SECRET },
  stdio: ["ignore", "pipe", "pipe"],
});
relay.stdout.on("data", (d) => process.stdout.write(`  relay| ${d}`));

const base = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 60; i++) {
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
const anon = await post("/round", fakeRound);
check(anon.status === 401, `posting a score with no token is refused (${anon.status})`);

const garbage = await post("/round", fakeRound, "not-a-real-token");
check(garbage.status === 401, `a made-up token is refused (${garbage.status})`);

// A token signed with the wrong secret is the realistic forgery attempt.
const forged = issueToken({ playerId: "TOTALLY_FAKE", roundId: "r1" }); // signed with a *different* secret
const forgedRes = await post("/round", fakeRound, forged);
check(forgedRes.status === 401, `a token signed with the wrong secret is refused (${forgedRes.status})`);

const anonMoves = await post("/moves", { moves: [{ seq: 0, action: "place" }] });
check(anonMoves.status === 401, `streaming moves with no token is refused (${anonMoves.status})`);

const board = await (await fetch(`${base}/leaderboard?playerId=x`)).json();
check(board.rows.length === 0, `nothing reached the leaderboard (${board.rows.length} rows)`);

// --- an expired session is refused too ---
const expired = issueToken({ playerId: "SOMEONE", roundId: "r2" }, Date.now() - 24 * 60 * 60 * 1000);
check((await post("/round", fakeRound, expired)).status === 401, "an expired token is refused");

// --- a real token works, and identity comes from the token, not the body ---
process.env.SESSION_SECRET = SECRET; // sign as the server would
const { issueToken: signAsServer } = await import(`../server/auth.mjs?real=${Date.now()}`);
const good = signAsServer({ playerId: "REALPLAYER00001", roundId: "r3" });

const accepted = await post("/round", { ...fakeRound, record: "TOURT-real" }, good);
check(accepted.ok, `a validly signed token is accepted (${accepted.status})`);

const after = await (await fetch(`${base}/leaderboard?playerId=REALPLAYER00001`)).json();
check(after.rows.length === 1, "the round was recorded");
check(
  after.rows[0]?.isYou === true,
  `the round is filed under the TOKEN's player, not the body's "${fakeRound.playerId}"`,
);

relay.kill("SIGTERM");
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
