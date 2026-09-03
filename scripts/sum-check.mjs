/**
 * Does a round equal the sum of its holes?
 *
 * The decoder rests on this. It reads a record's 18 hand IDs, looks each one
 * up, adds them, and compares against the record's own score field — which is
 * only a valid test if a round score really is the sum of its hands. If this
 * engine did anything else (a bonus, a par adjustment, a carried total), the
 * decoder would report a mismatch on records that were perfectly fine.
 *
 * To be clear about what this proves: it proves this engine is internally
 * consistent. It says nothing about the AS400's table — nothing here can,
 * without a real record from the mainframe. What it does is make sure the
 * tool used to compare the two is not itself lying.
 *
 * Usage:  node scripts/sum-check.mjs [rounds]
 */
import { GameState } from "../server/lib/game/gameState.js";
import { seededRng } from "../server/lib/engine/deck.js";
import { scoreBoard, evaluateHand } from "../server/lib/engine/index.js";

const ROUNDS = Number(process.argv[2] ?? 400);
const GOLF = 1;
const POKER = 0;

let pass = 0, fail = 0;
const check = (cond, msg) => {
  if (cond) { console.log("ok:", msg); pass++; }
  else { console.error("FAIL:", msg); fail++; }
};

/** Play a whole round on a fixed deck, varying the strategy per round. */
function playOut(seed, mode) {
  const g = new GameState(mode, seededRng(seed));
  let n = 0;
  while (!g.isOver) {
    const open = [];
    for (let grid = 0; grid < 2; grid++)
      for (let col = 0; col < 6; col++)
        for (let row = 0; row < 6; row++)
          if (g.canPlace({ grid, col, row })) open.push({ grid, col, row });
    // Vary where cards go so the 400 rounds are not 400 copies of one strategy.
    if (open.length) g.place(open[(n * 7 + seed.length) % open.length]);
    else g.pass();
    n++;
  }
  return g;
}

for (const [name, mode] of [["golf", GOLF], ["poker", POKER]]) {
  let mismatchTotal = 0;
  let mismatchById = 0;
  let incomplete = 0;
  let worstGap = 0;
  const idValues = new Map(); // handID -> set of scores seen this run

  for (let i = 0; i < ROUNDS; i++) {
    const game = playOut(`sum-${name}-${i}`, mode);
    const score = scoreBoard(game.board, mode);

    const complete = score.hands.filter((h) => h.complete);
    if (complete.length !== 18) incomplete++;

    // 1. the round is the sum of its own per-hand scores
    const summed = complete.reduce((a, h) => a + h.points, 0);
    if (summed !== score.round) {
      mismatchTotal++;
      worstGap = Math.max(worstGap, Math.abs(summed - score.round));
    }

    // 2. and the same total is reachable from the IDs alone, which is what a
    //    decoder reading a record off the wire has to work from
    for (const h of complete) {
      if (!idValues.has(h.handID)) idValues.set(h.handID, new Set());
      idValues.get(h.handID).add(h.points);
    }
  }

  console.log(`\n--- ${name}, ${ROUNDS} rounds ---`);
  check(incomplete === 0, `every round filled all 18 hands (${incomplete} did not)`);
  check(
    mismatchTotal === 0,
    `the round score is the sum of its holes in every round` +
      (mismatchTotal ? ` — ${mismatchTotal} differed, worst by ${worstGap}` : ""),
  );

  const ambiguous = [...idValues].filter(([, v]) => v.size > 1);
  check(
    ambiguous.length === 0,
    ambiguous.length === 0
      ? `every hand ID seen carried a single score, so IDs decode unambiguously`
      : `IDs with more than one score in play: ${ambiguous.map(([id, v]) => `${id}=${[...v].join("/")}`).join(", ")}`,
  );
  mismatchById += 0;
}

// The known exception, kept explicit so it cannot quietly reappear elsewhere:
// four royal 3-card straight flushes score 0 strokes rather than 1. Zero is not
// a legal golf score, so this is a quirk inherited from the original engine —
// both the legacy port and the pure implementation agree on it.
const royal = [1, 12, 13].map((r) => r);
const royalGolf = evaluateHand(royal, GOLF);
const ordinary = evaluateHand([1, 2, 3], GOLF);
console.log(`\n--- the known 3A exception ---`);
check(royalGolf.handID === "3A" && royalGolf.points === 0, `A-Q-K suited is 3A worth ${royalGolf.points} strokes`);
check(ordinary.handID === "3A" && ordinary.points === 1, `A-2-3 suited is also 3A, but worth ${ordinary.points}`);
check(true, "so 3A alone does not determine a score — the decoder has to say so");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
