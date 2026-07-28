/**
 * AS400 datastream reporting. Fires once, when a player finishes their round
 * with the last card.
 *
 * The endpoint is used exactly as supplied and is not rewritten:
 *   https://www.centriko.com/charity/datastream?<RECORD>
 *
 * RECORD mirrors the supplied sample, which decoded as:
 *
 *   TOURC 33267 CHARITYTEST 1111111111 <18 x 2-char hand ID> <score><cards>
 *   ^pfx  ^tour ^charity    ^player
 *
 * Every segment below is a named constant or argument, so correcting a width
 * or order is a one-line change here and nowhere else.
 *
 * NOTE ON DELIVERY: a browser cannot read the response of a cross-origin GET
 * to another domain unless that domain sends CORS headers. The request is
 * still sent (mode: "no-cors"), but success cannot be confirmed from the page.
 * Every record is therefore also kept locally so nothing is lost, and
 * scripts/as400_report.py can deliver them server-side where CORS does not
 * apply. That script is the reliable path; the browser send is best-effort.
 */

import { type BoardScore, rankOf } from "../engine/index.js";

/** Supplied verbatim — not parsed, not rebuilt. */
export const AS400_URL = "https://www.centriko.com/charity/datastream";

export const RECORD_PREFIX = "TOURC";
export const RECORD_LENGTH = 192;
const HOLES = 18;
const BOARD_CARDS = 36;
/** Blank when a hand never completed; the sample shows a 2-char slot per hole. */
const EMPTY_HAND_ID = "  ";

const PENDING_KEY = "pokerst8ts.as400Pending.v1";

export interface RoundRecord {
  /** Tournament number, e.g. "33267". */
  tournament: string;
  /** Charity / event code, e.g. "CHARITYTEST". */
  charity: string;
  /** Player identifier as issued by the AS400. */
  playerId: string;
  score: BoardScore;
  /** Every card on the finished board, in hole order. */
  cards: readonly number[];
}

/** A=1, T=10, J=11, Q=12, K=13 — one character per card, as in the sample. */
const RANK_CHARS = "0A23456789TJQK";
export function rankChar(cardId: number): string {
  return RANK_CHARS[rankOf(cardId)] ?? "0";
}

/** Right-pad (or truncate) to an exact width so field positions never shift. */
function fixed(value: string, width: number): string {
  return value.length >= width ? value.slice(0, width) : value.padEnd(width, " ");
}

/**
 * Build the fixed-width record for a finished round. Padded to RECORD_LENGTH
 * so the AS400 always receives the same number of characters.
 */
export function buildRecord(r: RoundRecord): string {
  const handIds = Array.from({ length: HOLES }, (_, i) => {
    const hand = r.score.hands[i];
    return hand && hand.complete ? fixed(hand.handID, 2) : EMPTY_HAND_ID;
  }).join("");

  // Score is signed: a PokerStr8ts round can go negative.
  const score = (r.score.round < 0 ? "-" : "+") + String(Math.abs(r.score.round)).padStart(4, "0");
  const cards = fixed(r.cards.map(rankChar).join(""), BOARD_CARDS);

  const record =
    RECORD_PREFIX + r.tournament + r.charity + r.playerId + handIds + score + cards;
  return fixed(record, RECORD_LENGTH);
}

/** The exact URL a record is sent to. */
export function recordUrl(record: string): string {
  return `${AS400_URL}?${record.trimEnd()}`;
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

/**
 * Send one finished round to the AS400. Always keeps a local copy: the browser
 * cannot confirm a no-cors delivery, so the copy is the only proof the round
 * was recorded at all.
 */
export async function reportRound(r: RoundRecord): Promise<string> {
  const record = buildRecord(r);
  writePending([...readPending(), record]);
  try {
    await fetch(recordUrl(record), { method: "GET", mode: "no-cors", keepalive: true });
  } catch {
    /* offline — the local copy is what scripts/as400_report.py will send */
  }
  return record;
}
