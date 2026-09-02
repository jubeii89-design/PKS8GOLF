/**
 * Working out what a round actually scored, without asking the browser.
 *
 * A client that computes its own score can lie about it, and no amount of
 * authentication fixes that — a paying player can authenticate honestly and
 * still send `score: 9999`. The only real answer is for the server to compute
 * the score itself, which it can, because it holds both halves:
 *
 *   - the deck, since the seed was issued at join and signed into the token,
 *     so a player cannot re-join until they like their cards; and
 *   - the moves, streamed as they were played.
 *
 * Replaying those through the same engine the browser ran gives the score. The
 * client's own figure is not consulted at all — it is compared, and a
 * disagreement is recorded as evidence rather than trusted either way.
 *
 * The engine validates the replay for free: `place()` throws on a cell that is
 * occupied or out of play, so a fabricated move sequence fails to replay
 * instead of quietly producing a bogus score.
 *
 * Imports come from server/lib — the real engine compiled for Node by
 * `npm run build:server`, not a second implementation that could drift.
 */

import { GameState } from "./lib/game/gameState.js";
import { scoreBoard } from "./lib/engine/index.js";
import { seededRng } from "./lib/engine/deck.js";
import { buildRecord } from "./lib/game/as400Record.js";

/** The 6 opening cards are dealt by the constructor, not played by anyone. */
const PREPLACED = 6;

/**
 * Rebuild a round from its seed and its moves.
 *
 * Returns the score the moves actually produce, or why they could not be
 * replayed. `claimedScore` is only ever reported back for comparison.
 */
export function replayRound({ seed, mode, moves, claimedScore = null }) {
  if (typeof seed !== "string" || seed === "") return { ok: false, reason: "no-seed" };

  const game = new GameState(mode, seededRng(seed));

  // Play order is the sequence number, not arrival order: batches can land out
  // of order, and a retry can land twice.
  const ordered = [...moves]
    .filter((m) => m.action === "place" || m.action === "pass")
    .sort((a, b) => a.seq - b.seq);

  const seen = new Set();
  let applied = 0;
  let cardMismatches = 0;

  for (const move of ordered) {
    if (seen.has(move.seq)) continue; // duplicate flush; the first one stands
    seen.add(move.seq);

    // The card is the deck's to decide. If the client's claim disagrees, the
    // deck still wins — but it is worth counting, because a mismatch means
    // either a bug or someone playing a different game than they reported.
    if (typeof move.card === "number" && game.currentCard !== null && move.card !== game.currentCard) {
      cardMismatches++;
    }

    try {
      if (move.action === "pass") {
        game.pass();
      } else {
        if (move.grid === null || move.col === null || move.row === null) {
          return { ok: false, reason: "place-without-cell", atSeq: move.seq };
        }
        game.place({ grid: move.grid, col: move.col, row: move.row });
      }
      applied++;
    } catch (err) {
      // An illegal move means the sequence is not a real round.
      return { ok: false, reason: "illegal-move", atSeq: move.seq, detail: err.message };
    }
    if (game.isOver) break;
  }

  const score = scoreBoard(game.board, mode);
  return {
    ok: true,
    score,
    round: score.round,
    handCompletions: game.handCompletions,
    movesApplied: applied,
    cardMismatches,
    complete: game.isOver,
    // Kept for the audit trail: a gap between these two is the interesting part.
    claimedScore,
    agrees: claimedScore === null || claimedScore === score.round,
  };
}

/**
 * Replay a round and build the record the AS400 receives from the result.
 *
 * The record is assembled here, from the derived score, so what the mainframe
 * is told and what the leaderboard shows cannot disagree.
 */
export function deriveRound({ seed, mode, moves, playerId, pin, claimedScore = null, now = new Date() }) {
  const replay = replayRound({ seed, mode, moves, claimedScore });
  if (!replay.ok) return replay;

  const record = buildRecord(
    { playerId, pin, score: replay.score, handCompletions: replay.handCompletions },
    now,
  );
  return { ...replay, record };
}

export { PREPLACED };
