import { beforeEach, describe, expect, it, vi } from "vitest";
import { GameMode } from "../src/engine/index.js";
import {
  flushPendingScores,
  isValidPlayerCode,
  pendingScoreCount,
  reportScore,
} from "../src/game/tournament.js";
import { MockTournamentService } from "../src/game/tournamentService.js";

// Minimal in-memory stand-ins; the module reads these off globalThis.
const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
};

const report = { playerCode: "123456789012345", score: 42, mode: GameMode.PokerStraightsMode, date: "2026-07-23" };

beforeEach(() => store.clear());

describe("player code", () => {
  it("accepts exactly 15 digits", () => {
    expect(isValidPlayerCode("123456789012345")).toBe(true);
    expect(isValidPlayerCode("  123456789012345  ")).toBe(true);
  });

  it("rejects wrong length or non-digits", () => {
    for (const bad of ["", "12345678901234", "1234567890123456", "12345678901234x", "abcdefghijklmno"]) {
      expect(isValidPlayerCode(bad)).toBe(false);
    }
  });
});

describe("score reporting", () => {
  it("delivers on a 2xx and queues nothing", async () => {
    (globalThis as any).fetch = vi.fn(async () => ({ ok: true }));
    expect(await reportScore(report)).toBe(true);
    expect(pendingScoreCount()).toBe(0);
  });

  // The score must survive a dead endpoint — this is the data-loss guard.
  it("queues the score when the post fails, then flushes it later", async () => {
    (globalThis as any).fetch = vi.fn(async () => {
      throw new Error("offline");
    });
    expect(await reportScore(report)).toBe(false);
    expect(pendingScoreCount()).toBe(1);

    (globalThis as any).fetch = vi.fn(async () => ({ ok: true }));
    await flushPendingScores();
    expect(pendingScoreCount()).toBe(0);
  });

  it("keeps the score queued while the endpoint stays down", async () => {
    (globalThis as any).fetch = vi.fn(async () => ({ ok: false }));
    await reportScore(report);
    await flushPendingScores();
    expect(pendingScoreCount()).toBe(1);
  });
});

describe("tee-off lockout", () => {
  const svc = new MockTournamentService();

  // Mock rule: last digit < 2 means the tee time has already passed.
  it("refuses a code whose tee-off has passed", async () => {
    for (const code of ["123456789012340", "123456789012341"]) {
      const join = await svc.join(code);
      expect(join.ok).toBe(false);
      if (!join.ok) {
        expect(join.reason).toBe("missed-tee-time");
        expect(new Date(join.teeTime!).getTime()).toBeLessThan(Date.now());
      }
    }
  });

  it("admits a code that has not teed off yet", async () => {
    const join = await svc.join("123456789012345");
    expect(join.ok).toBe(true);
    if (join.ok) {
      expect(join.playerCode).toBe("123456789012345");
      expect(new Date(join.teeTime).getTime()).toBeGreaterThan(Date.now());
    }
  });
});

describe("round standings", () => {
  beforeEach(() => {
    store.clear();
    (globalThis as any).fetch = vi.fn(async () => ({ ok: true }));
  });

  const submit = (svc: MockTournamentService, playerCode: string, score: number) =>
    svc.submitRound({
      tournamentId: "MOCK-TOURNAMENT",
      playerCode,
      playerName: "Tester",
      score,
      mode: GameMode.PokerStraightsMode,
      date: "2026-07-23",
    });

  it("places the player in a field sized to the tournament", async () => {
    const svc = new MockTournamentService(9);
    await submit(svc, "123456789012345", 40);
    const rows = await svc.leaderboard("MOCK-TOURNAMENT", "123456789012345");
    expect(rows).toHaveLength(10); // 9 others + you
    expect(rows.filter((r) => r.isYou)).toHaveLength(1);
  });

  it("ranks the top score first (PokerStr8ts: more points is better)", async () => {
    const svc = new MockTournamentService(0); // no field — just submitted rounds
    await submit(svc, "111111111111111", 10);
    await submit(svc, "222222222222222", 99);
    const rows = await svc.leaderboard("MOCK-TOURNAMENT", "222222222222222");
    expect(rows[0]!.score).toBe(99);
    expect(rows[0]!.isYou).toBe(true);
    expect(rows[0]!.rank).toBe(1);
    expect(rows[1]!.rank).toBe(2);
  });

  it("keeps only a player's latest round, not one row per attempt", async () => {
    const svc = new MockTournamentService(0);
    await submit(svc, "123456789012345", 10);
    await submit(svc, "123456789012345", 55);
    const rows = await svc.leaderboard("MOCK-TOURNAMENT", "123456789012345");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.score).toBe(55);
  });
});
