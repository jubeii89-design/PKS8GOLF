/**
 * Tournament backend seam.
 *
 * A tournament needs shared state that a static site cannot provide: who holds
 * which player ID/PIN, when they tee off, and everyone's scores. This
 * interface is that boundary. `MockTournamentService` fakes it entirely in
 * the browser so the whole flow is playable today; a real implementation
 * talks to the service in front of the AS400 and nothing above this file
 * changes.
 *
 * Contract the real backend must satisfy:
 *   POST /join            { playerId, pin }          -> JoinResult
 *   GET  /leaderboard/:id                             -> LeaderboardRow[]
 * Round scores do not go through this service — they are reported straight
 * to the AS400 datastream (see as400.ts).
 */

import { GameMode } from "../engine/index.js";

export interface Player {
  tournamentId: string;
  playerId: string;
  pin: string;
  playerName: string;
  /** ISO timestamp the player must have joined by. */
  teeTime: string;
}

export type JoinResult =
  | ({ ok: true } & Player)
  | { ok: false; reason: "unknown-player" | "wrong-pin" | "missed-tee-time" | "offline"; teeTime?: string };

export interface LeaderboardRow {
  playerName: string;
  score: number;
  rank: number;
  isYou: boolean;
}

export interface TournamentService {
  /** Validate a player ID + PIN and claim a seat. Enforces the tee-off cutoff. */
  join(playerId: string, pin: string): Promise<JoinResult>;
  /** Record a round score for the local standings display (session-only). */
  recordLocalScore(tournamentId: string, playerId: string, playerName: string, score: number): void;
  /** Standings for the tournament, best first, with the caller flagged. */
  leaderboard(tournamentId: string, playerId: string): Promise<LeaderboardRow[]>;
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
  results: { playerId: string; playerName: string; score: number }[];
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
 * In-browser fake. Accepts any player ID whose PIN's last digit determines
 * tee-off, and invents a plausible field so the end-of-round leaderboard has
 * something to show.
 *
 * Tee time is derived from the PIN's last digit so the lockout is testable:
 * PINs ending in 0 or 1 have already missed their tee-off, everything else
 * tees off shortly. `fieldSize` controls how many other players exist.
 */
export class MockTournamentService implements TournamentService {
  readonly isMock = true;

  // Default field is deliberately larger than one board page so the pager is
  // exercised in the demo the way a real tournament would exercise it.
  constructor(private readonly fieldSize = 23) {}

  async join(playerId: string, pin: string): Promise<JoinResult> {
    const id = playerId.trim();
    // ponytail: last-PIN-digit rule stands in for a real roster/schedule lookup.
    const last = Number(pin.trim().slice(-1));
    const minutesFromNow = last - 2;
    const teeTime = new Date(Date.now() + minutesFromNow * 60_000).toISOString();
    if (minutesFromNow < 0) return { ok: false, reason: "missed-tee-time", teeTime };

    return {
      ok: true,
      tournamentId: "MOCK-TOURNAMENT",
      playerId: id,
      pin: pin.trim(),
      playerName: id,
      teeTime,
    };
  }

  recordLocalScore(tournamentId: string, playerId: string, playerName: string, score: number): void {
    void tournamentId; // single mock tournament; kept for interface parity with a real backend
    const state = readMock();
    state.results = state.results.filter((r) => r.playerId !== playerId);
    state.results.push({ playerId, playerName, score });
    writeMock(state);
  }

  async leaderboard(tournamentId: string, playerId: string): Promise<LeaderboardRow[]> {
    const state = readMock();
    const rand = seeded(tournamentId);
    const field = FIELD_NAMES.slice(0, Math.max(0, this.fieldSize)).map((playerName) => ({
      playerName,
      score: Math.round(rand() * 60) - 10,
      isYou: false,
    }));
    const mine = state.results.map((r) => ({
      playerName: r.playerId === playerId ? "You" : r.playerName,
      score: r.score,
      isYou: r.playerId === playerId,
    }));
    return rankRows([...field, ...mine], GameMode.PokerStraightsMode);
  }
}
