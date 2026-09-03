/**
 * What actually reaches the AS400 for a round that finished under.
 *
 * Two things about the score field are unconfirmed — which mode's score it
 * wants, and how a negative is written — so both are configuration. This
 * proves each setting produces what it claims, and that the default is the
 * only one that misreports.
 *
 * Usage:  node scripts/score-encoding-check.mjs
 */
import { encodeScore } from "../server/lib/game/as400Record.js";
import { deriveRound } from "../server/replay.mjs";
import { playRound } from "./lib/play-round.mjs";
import { seededRng } from "../server/lib/engine/deck.js";
import { GameState } from "../server/lib/game/gameState.js";
import { scoreBoard } from "../server/lib/engine/index.js";

let pass = 0, fail = 0;
const check = (cond, msg) => {
  if (cond) { console.log("ok:", msg); pass++; }
  else { console.error("FAIL:", msg); fail++; }
};

// --- the encoding itself ---
check(encodeScore(97) === "097", "a positive score is three plain digits");
check(encodeScore(0) === "000", "zero is 000");
check(encodeScore(109) === "109", "the top of the observed range fits");

check(encodeScore(-18, "abs") === "018", "abs: -18 becomes 018 — the mainframe reads +18 (why this needs settling)");
check(encodeScore(-18, "minus") === "-18", "minus: -18 stays -18");
check(encodeScore(-5, "minus") === "-05", "minus: -5 pads to -05");
check(encodeScore(-18, "overpunch") === "01Q", "overpunch: -18 becomes 01Q, the sign riding on the last digit");
check(encodeScore(-20, "overpunch") === "02}", "overpunch: a trailing zero becomes }");
check(encodeScore(-62, "overpunch") === "06K", "overpunch: the worst observed round encodes cleanly");

// A score past -99 cannot be written with a leading minus; it must not
// silently truncate into a different number.
check(encodeScore(-120, "minus") === "120", "minus: below -99 falls back rather than truncating");
check(encodeScore(-120, "overpunch") === "12}", "overpunch: no such limit");

// --- a real round, scored both ways ---
// Search for a seed that finishes negative in points; a third of rounds do.
let seed = null, pokerScore = 0, golfScore = 0;
for (let i = 0; i < 200 && seed === null; i++) {
  const candidate = `neg-${i}`;
  const g = new GameState(0, seededRng(candidate));
  while (!g.isOver) {
    const open = [];
    for (let grid = 0; grid < 2; grid++)
      for (let col = 0; col < 6; col++)
        for (let row = 0; row < 6; row++)
          if (g.canPlace({ grid, col, row })) open.push({ grid, col, row });
    if (open.length) g.place(open[(open.length / 2) | 0]); else g.pass();
  }
  const poker = scoreBoard(g.board, 0).round;
  if (poker < 0) { seed = candidate; pokerScore = poker; golfScore = scoreBoard(g.board, 1).round; }
}
check(seed !== null, `found a round that finishes under: ${pokerScore} points`);
check(golfScore > 0, `the same board scored as golf is positive: ${golfScore} strokes`);

// The replay reads moves as the database returns them, with the cell
// flattened into columns — so flatten them here rather than passing the
// client's nested shape, which is not what production ever hands it.
const { moves: clientMoves } = playRound(seed);
const moves = clientMoves.map((m) => ({
  seq: m.seq, action: m.action, card: m.card,
  grid: m.cell?.grid ?? null, col: m.cell?.col ?? null, row: m.cell?.row ?? null,
}));
const scoreField = (r) => r.record.slice(31 + 36, 31 + 36 + 3);
const args = { seed, mode: 0, moves, playerId: "TESTPLAYER00001", pin: "123456" };

const asPoker = deriveRound({ ...args, reportMode: 0, negatives: "abs" });
check(asPoker.reportedScore < 0, `reporting points gives a negative score (${asPoker.reportedScore})`);
check(
  scoreField(asPoker) === String(Math.abs(asPoker.reportedScore)).padStart(3, "0"),
  `and the default writes it unsigned: "${scoreField(asPoker)}" for ${asPoker.reportedScore}`,
);

const asPokerOverpunch = deriveRound({ ...args, reportMode: 0, negatives: "overpunch" });
check(
  /[}JKLMNOPQR]$/.test(scoreField(asPokerOverpunch)),
  `overpunch marks it as negative: "${scoreField(asPokerOverpunch)}"`,
);

const asGolf = deriveRound({ ...args, reportMode: 1, negatives: "abs" });
check(asGolf.reportedScore > 0, `reporting strokes avoids the problem entirely (${asGolf.reportedScore})`);
check(
  scoreField(asGolf) === String(asGolf.reportedScore).padStart(3, "0"),
  `and needs no sign at all: "${scoreField(asGolf)}"`,
);
check(
  asGolf.round === asPoker.round,
  "switching the reported mode does not change the score the leaderboard shows",
);
check(asGolf.record.length === 106, "the record stays 106 characters either way");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
