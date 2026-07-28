/**
 * End-of-round tournament standings: every player's round score, ranked, with
 * the current player highlighted. Fetched once when a round finishes — there
 * is no live panel during play, so nothing here polls.
 */

import type { LeaderboardRow } from "../game/tournamentService.js";

const medal = (rank: number) => (rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : "");

export function renderStandings(rows: LeaderboardRow[], opts: { mock?: boolean } = {}): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "standings final";

  const title = document.createElement("div");
  title.className = "standings-title";
  title.textContent = `Round standings — ${rows.length} player${rows.length === 1 ? "" : "s"}`;
  wrap.appendChild(title);

  const list = document.createElement("ol");
  list.className = "standings-list";
  for (const r of rows) {
    const li = document.createElement("li");
    li.className = "standing-row" + (r.isYou ? " you" : "");
    // Player names come from the backend — set as text, never innerHTML.
    const rank = document.createElement("span");
    rank.className = "rank";
    rank.textContent = medal(r.rank) || String(r.rank);
    const who = document.createElement("span");
    who.className = "who";
    who.textContent = r.playerName;
    const pts = document.createElement("span");
    pts.className = "pts";
    pts.textContent = String(r.score);
    li.append(rank, who, pts);
    list.appendChild(li);
  }
  wrap.appendChild(list);

  const note = document.createElement("div");
  note.className = "standings-note";
  note.textContent = opts.mock
    ? "DEMO DATA — not a real tournament field"
    : "most points wins";
  wrap.appendChild(note);

  return wrap;
}
