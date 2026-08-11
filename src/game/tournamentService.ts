/**
 * Tournament backend seam.
 *
 * A tournament needs shared state that a static site cannot provide: who holds
 * which code, when they tee off, and everyone's scores. This interface is that
 * boundary. `MockTournamentService` fakes it entirely in the browser so the
 * whole flow is playable today; a real implementation talks to the service in
 * front of the AS400 and nothing above this file changes.
 *
 * Contract the real backend must satisfy:
 *   POST /join            { code }                  -> JoinResult
 *   POST /score           { tournamentId, code, … }  -> 2xx
 *   GET  /leaderboard/:id                            -> LeaderboardRow[]
 */

import { GameMode } from "../engine/index.js";
import { reportScore } from "./tournament.js";

export interface Player {
  tournamentId: string;
  playerCode: string;
  playerName: string;
  /** ISO timestamp the player must have joined by. */
  teeTime: string;
}

export type JoinResult =
  | ({ ok: true } & Player)
  | { ok: false; reason: "unknown-code" | "missed-tee-time" | "offline"; teeTime?: string };

export interface LeaderboardRow {
  playerName: string;
  score: number;
  rank: number;
  isYou: boolean;
}

export interface RoundResult {
  tournamentId: string;
  playerCode: string;
  playerName: string;
  score: number;
  mode: GameMode;
  date: string;
}

export interface TournamentService {
  /** Validate a code and claim a seat. Enforces the tee-off cutoff. */
  join(code: string): Promise<JoinResult>;
  /** Record a finished round. Returns false if it could not be delivered. */
  submitRound(result: RoundResult): Promise<boolean>;
  /** Standings for the tournament, best first, with the caller flagged. */
  leaderboard(tournamentId: string, playerCode: string): Promise<LeaderboardRow[]>;
  /** True when this is fake data and must not be shown as authoritative. */
  readonly isMock: boolean;
}

/** Golf: fewest strokes wins. PokerStr8ts: most points wins. */
function rankRows<T extends { score: number }>(rows: T[], mode: GameMode): (T & { rank: number })[] {
  const golf = mode === GameMode.GolfMode;
  const sorted = [...rows].sort((a, b) => (golf ? a.score - b.score : b.score - a.score));
  let rank = 0;
  let prev: number | null = null;
  return sorted.map((r, i) => {
    if (prev === null || r.score !== prev) rank = i + 1;
    prev = r.score;
    return { ...r, rank };
  });
}

// ---------------------------------------------------------------------------
// Mock
// ---------------------------------------------------------------------------

const MOCK_KEY = "pokerst8ts.mockTournament.v1";
const FIELD_NAMES = [
  "A. Rivera", "B. Okafor", "C. Lindqvist", "D. Moreau", "E. Tanaka", "F. Haddad",
  "G. Novak", "H. Silva", "I. Brennan", "J. Kowalski", "K. Adeyemi", "L. Ferrari",
  "M. Dubois", "N. Petrov", "O. Nakamura", "P. Andersson", "Q. Marsh", "R. Delgado",
  "S. Whitfield", "T. Bergström", "U. Castellanos", "V. Ashworth", "W. Ibrahim",
];

interface MockState {
  results: { playerCode: string; playerName: string; score: number }[];
}

function readMock(): MockState {
  try {
    const parsed = JSON.parse(localStorage.getItem(MOCK_KEY) || "");
    if (parsed && Array.isArray(parsed.results)) return parsed;
  } catch {
    /* fall through to a fresh field */
  }
  return { results: [] };
}

function writeMock(state: MockState): void {
  try {
    localStorage.setItem(MOCK_KEY, JSON.stringify(state));
  } catch {
    /* private mode — the field just resets on reload */
  }
}

/** Deterministic pseudo-random in [0,1) from a string, so a field is stable. */
function seeded(seed: string): () => number {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

/**
 * In-browser fake. Accepts any 15-digit code and invents a plausible field so
 * the end-of-round leaderboard has something to show.
 *
 * Tee time is derived from the code's last digit so the lockout is testable:
 * codes ending in 0 or 1 have already missed their tee-off, everything else
 * tees off shortly. `fieldSize` controls how many other players exist.
 */
export class MockTournamentService implements TournamentService {
  readonly isMock = true;

  // Default field is deliberately larger than one board page so the pager is
  // exercised in the demo the way a real tournament would exercise it.
  constructor(private readonly fieldSize = 23) {}

  async join(code: string): Promise<JoinResult> {
    const trimmed = code.trim();
    const last = Number(trimmed.slice(-1));
    // ponytail: last-digit rule stands in for a real schedule lookup.
    const minutesFromNow = last - 2;
    const teeTime = new Date(Date.now() + minutesFromNow * 60_000).toISOString();
    if (minutesFromNow < 0) return { ok: false, reason: "missed-tee-time", teeTime };

    return {
      ok: true,
      tournamentId: "MOCK-TOURNAMENT",
      playerCode: trimmed,
      playerName: `Player ${trimmed.slice(-4)}`,
      teeTime,
    };
  }

  async submitRound(result: RoundResult): Promise<boolean> {
    const state = readMock();
    state.results = state.results.filter((r) => r.playerCode !== result.playerCode);
    state.results.push({
      playerCode: result.playerCode,
      playerName: result.playerName,
      score: result.score,
    });
    writeMock(state);

    // Still exercise the real AS400 post (and its retry queue) so that path
    // is not dead code while the backend is mocked.
    return reportScore({
      playerCode: result.playerCode,
      score: result.score,
      mode: result.mode,
      date: result.date,
    });
  }

  async leaderboard(tournamentId: string, playerCode: string): Promise<LeaderboardRow[]> {
    const state = readMock();
    const rand = seeded(tournamentId);
    const field = FIELD_NAMES.slice(0, Math.max(0, this.fieldSize)).map((playerName) => ({
      playerName,
      score: Math.round(rand() * 60) - 10,
      isYou: false,
    }));
    const mine = state.results.map((r) => ({
      playerName: r.playerCode === playerCode ? "You" : r.playerName,
      score: r.score,
      isYou: r.playerCode === playerCode,
    }));
    return rankRows([...field, ...mine], GameMode.PokerStraightsMode);
  }
}
