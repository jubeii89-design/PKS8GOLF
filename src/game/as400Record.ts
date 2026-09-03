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
 * UNRESOLVED, and both are configuration rather than guesses:
 *
 * - Which mode's score belongs here. Measured over 400 rounds, Golf scores
 *   88-103 and is never negative, while PokerStr8ts ranges -62 to +109 and is
 *   negative in a third of rounds. The supplied sample read "097", which sits
 *   mid-range for Golf, and the field description talks in bogeys — so this
 *   field may well want strokes, not points. Set AS400_SCORE_MODE on the relay.
 * - How to write a negative, if points are what it wants. See
 *   `NegativeConvention` and AS400_NEGATIVE.
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
  /** How to write a negative round; see NegativeConvention. */
  negatives?: NegativeConvention;
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
 * How a negative round is written into a field with no room for a sign.
 *
 * Which of these the AS400 wants is not yet confirmed, so it is configuration
 * rather than a guess baked into the code.
 *
 * - "abs"       magnitude only. WRONG for a negative round — the mainframe
 *               reads -18 as +18 — but it is what the field did before this
 *               was configurable, so it stays the default until someone says
 *               otherwise. The relay logs loudly every time it is used on a
 *               negative score.
 * - "minus"     a leading minus, e.g. "-18". Only fits down to -99.
 * - "overpunch" zoned decimal, the usual AS/400 signed-numeric convention:
 *               the sign rides on the last digit, so -18 becomes "01Q".
 */
export type NegativeConvention = "abs" | "minus" | "overpunch";

/** Zoned-decimal negatives: the final digit carries the sign. */
const OVERPUNCH_NEGATIVE = "}JKLMNOPQR";

/**
 * The score, as three characters.
 *
 * Isolated here because both the browser and the server build records, and a
 * disagreement between them would put one number on the leaderboard and a
 * different one on the mainframe.
 */
export function encodeScore(round: number, convention: NegativeConvention = "abs"): string {
  const magnitude = String(Math.abs(round)).padStart(3, "0").slice(-3);
  if (round >= 0) return magnitude;

  switch (convention) {
    case "minus":
      // "-18". A score of -100 or worse cannot be written this way; send the
      // magnitude rather than a truncated number that means something else.
      return Math.abs(round) <= 99 ? `-${String(Math.abs(round)).padStart(2, "0")}` : magnitude;
    case "overpunch": {
      const last = Number(magnitude[magnitude.length - 1]);
      return magnitude.slice(0, 2) + OVERPUNCH_NEGATIVE[last];
    }
    default:
      return magnitude; // "abs" — known wrong, logged by the caller
  }
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

  const record =
    TOUR_PREFIX + day + qtrHour + playerId + pin + handIds +
    encodeScore(r.score.round, r.negatives ?? "abs") + topCards;
  return fixed(record, RECORD_LENGTH);
}
