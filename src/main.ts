/**
 * App entry: intro → solo round → end panel. Framework-free; re-renders the
 * game screen from the player's GameState after each action.
 */

import { type Cell, GameMode, scoreBoard } from "./engine/index.js";
import { GameState } from "./game/gameState.js";
import { renderIntro } from "./ui/intro.js";
import { renderBoard } from "./ui/board.js";
import { renderScorecard } from "./ui/scorecard.js";
import { promptForPlayerCredentials, renderTournamentBoard, type PlayerCredentials } from "./ui/leaderboard.js";
import { flushMoves, recordMove } from "./game/moveLog.js";
import { isValidPlayerId, isValidPin, reportRound } from "./game/as400.js";
import { MockTournamentService, type JoinResult, type LeaderboardRow, type Player } from "./game/tournamentService.js";
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

// Swap for a real HTTP-backed TournamentService once the backend exists —
// nothing below this line changes when you do.
const tournament = new MockTournamentService();

// Retry anything stranded by an earlier connection drop or closed tab.
void flushMoves();

// Last chance to ship buffered moves when the tab goes away mid-round — the
// exact case the audit trail exists for.
window.addEventListener("pagehide", () => void flushMoves());

function clear(): void {
  app.replaceChildren();
}

function start(mode: GameMode): void {
  const game = new GameState(mode);
  renderGame(game, mode);
}

/**
 * A QR code just encodes a URL with these params — the phone's camera app
 * opens it like any link, and this reads them back out on load. Cleared from
 * the address bar immediately so a refresh or share doesn't replay the join.
 */
function credentialsFromUrl(): PlayerCredentials | null {
  const params = new URLSearchParams(window.location.search);
  const playerId = params.get("player") ?? "";
  const pin = params.get("pin") ?? "";
  if (!params.has("player") && !params.has("pin")) return null;
  window.history.replaceState(null, "", window.location.pathname);
  if (!isValidPlayerId(playerId) || !isValidPin(pin)) return null;
  return { playerId, pin };
}

/** Tournament: player ID + PIN → tee-off check → one scored, reported round. */
async function startTournament(prefilled?: PlayerCredentials | null): Promise<void> {
  const creds = prefilled ?? (await promptForPlayerCredentials());
  if (creds === null) return;

  const join = await tournament.join(creds.playerId, creds.pin);
  if (!join.ok) {
    showJoinRejected(join);
    return;
  }
  const mode = GameMode.PokerStraightsMode;
  const game = new GameState(mode);
  logRoundStart(game, join, mode);
  renderGame(game, mode, join);
}

/**
 * Audit trail. The 6 auto-placed cards are logged first so the round can be
 * replayed from an empty board; every later move continues the sequence.
 */
function logRoundStart(game: GameState, player: Player, mode: GameMode): void {
  const scoreAfter = scoreBoard(game.snapshot().board, mode).round;
  game.preplaced.forEach((p, i) => {
    recordMove({
      tournamentId: player.tournamentId,
      playerId: player.playerId,
      seq: i,
      action: "round-start",
      card: p.card,
      cell: p.cell,
      scoreAfter,
      ts: new Date().toISOString(),
    });
  });
}

/** Log the move the player just made, with the score it produced. */
function logLatestMove(game: GameState, player: Player, mode: GameMode): void {
  const last = game.playLog[game.playLog.length - 1];
  if (!last) return;
  recordMove({
    tournamentId: player.tournamentId,
    playerId: player.playerId,
    seq: game.preplaced.length + last.seq,
    action: last.action,
    card: last.card,
    cell: last.cell,
    scoreAfter: scoreBoard(game.snapshot().board, mode).round,
    ts: new Date().toISOString(),
  });
}

/** Rejected at the door — unknown player, wrong PIN, missed tee-off, or no server. */
function showJoinRejected(join: Extract<JoinResult, { ok: false }>): void {
  const reasons = {
    "missed-tee-time": "Your tee-off time has passed, so you can no longer join. See a tournament official.",
    "unknown-player": "That player ID was not recognised. Check it and try again.",
    "wrong-pin": "That PIN does not match the player ID. Check it and try again.",
    offline: "Could not reach the tournament server. Try again in a moment.",
  };
  showOverlay((panel) => {
    const h2 = document.createElement("h2");
    h2.textContent = "Cannot join";
    const p = document.createElement("p");
    p.textContent = reasons[join.reason];
    panel.append(h2, p);

    if (join.teeTime) {
      const tee = document.createElement("p");
      tee.className = "final-stat";
      tee.textContent = `Tee-off was ${new Date(join.teeTime).toLocaleTimeString()}`;
      panel.appendChild(tee);
    }

    const hint = document.createElement("p");
    hint.className = "end-hint";
    hint.textContent = "Press any key to continue";
    panel.appendChild(hint);
  }, showIntro);
}

/** `player` set = tournament round: score is reported, not name-prompted. */
function renderGame(game: GameState, mode: GameMode, player?: Player): void {
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
      if (player) logLatestMove(game, player, mode);
      renderGame(game, mode, player);
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
      if (player) logLatestMove(game, player, mode);
      renderGame(game, mode, player);
    },
  });

  main.append(rail, board);
  screen.appendChild(main);
  app.appendChild(screen);

  if (game.isOver) showEndPanel(game, mode, player);
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
function showEndPanel(game: GameState, mode: GameMode, player?: Player): void {
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
  }, () => {
    if (player) void reportTournamentRound(game, mode, player);
    else showIntro(); // practice: nothing recorded, straight back to the menu
  }, true);
}

/**
 * Tournament round is over: report the score to the AS400 datastream and
 * show the field. Practice rounds never reach here — a practice score is not
 * recorded anywhere.
 */
async function reportTournamentRound(game: GameState, mode: GameMode, player: Player): Promise<void> {
  const score = scoreBoard(game.snapshot().board, mode);
  await flushMoves(); // ship the tail of the audit trail before the score lands

  const { sent } = await reportRound({
    playerId: player.playerId,
    pin: player.pin,
    score,
    handCompletions: game.handCompletions,
  });
  tournament.recordLocalScore(player.tournamentId, player.playerId, player.playerName, score.round);
  const rows = await tournament.leaderboard(player.tournamentId, player.playerId);
  showRoundStandings(score.round, sent, rows);
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]!);
}

/**
 * End of a tournament round: the field on the signboard, with the player's
 * placing and a warning if their score has not reached the server yet.
 */
function showRoundStandings(score: number, sent: boolean, rows: LeaderboardRow[]): void {
  const you = rows.find((r) => r.isYou);
  clear();
  document.body.dataset.bg = "intro";
  app.appendChild(
    renderTournamentBoard({
      rows,
      subtitle: you ? `You finished ${ordinal(you.rank)} of ${rows.length} with ${score}` : `Your round: ${score}`,
      warning: sent
        ? undefined
        : "Your score has not reached the scoring server yet. It is saved on this device and sends automatically — tell a tournament official.",
      mock: tournament.isMock,
      onBack: showIntro,
    }),
  );
}

function showIntro(): void {
  clear();
  document.body.dataset.bg = "intro";
  app.appendChild(renderIntro(start, () => void startTournament()));
}

const qrCreds = credentialsFromUrl();
if (qrCreds) void startTournament(qrCreds);
else showIntro();
