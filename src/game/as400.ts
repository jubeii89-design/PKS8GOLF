/**
 * AS400 datastream reporting. Fires once, when a player finishes their round
 * with the last card.
 *
 * Real record layout, decoded from a sample against its field description
 * (see PR discussion — two probable transcription slips are called out below):
 *
 *   TOURT ddd qq PPPPPPPPPPPPPPP NNNNNN HHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHH SSS TTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTT
 *   |5  | |3||2| |15 playerId  | |6pin| |36: 18 holes x 2-char hand ID     | |3| |36: 18 holes x 2 top-card ranks   |
 *
 * - TOURT: literal 5-char prefix. The sample had "TOUT" (4 chars) — assumed a
 *   dropped "R" against the written spec; correct if the real prefix differs.
 * - ddd/qq: julian day-of-year (1-366) + quarter-hour-of-day (1-96), computed
 *   at send time, not supplied by the caller.
 * - pin: 6 digits, zero-padded. The sample showed 7 digits after the player
 *   ID; assumed a transcription slip since the spec states 6.
 * - score: plain 3-digit, zero-padded, UNSIGNED — no sign convention was
 *   given, so a negative round (possible in PokerStr8ts) currently sends its
 *   absolute value. Flag if there's a real convention for this.
 * - top-card block: the 2 highest-ranked cards per hole (suit ignored), one
 *   rank character each — this is GameState.handCompletions[].topCards,
 *   already computed for the in-game "best hand" display.
 *
 * Endpoint used exactly as supplied, not rewritten:
 *   https://www.centriko.com/pgolfe/TNPKCGI1.pgm?HDATASTREAM=<106-char record>
 *
 * NOTE ON DELIVERY: a browser cannot read the response of a cross-origin GET
 * to another domain unless that domain sends CORS headers. The request is
 * still sent (mode: "no-cors"), but success cannot be confirmed from the page.
 * Every record is therefore also kept locally so nothing is lost, and
 * scripts/as400_report.py can deliver them server-side where CORS does not
 * apply. That script is the reliable path; the browser send is best-effort.
 */

import type { BoardScore } from "../engine/index.js";
import type { HandCompletion } from "./gameState.js";
import { authHeaders, hasRelay, relayEndpoint } from "./relay.js";
import { buildRecord, type RoundRecord } from "./as400Record.js";
import { pendingMoves } from "./moveLog.js";

// The record format lives in as400Record.ts because the server builds these
// too; re-exported here so callers have one place to import from.
export {
  buildRecord,
  encodeScore,
  isValidPin,
  isValidPlayerId,
  rankChar,
  RECORD_LENGTH,
  TOUR_PREFIX,
} from "./as400Record.js";
export type { RoundRecord } from "./as400Record.js";

/** Supplied verbatim — not parsed, not rebuilt. */
export const AS400_URL = "https://www.centriko.com/pgolfe/TNPKCGI1.pgm";
export const QUERY_PARAM = "HDATASTREAM";

const PENDING_KEY = "pokerst8ts.as400Pending.v1";

/** The exact URL a record is sent to. */
export function recordUrl(record: string): string {
  return `${AS400_URL}?${QUERY_PARAM}=${record.trimEnd()}`;
}

// --- local keep, so a record is never lost and can be drained server-side ---

function readPending(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(PENDING_KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writePending(records: string[]): void {
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify(records));
  } catch {
    /* private mode / quota — the browser send above still went out */
  }
}

/** Records held locally for reconciliation or server-side delivery. */
export function pendingRecords(): string[] {
  return readPending();
}

/** Drop one record once something durable has taken responsibility for it. */
function clearPending(record: string): void {
  writePending(readPending().filter((r) => r !== record));
}

/**
 * Send one finished round.
 *
 * Two paths, never both, so a record can never be delivered twice:
 *
 * - With a relay configured, the record goes to the relay, which forwards it
 *   to the AS400 server-side. That path can read the response, so `confirmed`
 *   means the AS400 actually accepted the record — not merely that a request
 *   was fired.
 * - Standalone, the browser sends it directly. Cross-origin rules hide the
 *   response, so the best that can be said is that the request did not throw.
 *   `confirmed` is false in this case even on success, because nothing was
 *   confirmed.
 *
 * Either way a local copy is kept first, so a failure anywhere downstream
 * leaves the round recoverable via scripts/as400_report.py.
 */
export async function reportRound(
  r: RoundRecord,
): Promise<{ record: string | null; sent: boolean; confirmed: boolean; score: number | null }> {
  if (hasRelay()) {
    // Nothing here is trusted by the server: it replays the round from the
    // deck it issued and derives the score itself. The figure below is sent
    // only so a disagreement can be spotted and logged, and no record is
    // built at all — the server assembles the one the AS400 receives, so
    // what the mainframe is told and what the board shows cannot diverge.
    try {
      const res = await fetch(relayEndpoint("/round"), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        // Anything still buffered goes with the round: the server scores by
        // replaying the moves, so a missing batch would score it too low.
        body: JSON.stringify({ score: r.score.round, moves: pendingMoves() }),
        keepalive: true,
      });
      if (!res.ok) return { record: null, sent: false, confirmed: false, score: null };
      const body = (await res.json()) as { as400Delivered?: boolean; score?: number };
      return {
        record: null,
        sent: true,
        confirmed: body.as400Delivered === true,
        score: typeof body.score === "number" ? body.score : null,
      };
    } catch {
      return { record: null, sent: false, confirmed: false, score: null };
    }
  }

  // Standalone: no server to verify anything, so the browser builds and sends
  // the record itself and keeps a local copy, since it cannot read the reply.
  const record = buildRecord(r);
  writePending([...readPending(), record]);
  let sent = true;
  try {
    await fetch(recordUrl(record), { method: "GET", mode: "no-cors", keepalive: true });
  } catch {
    sent = false; // offline — the local copy is what scripts/as400_report.py will send
  }
  return { record, sent, confirmed: false, score: r.score.round };
}
