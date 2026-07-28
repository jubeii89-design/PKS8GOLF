/**
 * Tournament scoring: a player identified by a 15-digit code plays one round,
 * and the round score is POSTed to the scoring endpoint (the gateway in front
 * of the AS400).
 *
 * Set the endpoint at build time:  VITE_SCORE_ENDPOINT=https://…/scores
 *
 * A failed post is queued in localStorage and retried on the next load, so a
 * dropped connection never silently loses a tournament score.
 */

import type { GameMode } from "../engine/index.js";

const ENDPOINT = import.meta.env.VITE_SCORE_ENDPOINT ?? "/api/score";
const QUEUE_KEY = "pokerst8ts.pendingScores.v1";

export interface ScoreReport {
  playerCode: string;
  score: number;
  mode: GameMode;
  /** ISO date (YYYY-MM-DD). */
  date: string;
}

/** Exactly 15 digits — the tournament player code. */
export function isValidPlayerCode(raw: string): boolean {
  return /^\d{15}$/.test(raw.trim());
}

function readQueue(): ScoreReport[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return []; // corrupt or unavailable storage — nothing to retry
  }
}

function writeQueue(queue: ScoreReport[]): void {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  } catch {
    /* quota / privacy mode — the post already failed, nothing more to do */
  }
}

async function post(report: ScoreReport): Promise<boolean> {
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(report),
    });
    return res.ok;
  } catch {
    return false; // offline / DNS / CORS
  }
}

/** Send a score. Queues it for retry if the post fails. True = delivered now. */
export async function reportScore(report: ScoreReport): Promise<boolean> {
  if (await post(report)) return true;
  writeQueue([...readQueue(), report]);
  return false;
}

/** Number of scores still waiting to be delivered. */
export function pendingScoreCount(): number {
  return readQueue().length;
}

/** Retry anything left over from an earlier session. Call once at startup. */
export async function flushPendingScores(): Promise<void> {
  const queue = readQueue();
  if (queue.length === 0) return;
  const failed: ScoreReport[] = [];
  for (const report of queue) {
    if (!(await post(report))) failed.push(report);
  }
  writeQueue(failed);
}
