/**
 * Step 2: the score is derived, not accepted.
 *
 * An honest player and a cheating player send the *same* moves; only the
 * claimed score differs. If the server is doing its job the two rounds score
 * identically, because the claim is never consulted.
 *
 * Usage:  node scripts/verify-check.mjs   (after: npm run build:server)
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../server/db.mjs";
import { Roster } from "../server/roster.mjs";
import { GameState } from "../server/lib/game/gameState.js";
import { seededRng } from "../server/lib/engine/deck.js";
import { scoreBoard } from "../server/lib/engine/index.js";

const RELAY_PORT = 8841;
const AS400_PORT = 8842;
const DATA_DIR = mkdtempSync(join(tmpdir(), "verify-check-"));
const SECRET = "verify-check-secret";
const MODE = 0; // PokerStr8ts

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

// --- a paid-up field ---
const seedDb = new Db(DATA_DIR);
const seedRoster = new Roster(seedDb);
function enrol(name, email) {
  const c = seedRoster.signup({ name, email });
  seedRoster.attachOrder(c.playerId, `ORDER-${c.playerId}`);
  seedRoster.markPaid(`ORDER-${c.playerId}`);
  return { playerId: c.playerId, pin: seedRoster.issuePin(c.playerId).pin };
}
const honest = enrol("Honest Player", "honest@example.com");
const cheat = enrol("Cheating Player", "cheat@example.com");
seedDb.close();

const received = [];
const as400 = createServer((req, res) => {
  received.push(new URL(req.url, "http://x").searchParams.get("HDATASTREAM"));
  res.writeHead(200); res.end("OK");
});
await new Promise((r) => as400.listen(AS400_PORT, r));

const relay = spawn(process.execPath, ["server/relay.mjs"], {
  env: {
    ...process.env, PORT: String(RELAY_PORT), DATA_DIR, SESSION_SECRET: SECRET,
    AS400_URL: `http://127.0.0.1:${AS400_PORT}/pgm`,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
children.push(relay);
const relayLog = [];
relay.stdout.on("data", (d) => { relayLog.push(String(d)); process.stdout.write(`  relay| ${d}`); });

const base = `http://127.0.0.1:${RELAY_PORT}`;
for (let i = 0; i < 80; i++) {
  try { await fetch(`${base}/health`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
}
const post = (path, body, token) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

/** Play a full round on the server's deck, exactly as the browser would. */
function playRound(seed) {
  const game = new GameState(MODE, seededRng(seed));
  const moves = game.preplaced.map((p, i) => ({
    seq: i, action: "round-start", card: p.card, cell: p.cell, scoreAfter: 0, ts: new Date().toISOString(),
  }));
  while (!game.isOver) {
    const before = game.currentCard;
    const open = [];
    for (let grid = 0; grid < 2; grid++)
      for (let col = 0; col < 6; col++)
        for (let row = 0; row < 6; row++)
          if (game.canPlace({ grid, col, row })) open.push({ grid, col, row });
    if (open.length > 0) game.place(open[0]);
    else game.pass();
    const last = game.playLog[game.playLog.length - 1];
    moves.push({
      seq: game.preplaced.length + last.seq,
      action: last.action, card: before, cell: last.cell,
      scoreAfter: scoreBoard(game.board, MODE).round, ts: new Date().toISOString(),
    });
  }
  return { moves, trueScore: scoreBoard(game.board, MODE).round };
}

// --- the honest player ---
const joinH = await (await post("/join", { playerId: honest.playerId, pin: honest.pin })).json();
check(typeof joinH.seed === "string", "join hands out a deck seed");
const honestRound = playRound(joinH.seed);
await post("/moves", { moves: honestRound.moves }, joinH.token);
const honestRes = await (await post("/round", { score: honestRound.trueScore }, joinH.token)).json();
check(honestRes.recorded === true, "the honest round is recorded");
check(honestRes.verified === true, "the honest round is marked verified");
check(
  honestRes.score === honestRound.trueScore,
  `the derived score matches an honest claim (${honestRes.score} vs ${honestRound.trueScore})`,
);

// --- the cheat: identical moves, absurd claim ---
const joinC = await (await post("/join", { playerId: cheat.playerId, pin: cheat.pin })).json();
const cheatRound = playRound(joinC.seed);
await post("/moves", { moves: cheatRound.moves }, joinC.token);
const cheatRes = await (await post("/round", { score: 9999 }, joinC.token)).json();
check(cheatRes.recorded === true, "the cheat's round is still recorded");
check(
  cheatRes.score === cheatRound.trueScore,
  `the claim of 9999 is ignored; the replay stands (${cheatRes.score} vs true ${cheatRound.trueScore})`,
);
check(cheatRes.score !== 9999, "9999 did NOT reach the scoreboard");
check(
  relayLog.join("").includes("SCORE MISMATCH"),
  "the mismatch is logged as evidence rather than passing silently",
);

// --- the leaderboard reflects derived scores only ---
const { rows } = await (await fetch(`${base}/leaderboard?playerId=${cheat.playerId}`)).json();
check(rows.every((r) => r.score !== 9999), "no invented score appears on the leaderboard");
check(rows.length === 2, `both rounds are on the board (${rows.length})`);

// --- fabricated moves cannot be scored at all ---
const joinF = await (await post("/join", { playerId: honest.playerId, pin: honest.pin })).json();
await post("/moves", {
  moves: [
    // The same cell twice: impossible, and the engine knows it.
    { seq: 6, action: "place", card: 101, cell: { grid: 0, col: 1, row: 1 }, scoreAfter: 0, ts: "" },
    { seq: 7, action: "place", card: 102, cell: { grid: 0, col: 1, row: 1 }, scoreAfter: 0, ts: "" },
  ],
}, joinF.token);
const bogus = await post("/round", { score: 500 }, joinF.token);
check(bogus.status === 422, `a round that cannot be replayed is refused (${bogus.status})`);
check(
  relayLog.join("").includes("WILL NOT REPLAY"),
  "an unreplayable round is logged rather than guessed at",
);

// --- what the AS400 was told matches what was derived ---
check(received.length === 2, `one record per verified round (${received.length})`);
const scoreField = received[0].slice(31 + 36, 31 + 36 + 3);
check(
  Number(scoreField) === Math.abs(honestRound.trueScore),
  `the record carries the derived score (field "${scoreField}" vs ${honestRound.trueScore})`,
);

relay.kill("SIGTERM");
as400.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
