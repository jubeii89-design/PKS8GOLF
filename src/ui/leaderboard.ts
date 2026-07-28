/**
 * Tournament board UI: the full-screen standings signboard and the player-code
 * modal. Player names come from the backend and are rendered as textContent
 * (never innerHTML) since they are untrusted display text.
 */

import type { LeaderboardRow } from "../game/tournamentService.js";
import { isValidPlayerCode } from "../game/tournament.js";
import { leaderboardSignSVG } from "./leaderboardSign.js";
import { designOverride } from "./designOverrides.js";

const medal = (rank: number) => (rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : String(rank));

/**
 * Calibrated to public/assets/leaderboard.jpg specifically (1600×1093,
 * 10 pre-printed row slots numbered 1-10, NAME/SCORES columns) — measured by
 * pixel-analysing the actual image (row centers via white-pixel centroid,
 * column centers via equal 7-way division of the ruled box). A differently
 * laid-out replacement image would need these re-measured.
 */
const LB_SKIN_ASPECT = "1600 / 1093";
const LB_SKIN_ROWS_PCT = [32.2, 37.9, 43.5, 49.2, 54.7, 60.3, 65.5, 71.4, 76.9, 82.5];
const LB_SKIN_NAME_X_PCT = 25;
const LB_SKIN_SCORE_X_PCT = 50;

/** Rows the wooden signboard shows per page. */
export const TABLE_PAGE_SIZE = 20;

/** Page holding the player, so they always land on their own page. */
export function pageOfPlayer(rows: LeaderboardRow[], pageSize: number): number {
  const i = rows.findIndex((r) => r.isYou);
  return i < 0 ? 0 : Math.floor(i / pageSize);
}

/** Render the top rows positioned onto the leaderboard.jpg row/column grid. */
function renderSkinBoard(container: HTMLElement, rows: LeaderboardRow[]): void {
  container.replaceChildren();
  rows.forEach((r, i) => {
    const row = document.createElement("div");
    row.className = "lb-skin-row" + (r.isYou ? " lb-hi" : "");
    row.style.top = `${LB_SKIN_ROWS_PCT[i]}%`;

    const name = document.createElement("span");
    name.className = "lb-skin-name";
    name.style.left = `${LB_SKIN_NAME_X_PCT}%`;
    name.textContent = r.playerName; // untrusted → textContent

    const score = document.createElement("span");
    score.className = "lb-skin-score";
    score.style.left = `${LB_SKIN_SCORE_X_PCT}%`;
    score.textContent = String(r.score);

    row.append(name, score);
    container.appendChild(row);
  });
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
  onBack: () => void;
}

/** Full-screen tournament standings, shown as the wooden signpost. */
export function renderTournamentBoard(opts: TournamentBoardOpts): HTMLElement {
  const screen = document.createElement("div");
  screen.className = "screen leaderboard-screen";
  const bg = designOverride("leaderboard");

  // The board shows as many rows as it has slots: the skin image has a fixed
  // number of printed rows, the drawn signboard is free to show more.
  const pageSize = bg ? LB_SKIN_ROWS_PCT.length : TABLE_PAGE_SIZE;
  const pageCount = Math.max(1, Math.ceil(opts.rows.length / pageSize));
  let page = pageOfPlayer(opts.rows, pageSize);

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
    render(into, opts.rows.slice(page * pageSize, (page + 1) * pageSize));
    pageLabel.textContent = `Page ${page + 1} of ${pageCount}`;
    prev.disabled = page === 0;
    next.disabled = page >= pageCount - 1;
  };

  const mountPager = (parent: HTMLElement, into: HTMLElement, render: (el: HTMLElement, rows: LeaderboardRow[]) => void) => {
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

  if (bg) {
    // Custom overlay: real name/score data positioned onto the uploaded
    // image's own row/column grid (see LB_SKIN_* above).
    const wrap = document.createElement("div");
    wrap.className = "lb-skin-wrap";

    const board = document.createElement("div");
    board.className = "lb-skin-board";
    board.style.aspectRatio = LB_SKIN_ASPECT;
    board.style.backgroundImage = `url("${bg}")`;
    wrap.appendChild(board);

    mountPager(wrap, board, renderSkinBoard);
    wrap.appendChild(notes());
    back.classList.add("lb-skin-back");
    wrap.appendChild(back);
    screen.appendChild(wrap);
    return screen;
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
  title.textContent = "Round Standings";
  panel.appendChild(title);
  panel.appendChild(notes());

  const boardBox = document.createElement("div");
  boardBox.className = "lb-board";
  panel.appendChild(boardBox);

  mountPager(panel, boardBox, renderBoard);
  panel.appendChild(back);
  signboard.appendChild(panel);
  screen.appendChild(signboard);
  return screen;
}

/**
 * Tournament entry: asks for the player's 15-digit code. Resolves with the
 * code, or null if they back out. Start stays disabled until 15 digits are in.
 */
export function promptForPlayerCode(): Promise<string | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "overlay";
    const panel = document.createElement("div");
    // name-prompt carries the shared input styling; code-prompt is the hook.
    panel.className = "end-panel name-prompt code-prompt";

    const h = document.createElement("h2");
    h.textContent = "Tournament";
    const p = document.createElement("p");
    p.textContent = "Enter your 15-digit player code:";

    const input = document.createElement("input");
    input.className = "name-input";
    input.inputMode = "numeric";
    input.autocomplete = "off";
    input.maxLength = 15;
    input.placeholder = "···············";

    const count = document.createElement("div");
    count.className = "code-count";

    const row = document.createElement("div");
    row.className = "name-actions";
    const start = document.createElement("button");
    start.className = "mode-btn primary";
    start.innerHTML = `<span class="mode-label">Start</span>`;
    const cancel = document.createElement("button");
    cancel.className = "mode-btn";
    cancel.innerHTML = `<span class="mode-label">Cancel</span>`;
    row.append(start, cancel);

    // Digits only; Start unlocks at exactly 15.
    const sync = () => {
      input.value = input.value.replace(/\D/g, "");
      count.textContent = `${input.value.length} / 15`;
      start.disabled = !isValidPlayerCode(input.value);
    };
    input.addEventListener("input", sync);
    sync();

    const finish = (value: string | null) => {
      overlay.remove();
      resolve(value);
    };
    start.addEventListener("click", () => {
      if (!start.disabled) finish(input.value);
    });
    cancel.addEventListener("click", () => finish(null));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") start.click();
    });

    panel.append(h, p, input, count, row);
    overlay.appendChild(panel);
    document.getElementById("app")!.appendChild(overlay);
    input.focus();
  });
}
