/**
 * Tournament board UI: the full-screen standings signboard and the player ID
 * + PIN join modal. Player names come from the backend and are rendered as
 * textContent (never innerHTML) since they are untrusted display text.
 */

import type { LeaderboardRow } from "../game/tournamentService.js";
import { isValidPlayerId, isValidPin } from "../game/as400.js";
import { leaderboardSignSVG } from "./leaderboardSign.js";

const medal = (rank: number) => (rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : String(rank));

/** Rows the wooden signboard shows per page. */
export const TABLE_PAGE_SIZE = 20;

/** Page holding the player, so they always land on their own page. */
export function pageOfPlayer(rows: LeaderboardRow[], pageSize: number): number {
  const i = rows.findIndex((r) => r.isYou);
  return i < 0 ? 0 : Math.floor(i / pageSize);
}

/** Render the standings table into a container element. */
function renderBoard(container: HTMLElement, rows: LeaderboardRow[]): void {
  container.replaceChildren();
  if (rows.length === 0) {
    const empty = document.createElement("p");
    empty.className = "lb-empty";
    empty.textContent = "No scores in yet.";
    container.appendChild(empty);
    return;
  }
  const table = document.createElement("table");
  table.className = "lb-table";
  const head = document.createElement("tr");
  head.innerHTML = `<th>#</th><th>Player</th><th>Points</th>`;
  table.appendChild(head);
  for (const r of rows) {
    const tr = document.createElement("tr");
    if (r.isYou) tr.className = "lb-hi";
    const rankTd = document.createElement("td");
    rankTd.className = "lb-rank";
    rankTd.textContent = medal(r.rank);
    const nameTd = document.createElement("td");
    nameTd.className = "lb-name";
    nameTd.textContent = r.playerName; // untrusted → textContent
    const scoreTd = document.createElement("td");
    scoreTd.className = "lb-score";
    scoreTd.textContent = String(r.score);
    tr.append(rankTd, nameTd, scoreTd);
    table.appendChild(tr);
  }
  container.appendChild(table);
}

export interface TournamentBoardOpts {
  rows: LeaderboardRow[];
  /** Shown under the title, e.g. "3rd of 24". */
  subtitle?: string;
  /** Warning shown when the round score has not reached the server yet. */
  warning?: string;
  /** True when the rows are mock data and must not be read as authoritative. */
  mock?: boolean;
  /**
   * Fetches the current standings. When given, the board re-reads them on a
   * timer so a player watching it sees the field fill in behind them rather
   * than a snapshot frozen at the moment they finished.
   */
  refresh?: () => Promise<LeaderboardRow[]>;
  /** How often to re-read. Long enough to be cheap, short enough to feel live. */
  refreshMs?: number;
  onBack: () => void;
}

/** Default poll interval: a hundred players finishing over an hour is slow news. */
export const BOARD_REFRESH_MS = 10_000;

/**
 * Full-screen tournament standings.
 *
 * Drawn rather than skinned. The committed leaderboard.jpg is a *golf* board:
 * it is titled GOLF LEADERBOARD, has columns this tournament has no data for
 * (ID, MATCHES, WINRATE, REGION) that would sit permanently blank, and its ten
 * pre-printed rows read as broken when eight of them are empty. Its printed
 * row numbers also drift out of line with the rows positioned onto them,
 * because the percentages were measured against that exact image.
 *
 * A board that draws its own rows has none of those problems: it says what
 * this event is, shows only columns it can fill, and fits whatever size the
 * field actually is.
 */
