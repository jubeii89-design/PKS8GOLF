/**
 * Per-move audit trail for tournament rounds.
 *
 * Every card a player places (and every pass) is streamed to the scoring
 * service so a disputed round can be reconstructed move by move. `GameState`
 * already records the moves — this only ships them.
 *
 * Moves are buffered and flushed on a timer rather than posted one at a time:
 * ~41 moves x 100 players is a lot of requests for data nobody reads until
 * something goes wrong. Buffering is NOT batch-at-end, though — a browser that
 * dies mid-round is exactly the case the audit trail exists for, so the buffer
 * is mirrored to localStorage and flushed again on next load.
 *
 * Endpoint: the relay's /moves when VITE_RELAY_URL is set, otherwise
 * VITE_MOVES_ENDPOINT (defaults to /api/moves). Without either, there is
 * nowhere for the trail to land — moves stay buffered on the device rather
 * than being discarded, but they will not reach anyone who can review them.
 */

import type { Cell } from "../engine/index.js";
import { authHeaders, hasRelay, relayEndpoint } from "./relay.js";

const ENDPOINT = hasRelay() ? relayEndpoint("/moves") : (import.meta.env.VITE_MOVES_ENDPOINT ?? "/api/moves");
const BUFFER_KEY = "pokerst8ts.moveBuffer.v1";
const FLUSH_MS = 10_000;
/** Flush early once this many moves are waiting, so bursts do not sit around. */
const FLUSH_AT = 10;

export interface MoveEvent {
  tournamentId: string;
  playerId: string;
  /** 0-based move number within the round. */
  seq: number;
  action: "place" | "pass" | "round-start";
  card: number | null;
  cell: Cell | null;
  /** Round score after this move — lets a reviewer see points as they land. */
  scoreAfter: number;
  /** Client clock, ISO. Trust the server's receipt time over this. */
  ts: string;
}

function read(): MoveEvent[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(BUFFER_KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function write(events: MoveEvent[]): void {
  try {
    localStorage.setItem(BUFFER_KEY, JSON.stringify(events));
  } catch {
    /* private mode / quota — in-flight moves stay in memory only */
  }
}

async function post(events: MoveEvent[]): Promise<boolean> {
  if (events.length === 0) return true;
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ moves: events }),
      // Survives the tab closing mid-flush.
      keepalive: true,
    });
    return res.ok;
  } catch {
    return false;
  }
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Queue one move. Flushes automatically; callers do not await. */
export function recordMove(event: MoveEvent): void {
  const buffered = [...read(), event];
  write(buffered);
  if (buffered.length >= FLUSH_AT) void flushMoves();
  else startTimer();
}

function startTimer(): void {
  if (timer !== null) return;
  timer = setInterval(() => void flushMoves(), FLUSH_MS);
}

function stopTimer(): void {
  if (timer === null) return;
  clearInterval(timer);
  timer = null;
}

/**
 * Send everything buffered. Anything that fails stays buffered for the next
 * attempt — a move is never dropped just because the network blinked.
 */
export async function flushMoves(): Promise<boolean> {
  const pending = read();
  if (pending.length === 0) {
    stopTimer();
    return true;
  }
  if (!(await post(pending))) return false;

  // Only clear what we actually sent; moves added mid-flight survive.
  const remaining = read().slice(pending.length);
  write(remaining);
  if (remaining.length === 0) stopTimer();
  return true;
}

/** Moves still waiting to reach the server. */
export function pendingMoveCount(): number {
  return read().length;
}

/**
 * The moves that have not been confirmed delivered.
 *
 * Sent alongside the finished round: the server derives the score by replaying
 * the move log, so a batch still sitting in this buffer would make the round
 * look shorter than it was and score it too low.
 */
export function pendingMoves(): MoveEvent[] {
  return read();
}
