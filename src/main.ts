/**
 * App entry: intro → solo round → end panel. Framework-free; re-renders the
 * game screen from the player's GameState after each action.
 */

import { type Cell, GameMode, scoreBoard } from "./engine/index.js";
import { GameState } from "./game/gameState.js";
import { Leaderboard, LocalLeaderboardStore, cleanName, todayISO } from "./game/leaderboard.js";
import { HandHistory, LocalHandHistoryStore, type HandHistoryEntry } from "./game/handHistory.js";
import { renderIntro } from "./ui/intro.js";
import { renderBoard } from "./ui/board.js";
import { renderScorecard } from "./ui/scorecard.js";
import { renderLeaderboardScreen, promptForName, promptPlayAgain } from "./ui/leaderboard.js";
import { cardFace, cardLabel } from "./ui/cards.js";
import { mountCourseBackground } from "./ui/courseBackground.js";
import { mountPokerTableBackground } from "./ui/pokerTableBackground.js";
import { mountBackgroundMusic } from "./ui/audio.js";
import { setAssetBase } from "./ui/assetBase.js";
import { initDesignOverrides } from "./ui/designOverrides.js";
import "./ui/styles.css";

setAssetBase("../"); // this entry lives one level under the site root, at /play/

const app = document.getElementById("app")!;
const bg = document.getElementById("bg");
const bgPoker = document.getElementById("bg-poker");
if (bg) mountCourseBackground(bg);
if (bgPoker) mountPokerTableBackground(bgPoker);
mountBackgroundMusic(document.body);
initDesignOverrides();

const leaderboard = new Leaderboard(new LocalLeaderboardStore());
const handHistory = new HandHistory(new LocalHandHistoryStore());

function clear(): void {
  app.replaceChildren();
}

function start(mode: GameMode): void {
  const game = new GameState(mode);
  renderGame(game, mode);
}

function renderGame(game: GameState, mode: GameMode): void {
  clear();
  document.body.dataset.bg = mode === GameMode.GolfMode ? "golf" : "poker";
  const snap = game.snapshot();
  const score = scoreBoard(snap.board, mode);

  const screen = document.createElement("div");
  screen.className = "screen game";

  screen.appendChild(renderScorecard(score, mode));

  const main = document.createElement("div");
  main.className = "play-area";

  // left rail: next card, PASS, cards remaining
  const rail = document.createElement("aside");
  rail.className = "rail";

  const nextWrap = document.createElement("div");
  nextWrap.className = "next-card";
  const nextLabel = document.createElement("span");
  nextLabel.className = "rail-label";
  nextLabel.textContent = "NEXT CARD";
  nextWrap.appendChild(nextLabel);
  if (snap.currentCard !== null) {
    nextWrap.appendChild(cardFace(snap.currentCard));
  }
  rail.appendChild(nextWrap);

  const passBtn = document.createElement("button");
  passBtn.className = "pass-btn";
  passBtn.textContent = "PASS";
  passBtn.disabled = snap.isOver;
  passBtn.addEventListener("click", () => {
    if (!game.isOver) {
      game.pass();
      renderGame(game, mode);
    }
  });
  rail.appendChild(passBtn);

  const remain = document.createElement("div");
  remain.className = "cards-remaining";
  remain.innerHTML = `<span class="rail-label">CARDS REMAINING</span><span class="remain-value">${snap.cardsLeft}</span>`;
  rail.appendChild(remain);

  const board = renderBoard(game, {
    onPlace: (cell: Cell) => {
      game.place(cell);
      renderGame(game, mode);
    },
  });

  main.append(rail, board);
  screen.appendChild(main);
  app.appendChild(screen);

  if (game.isOver) showEndPanel(game, mode);
}

/** Show an overlay panel; call `next()` on the first keypress or click. */
function showOverlay(build: (panel: HTMLElement) => void, next: () => void, wide = false): void {
  const overlay = document.createElement("div");
  overlay.className = "overlay";
  const panel = document.createElement("div");
  panel.className = "end-panel" + (wide ? " wide" : "");
  build(panel);
  overlay.appendChild(panel);
  app.appendChild(overlay);

  const advance = () => {
    document.removeEventListener("keydown", advance);
    overlay.removeEventListener("click", advance);
    overlay.remove();
    next();
  };
  document.addEventListener("keydown", advance);
  overlay.addEventListener("click", advance);
}

