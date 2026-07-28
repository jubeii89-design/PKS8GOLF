import { beforeEach, describe, expect, it, vi } from "vitest";
import { GameMode } from "../src/engine/index.js";
import {
  flushPendingScores,
  isValidPlayerCode,
  pendingScoreCount,
  reportScore,
} from "../src/game/tournament.js";

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