export function renderTournamentBoard(opts: TournamentBoardOpts): HTMLElement {
  const screen = document.createElement("div");
  screen.className = "screen leaderboard-screen";

  // Rows are replaced in place by the refresh below, so everything downstream
  // reads through this rather than closing over the initial array.
  let rows = opts.rows;

  const pageSize = TABLE_PAGE_SIZE;
  let pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  let page = pageOfPlayer(rows, pageSize);

  const back = document.createElement("button");
  back.className = "mode-btn primary lb-back";
  back.innerHTML = `<span class="mode-label">Done</span>`;
  back.addEventListener("click", opts.onBack);

  const notes = () => {
    const frag = document.createDocumentFragment();
    if (opts.subtitle) {
      const sub = document.createElement("p");
      sub.className = "lb-subtitle";
      sub.textContent = opts.subtitle;
      frag.appendChild(sub);
    }
    if (opts.warning) {
      const warn = document.createElement("p");
      warn.className = "lb-warning";
      warn.textContent = opts.warning;
      frag.appendChild(warn);
    }
    if (opts.mock) {
      const note = document.createElement("p");
      note.className = "lb-mock";
      note.textContent = "DEMO DATA — not a real tournament field";
      frag.appendChild(note);
    }
    return frag;
  };

  // Prev/next arrows, only when the field does not fit on one page.
  const pager = document.createElement("div");
  pager.className = "lb-pager";
  const prev = document.createElement("button");
  prev.className = "lb-arrow";
  prev.textContent = "‹";
  prev.setAttribute("aria-label", "previous page");
  const next = document.createElement("button");
  next.className = "lb-arrow";
  next.textContent = "›";
  next.setAttribute("aria-label", "next page");
  const pageLabel = document.createElement("span");
  pageLabel.className = "lb-page-label";
  pager.append(prev, pageLabel, next);

  const draw = (into: HTMLElement, render: (el: HTMLElement, rows: LeaderboardRow[]) => void) => {
    render(into, rows.slice(page * pageSize, (page + 1) * pageSize));
    pageLabel.textContent = `Page ${page + 1} of ${pageCount}`;
    prev.disabled = page === 0;
    next.disabled = page >= pageCount - 1;
  };

  // Set by mountPager so the refresh below can redraw whichever board (skinned
  // or drawn) actually got mounted.
  let redraw: () => void = () => {};

  const mountPager = (parent: HTMLElement, into: HTMLElement, render: (el: HTMLElement, rows: LeaderboardRow[]) => void) => {
    redraw = () => draw(into, render);
    draw(into, render);
    if (pageCount > 1) {
      prev.addEventListener("click", () => {
        if (page > 0) { page--; draw(into, render); }
      });
      next.addEventListener("click", () => {
        if (page < pageCount - 1) { page++; draw(into, render); }
      });
      parent.appendChild(pager);
    }
  };

  /**
   * Re-read the standings while the board is on screen.
   *
   * The player's own page is held rather than recomputed, so the board does not
   * jump under them as other people finish. Polling stops when the board is
   * removed, so leaving the screen ends it.
   */
  function startRefreshing(): void {
    if (!opts.refresh) return;
    const every = opts.refreshMs ?? BOARD_REFRESH_MS;
    const timer = setInterval(async () => {
      if (!screen.isConnected) {
        clearInterval(timer);
        return;
      }
      try {
        const next = await opts.refresh!();
        if (next.length === 0) return; // a blip is not news; keep what we have
        rows = next;
        pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
        page = Math.min(page, pageCount - 1);
        redraw();
        setCount();
      } catch {
        /* the next tick can try again */
      }
    }, every);
  }

  const signboard = document.createElement("div");
  signboard.className = "lb-signboard";

  const signSvg = document.createElement("div");
  signSvg.className = "lb-sign-svg";
  signSvg.innerHTML = leaderboardSignSVG();
  signboard.appendChild(signSvg);

  const panel = document.createElement("div");
  panel.className = "lb-panel";

  const title = document.createElement("h2");
  title.className = "lb-title";
  title.textContent = "Tournament Standings";
  panel.appendChild(title);

  const count = document.createElement("p");
  count.className = "lb-count";
  const setCount = () => {
    count.textContent =
      rows.length === 0
        ? "No rounds finished yet"
        : `${rows.length} ${rows.length === 1 ? "player has" : "players have"} finished`;
  };
  setCount();
  panel.appendChild(count);
  panel.appendChild(notes());

  const boardBox = document.createElement("div");
  boardBox.className = "lb-board";
  panel.appendChild(boardBox);

  mountPager(panel, boardBox, renderBoard);
  panel.appendChild(back);
  signboard.appendChild(panel);
  screen.appendChild(signboard);
  startRefreshing();
  return screen;
}

export interface PlayerCredentials {
  playerId: string;
  pin: string;
}

/**
 * Tournament entry: asks for the player's ID and PIN. Resolves with both, or
 * null if they back out. Start stays disabled until both fields are valid.
 */
export function promptForPlayerCredentials(): Promise<PlayerCredentials | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "overlay";
    const panel = document.createElement("div");
    // name-prompt carries the shared input styling; code-prompt is the hook.
    panel.className = "end-panel name-prompt code-prompt";

    const h = document.createElement("h2");
    h.textContent = "Tournament";
    const p = document.createElement("p");
    p.textContent = "Enter your player ID and PIN:";

    const idInput = document.createElement("input");
    idInput.className = "name-input";
    idInput.autocomplete = "off";
    idInput.maxLength = 15;
    idInput.placeholder = "Player ID";

    const pinInput = document.createElement("input");
    pinInput.className = "name-input";
    pinInput.inputMode = "numeric";
    pinInput.autocomplete = "off";
    pinInput.maxLength = 6;
    pinInput.placeholder = "6-digit PIN";

    const row = document.createElement("div");
    row.className = "name-actions";
    const start = document.createElement("button");
    start.className = "mode-btn primary";
    start.innerHTML = `<span class="mode-label">Start</span>`;
    const cancel = document.createElement("button");
    cancel.className = "mode-btn";
    cancel.innerHTML = `<span class="mode-label">Cancel</span>`;
    row.append(start, cancel);

    // PIN is digits only; Start unlocks once both fields validate.
    const sync = () => {
      pinInput.value = pinInput.value.replace(/\D/g, "");
      start.disabled = !isValidPlayerId(idInput.value) || !isValidPin(pinInput.value);
    };
    idInput.addEventListener("input", sync);
    pinInput.addEventListener("input", sync);
    sync();

    const finish = (value: PlayerCredentials | null) => {
      overlay.remove();
      resolve(value);
    };
    start.addEventListener("click", () => {
      if (!start.disabled) finish({ playerId: idInput.value.trim(), pin: pinInput.value.trim() });
    });
    cancel.addEventListener("click", () => finish(null));
    idInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") start.click();
    });
    pinInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") start.click();
    });

    // The player who has not signed up yet ends up here; give them the way out.
    const help = document.createElement("a");
    help.className = "signup-link";
    help.href = "../signup/";
    help.textContent = "Don't have a Player ID? Sign up";

    panel.append(h, p, idInput, pinInput, row, help);
    overlay.appendChild(panel);
    document.getElementById("app")!.appendChild(overlay);
    idInput.focus();
  });
}
