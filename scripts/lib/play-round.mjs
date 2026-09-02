/**
 * Plays a full round the way the browser does, for tests.
 *
 * Uses the compiled engine from server/lib, so a test round is produced by the
 * same code the real client runs and the same code the server replays. If this
 * drifted from either, the tests would be checking a fiction.
 */
import { GameState } from "../../server/lib/game/gameState.js";
import { seededRng } from "../../server/lib/engine/deck.js";
import { scoreBoard } from "../../server/lib/engine/index.js";

/**
 * @param seed  the deck seed the server issued at join
 * @param mode  0 = PokerStr8ts
 * @returns the move log in the shape the client sends, and the true score
 */
export function playRound(seed, mode = 0) {
  const game = new GameState(mode, seededRng(seed));

  // The opening cards are dealt, not played — logged first so the round can be
  // reconstructed from an empty board.
  const moves = game.preplaced.map((p, i) => ({
    seq: i,
    action: "round-start",
    card: p.card,
    cell: p.cell,
    scoreAfter: 0,
    ts: new Date().toISOString(),
  }));

  while (!game.isOver) {
    const cardInHand = game.currentCard;
    const open = [];
    for (let grid = 0; grid < 2; grid++) {
      for (let col = 0; col < 6; col++) {
        for (let row = 0; row < 6; row++) {
          if (game.canPlace({ grid, col, row })) open.push({ grid, col, row });
        }
      }
    }
    if (open.length > 0) game.place(open[0]);
    else game.pass();

    const last = game.playLog[game.playLog.length - 1];
    moves.push({
      seq: game.preplaced.length + last.seq,
      action: last.action,
      card: cardInHand,
      cell: last.cell,
      scoreAfter: scoreBoard(game.board, mode).round,
      ts: new Date().toISOString(),
    });
  }

  return { moves, trueScore: scoreBoard(game.board, mode).round };
}
