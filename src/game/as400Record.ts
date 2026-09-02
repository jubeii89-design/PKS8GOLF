/**
 * The AS400 record format, and nothing else.
 *
 * Kept apart from the transport in as400.ts because the server builds these
 * too: it replays a round and derives the record itself rather than trusting
 * one the browser assembled. Both sides must produce byte-identical output, so
 * the format lives here once and is compiled for Node as well as bundled for
 * the browser. There is deliberately nothing browser-specific in this file.
 *
 * Layout, decoded from the supplied sample against its field description:
 *
 *   TOURT ddd qq PPPPPPPPPPPPPPP NNNNNN HHHH...HHHH SSS TTTT...TTTT
 *   |5  | |3||2| |15 playerId  | |6pin| |36: 18x2 | |3| |36: 18x2  |
 *
 * - TOURT: literal 5-char prefix. The sample read "TOUT" (4 chars); assumed a
 *   dropped "R" against the written spec. Correct here if the real one differs.
 * - ddd/qq: julian day-of-year (1-366) and quarter-hour-of-day (1-96),
 *   computed when the record is built.
 * - pin: 6 digits, zero-padded. The sample showed 7 after the player ID;
 *   assumed a transcription slip, since the spec states 6.
 * - hand IDs: two characters per hole, blank for a hole that never completed.
 * - score: 3 digits, zero-padded.
 * - top cards: the 2 highest-ranked cards per hole, one rank character each.
 *
 * UNRESOLVED — the score field is 3 characters with no room for a sign, and no
 * convention was given for a negative round (which PokerStr8ts can produce).
 * `-18` currently goes out as "018", which the mainframe will read as +18. See
 * `encodeScore` below; when the real convention is known, that one function is
 * the only thing that changes.
 */

import { type BoardScore, rankOf } from "../engine/index.js";
import type { HandCompletion } from "./gameState.js";

export const TOUR_PREFIX = "TOURT";
export const RECORD_LENGTH = 106;
export const HOLES = 18;
/** Blank when a hole's data isn't available — one 2-char slot per hole. */
const EMPTY_SLOT = "  ";

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
 * The score, as three characters.
 *
 * The sign is the open question. Until the AS400's convention is confirmed a
 * negative round sends its magnitude, which is wrong for any player who
 * finishes under — it is isolated here so the fix is one function, applied
 * everywhere at once, rather than a hunt through the codebase.
 */
export function encodeScore(round: number): string {
  return String(Math.abs(round)).padStart(3, "0").slice(-3);
}

/**
 * Build the fixed-width record for a finished round. Padded or truncated to
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

  const topCards = Array.from({ length: HOLES }, (_, i) => {
    const completion = byHole.get(i + 1);
    if (!completion) return EMPTY_SLOT;
    return completion.topCards.map(rankChar).join("").padEnd(2, " ").slice(0, 2);
  }).join("");

  const record = TOUR_PREFIX + day + qtrHour + playerId + pin + handIds + encodeScore(r.score.round) + topCards;
  return fixed(record, RECORD_LENGTH);
}
