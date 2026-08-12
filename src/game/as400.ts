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

import { type BoardScore, rankOf } from "../engine/index.js";
import type { HandCompletion } from "./gameState.js";
import { hasRelay, relayEndpoint } from "./relay.js";

/** Supplied verbatim — not parsed, not rebuilt. */
export const AS400_URL = "https://www.centriko.com/pgolfe/TNPKCGI1.pgm";
export const QUERY_PARAM = "HDATASTREAM";

export const TOUR_PREFIX = "TOURT";
export const RECORD_LENGTH = 106;
const HOLES = 18;
/** Blank when a hole's data isn't available — one 2-char slot per hole. */
const EMPTY_SLOT = "  ";

const PENDING_KEY = "pokerst8ts.as400Pending.v1";

export interface RoundRecord {
  /** Up to 15 chars, e.g. "GORDONSTITT0001". */
  playerId: string;
  /** Exactly 6 digits. */
  pin: string;
  score: BoardScore;
  handCompletions: readonly HandCompletion[];
}

/** A=1, T=10, J=11, Q=12, K=13 — one character per card rank, suit ignored. */
const RANK_CHARS = "0A23456789TJQK";
export function rankChar(cardId: number): string {
  return RANK_CHARS[rankOf(cardId)] ?? "0";
}

/** 15 chars max, letters/digits only (mainframe player ID format). */
export function isValidPlayerId(raw: string): boolean {
  const v = raw.trim();
  return v.length > 0 && v.length <= 15 && /^[A-Za-z0-9]+$/.test(v);
}

/** Exactly 6 digits. */
export function isValidPin(raw: string): boolean {
  return /^\d{6}$/.test(raw.trim());
}

/** Right-pad (or truncate) to an exact width so field positions never shift. */
function fixed(value: string, width: number): string {
  return value.length >= width ? value.slice(0, width) : value.padEnd(width, " ");
}

/** 1-366, the day of the year. */
function julianDayOfYear(d: Date): number {
  const start = new Date(d.getFullYear(), 0, 0);
  return Math.floor((d.getTime() - start.getTime()) / 86_400_000);
}

/** 1-96 — the day split into 15-minute slots. */
function quarterHourOfDay(d: Date): number {
  return Math.floor((d.getHours() * 60 + d.getMinutes()) / 15) + 1;
}

/**
 * Build the fixed-width record for a finished round. Padded/truncated to
 * RECORD_LENGTH so the AS400 always receives the same number of characters.
 */
export function buildRecord(r: RoundRecord, now: Date = new Date()): string {
  const day = String(julianDayOfYear(now)).padStart(3, "0");
  const qtrHour = String(quarterHourOfDay(now)).padStart(2, "0");
  const playerId = fixed(r.playerId.trim(), 15);
  const pin = r.pin.trim().padStart(6, "0").slice(-6);

  const byHole = new Map(r.handCompletions.map((h) => [h.hole, h]));
  const handIds = Array.from({ length: HOLES }, (_, i) => {
    const hand = r.score.hands[i];
    return hand && hand.complete ? fixed(hand.handID, 2) : EMPTY_SLOT;
  }).join("");

  const score = String(Math.abs(r.score.round)).padStart(3, "0").slice(-3);

  const topCards = Array.from({ length: HOLES }, (_, i) => {
    const completion = byHole.get(i + 1);
    if (!completion) return EMPTY_SLOT;
    return completion.topCards.map(rankChar).join("").padEnd(2, " ").slice(0, 2);
  }).join("");

  const record = TOUR_PREFIX + day + qtrHour + playerId + pin + handIds + score + topCards;
  return fixed(record, RECORD_LENGTH);
}

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
  playerName?: string,
): Promise<{ record: string; sent: boolean; confirmed: boolean }> {
  const record = buildRecord(r);
  writePending([...readPending(), record]);

  if (hasRelay()) {
    try {
      const res = await fetch(relayEndpoint("/round"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          playerId: r.playerId.trim(),
          playerName: playerName ?? r.playerId.trim(),
          score: r.score.round,
          record,
        }),
        keepalive: true,
      });
      if (!res.ok) return { record, sent: false, confirmed: false };
      const body = (await res.json()) as { as400Delivered?: boolean };
      // The relay holds the record now, so drop our copy of it.
      clearPending(record);
      return { record, sent: true, confirmed: body.as400Delivered === true };
    } catch {
      return { record, sent: false, confirmed: false }; // offline; local copy stands
    }
  }

  let sent = true;
  try {
    await fetch(recordUrl(record), { method: "GET", mode: "no-cors", keepalive: true });
  } catch {
    sent = false; // offline — the local copy is what scripts/as400_report.py will send
  }
  return { record, sent, confirmed: false };
}