/**
 * The single completed hand with the best result, plus its top 2 cards.
 * "Best" means highest points in PokerStr8ts but fewest strokes in Golf,
 * matching the direction already used elsewhere.
 */
function bestHand(
  score: ReturnType<typeof scoreBoard>,
  completions: GameState["handCompletions"],
  mode: GameMode,
): { handName: string; points: number; topCards: number[] } | null {
  const complete = score.hands.filter((h) => h.complete);
  if (complete.length === 0) return null;
  const golf = mode === GameMode.GolfMode;
  const top = complete.reduce((a, b) => ((golf ? b.points < a.points : b.points > a.points) ? b : a));
  const rec = completions.find((c) => c.hole === top.hole);
  return { handName: top.handName, points: top.points, topCards: rec?.topCards ?? [] };
}

// Your own scorecard — the same HOLE/PAR/SCORE grid shown during play —
// centered on screen, plus a best-hand callout.
function showEndPanel(game: GameState, mode: GameMode): void {
  const score = scoreBoard(game.snapshot().board, mode);
  const best = bestHand(score, game.handCompletions, mode);

  showOverlay((panel) => {
    const h2 = document.createElement("h2");
    h2.textContent = "Round complete!";
    panel.appendChild(h2);

    panel.appendChild(renderScorecard(score, mode));

    if (best) {
      const stat = document.createElement("p");
      stat.className = "final-stat";
      const sign = best.points >= 0 ? "+" : "";
      stat.innerHTML = `Best hand: <strong>${best.handName}</strong>${
        best.topCards.length ? ` — ${best.topCards.map(cardLabel).join(" ")}` : ""
      } (${sign}${best.points})`;
      panel.appendChild(stat);
    }

    const hint = document.createElement("p");
    hint.className = "end-hint";
    hint.textContent = "Press any key to continue";
    panel.appendChild(hint);
  }, () => void continueAfterRound(game, mode), true);
}

// Persist the player's top-2-cards-per-hand history, submit their score to the
// persistent leaderboard, then show the leaderboard and ask to play again.
async function continueAfterRound(game: GameState, mode: GameMode): Promise<void> {
  const humanScore = scoreBoard(game.snapshot().board, mode).round;
  let highlight: Parameters<typeof renderLeaderboardScreen>[0]["highlight"];
  let playerName = "You";
  if (await leaderboard.wouldQualify(humanScore, mode)) {
    const board = await leaderboard.top(mode);
    const golf = mode === GameMode.GolfMode;
    const projectedRank = board.filter((e) => (golf ? e.score < humanScore : e.score > humanScore)).length + 1;
    const name = await promptForName(projectedRank);
    if (name !== null) {
      playerName = cleanName(name);
      const entry = { name: playerName, score: humanScore, mode, date: todayISO() };
      const result = await leaderboard.submit(entry);
      if (result.qualified) highlight = entry;
    }
  }

  const date = todayISO();
  const records: HandHistoryEntry[] = game.handCompletions.map((h) => ({
    playerName,
    mode,
    date,
    hole: h.hole,
    topCards: h.topCards,
  }));
  void handHistory.appendMany(records);

  showLeaderboardWith(mode, highlight);
  if (await promptPlayAgain()) showIntro();
}

function showLeaderboardWith(mode: GameMode, highlight: Parameters<typeof renderLeaderboardScreen>[0]["highlight"]): void {
  clear();
  document.body.dataset.bg = "intro";
  app.appendChild(renderLeaderboardScreen({ leaderboard, mode, highlight, onBack: showIntro }));
}

// keyboard: P = pass
document.addEventListener("keydown", (e) => {
  if (e.key.toLowerCase() === "p") {
    const btn = document.querySelector<HTMLButtonElement>(".pass-btn");
    if (btn && !btn.disabled) btn.click();
  }
});

function showIntro(): void {
  clear();
  document.body.dataset.bg = "intro";
  app.appendChild(renderIntro(start, showLeaderboard));
}

function showLeaderboard(mode: GameMode = GameMode.PokerStraightsMode): void {
  clear();
  document.body.dataset.bg = "intro";
  app.appendChild(renderLeaderboardScreen({ leaderboard, mode, onBack: showIntro }));
}

showIntro();
