import { beforeEach, describe, expect, it, vi } from "vitest";
import { GameMode } from "../src/engine/index.js";
import { buildRecord, isValidPin, isValidPlayerId, rankChar, recordUrl, reportRound, pendingRecords, RECORD_LENGTH } from "../src/game/as400.js";
import { MockTournamentService } from "../src/game/tournamentService.js";
import { flushMoves, recordMove, pendingMoveCount, type MoveEvent } from "../src/game/moveLog.js";
import { pageOfPlayer, TABLE_PAGE_SIZE } from "../src/ui/leaderboard.js";

// Minimal in-memory stand-ins; the modules read these off globalThis.
const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
};

beforeEach(() => store.clear());

describe("player id / pin", () => {
  it("accepts up to 15 alphanumeric chars for a player id", () => {
    expect(isValidPlayerId("GORDONSTITT0001")).toBe(true);
    expect(isValidPlayerId("  GORDONSTITT0001  ")).toBe(true);
    expect(isValidPlayerId("abc123")).toBe(true);
  });

  it("rejects an empty, too-long, or non-alphanumeric player id", () => {
    for (const bad of ["", "X".repeat(16), "has space", "has-dash"]) {
      expect(isValidPlayerId(bad)).toBe(false);
    }
  });

  it("accepts exactly 6 digits for a pin", () => {
    expect(isValidPin("123456")).toBe(true);
    expect(isValidPin("  123456  ")).toBe(true);
  });

  it("rejects wrong-length or non-digit pins", () => {
    for (const bad of ["", "12345", "1234567", "12345x"]) {
      expect(isValidPin(bad)).toBe(false);
    }
  });
});

describe("tee-off lockout", () => {
  const svc = new MockTournamentService();

  // Mock rule: last PIN digit < 2 means the tee time has already passed.
  it("refuses a pin whose tee-off has passed", async () => {
    for (const pin of ["100000", "100001"]) {
      const join = await svc.join("GORDONSTITT0001", pin);
      expect(join.ok).toBe(false);
      if (!join.ok) {
        expect(join.reason).toBe("missed-tee-time");
        expect(new Date(join.teeTime!).getTime()).toBeLessThan(Date.now());
      }
    }
  });

  it("admits a pin that has not teed off yet", async () => {
    const join = await svc.join("GORDONSTITT0001", "100005");
    expect(join.ok).toBe(true);
    if (join.ok) {
      expect(join.playerId).toBe("GORDONSTITT0001");
      expect(new Date(join.teeTime).getTime()).toBeGreaterThan(Date.now());
    }
  });
});

describe("round standings", () => {
  it("places the player in a field sized to the tournament", async () => {
    const svc = new MockTournamentService(9);
    svc.recordLocalScore("MOCK-TOURNAMENT", "P1", "Tester", 40);
    const rows = await svc.leaderboard("MOCK-TOURNAMENT", "P1");
    expect(rows).toHaveLength(10); // 9 others + you
    expect(rows.filter((r) => r.isYou)).toHaveLength(1);
  });

  it("ranks the top score first (PokerStr8ts: more points is better)", async () => {
    const svc = new MockTournamentService(0); // no field — just recorded rounds
    svc.recordLocalScore("MOCK-TOURNAMENT", "P1", "Tester", 10);
    svc.recordLocalScore("MOCK-TOURNAMENT", "P2", "Tester", 99);
    const rows = await svc.leaderboard("MOCK-TOURNAMENT", "P2");
    expect(rows[0]!.score).toBe(99);
    expect(rows[0]!.isYou).toBe(true);
    expect(rows[0]!.rank).toBe(1);
    expect(rows[1]!.rank).toBe(2);
  });

  it("keeps only a player's latest round, not one row per attempt", async () => {
    const svc = new MockTournamentService(0);
    svc.recordLocalScore("MOCK-TOURNAMENT", "P1", "Tester", 10);
    svc.recordLocalScore("MOCK-TOURNAMENT", "P1", "Tester", 55);
    const rows = await svc.leaderboard("MOCK-TOURNAMENT", "P1");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.score).toBe(55);
  });
});

describe("move audit trail", () => {
  beforeEach(() => {
    store.clear();
    vi.useRealTimers();
  });

  const move = (seq: number): MoveEvent => ({
    tournamentId: "T1",
    playerId: "GORDONSTITT0001",
    seq,
    action: "place",
    card: 101,
    cell: { grid: 0, col: 1, row: 1 },
    scoreAfter: seq,
    ts: "2026-07-23T00:00:00.000Z",
  });

  it("buffers moves and clears them once delivered", async () => {
    (globalThis as any).fetch = vi.fn(async () => ({ ok: true }));
    recordMove(move(0));
    expect(pendingMoveCount()).toBe(1);
    expect(await flushMoves()).toBe(true);
    expect(pendingMoveCount()).toBe(0);
  });

  // A round that dies mid-play is exactly why the audit trail exists, so a
  // failed flush must never discard moves.
  it("keeps moves buffered when the endpoint is unreachable", async () => {
    (globalThis as any).fetch = vi.fn(async () => {
      throw new Error("offline");
    });
    recordMove(move(0));
    recordMove(move(1));
    expect(await flushMoves()).toBe(false);
    expect(pendingMoveCount()).toBe(2);

    (globalThis as any).fetch = vi.fn(async () => ({ ok: true }));
    expect(await flushMoves()).toBe(true);
    expect(pendingMoveCount()).toBe(0);
  });

  it("sends every buffered move in one request, in order", async () => {
    const sent: any[] = [];
    (globalThis as any).fetch = vi.fn(async (_url: string, init: any) => {
      sent.push(JSON.parse(init.body));
      return { ok: true };
    });
    for (let i = 0; i < 3; i++) recordMove(move(i));
    await flushMoves();
    expect(sent).toHaveLength(1);
    expect(sent[0].moves.map((m: MoveEvent) => m.seq)).toEqual([0, 1, 2]);
  });

  it("auto-flushes once the buffer fills", async () => {
    (globalThis as any).fetch = vi.fn(async () => ({ ok: true }));
    for (let i = 0; i < 10; i++) recordMove(move(i));
    await vi.waitFor(() => expect(pendingMoveCount()).toBe(0));
  });
});

describe("board paging", () => {
  const row = (playerName: string, rank: number, isYou = false) => ({ playerName, score: 100 - rank, rank, isYou });
  const field = (n: number, from = 0) => Array.from({ length: n }, (_, i) => row(`P${from + i}`, from + i + 1));

  it("shows 20 rows per page on the signboard", () => {
    expect(TABLE_PAGE_SIZE).toBe(20);
  });

  it("starts on page one when the player is near the top", () => {
    const rows = [...field(3), row("You", 4, true), ...field(90, 4)];
    expect(pageOfPlayer(rows, 20)).toBe(0);
  });

  // With a 100-player field, landing on page 1 would hide most players from
  // themselves — the board must open on the page holding their row.
  it("opens on the page holding the player", () => {
    const rows = [...field(45), row("You", 46, true), ...field(54, 46)];
    expect(pageOfPlayer(rows, 20)).toBe(2); // rows 41-60
  });

  it("falls back to the first page when the player has no row", () => {
    expect(pageOfPlayer(field(50), 20)).toBe(0);
  });
});

describe("AS400 record", () => {
  const hand = (handID: string, complete = true) => ({ handID, complete }) as any;
  const score = (round: number, ids: string[]) =>
    ({ round, frontNine: 0, backNine: 0, hands: ids.map((i) => hand(i)) }) as any;
  const ids18 = ["3E", "4G", "4H", "4H", "3B", "4G", "5I", "5I", "4E", "3C", "4C", "4C", "4H", "3B", "4H", "5G", "5J", "4G"];
  const completions = ids18.map((_, i) => ({ hole: i + 1, cards: [], topCards: [101, 111] })); // Ace, Jack
  const base = {
    playerId: "GORDONSTITT0001",
    pin: "123456",
    score: score(97, ids18),
    handCompletions: completions,
  };

  it("is always exactly RECORD_LENGTH characters", () => {
    expect(buildRecord(base)).toHaveLength(RECORD_LENGTH);
    // Long inputs must truncate, not push later fields out of position.
    expect(buildRecord({ ...base, playerId: "X".repeat(40) })).toHaveLength(RECORD_LENGTH);
  });

  it("lays out prefix, day-of-year, quarter-hour, player id and pin in order", () => {
    const rec = buildRecord(base, new Date(2026, 0, 1)); // day 1, so ddd = "001"
    expect(rec.startsWith("TOURT001")).toBe(true);
    expect(rec.slice(10, 25)).toBe("GORDONSTITT0001".padEnd(15, " "));
    expect(rec.slice(25, 31)).toBe("123456");
  });

  it("writes all 18 hand IDs, two characters each", () => {
    const rec = buildRecord(base);
    const block = rec.slice(31, 31 + 36);
    expect(block).toBe(ids18.join(""));
  });

  it("leaves a blank slot for a hand that never completed", () => {
    const partial = score(10, ids18);
    partial.hands[4] = hand("", false);
    const rec = buildRecord({ ...base, score: partial });
    expect(rec.slice(31 + 8, 31 + 10)).toBe("  ");
  });

  it("writes an unsigned 3-digit score", () => {
    expect(buildRecord({ ...base, score: score(42, ids18) })).toContain("042");
    expect(buildRecord({ ...base, score: score(-42, ids18) })).toContain("042");
  });

  it("encodes each card as one rank character", () => {
    expect(rankChar(101)).toBe("A"); // rank 1
    expect(rankChar(110)).toBe("T"); // rank 10
    expect(rankChar(113)).toBe("K"); // rank 13
  });

  it("writes the 2 top-card ranks per hole", () => {
    const rec = buildRecord(base);
    const topBlock = rec.slice(31 + 36 + 3);
    expect(topBlock.slice(0, 2)).toBe("AJ");
  });

  it("sends to the supplied endpoint unmodified", () => {
    const url = recordUrl(buildRecord(base));
    expect(url.startsWith("https://www.centriko.com/pgolfe/TNPKCGI1.pgm?HDATASTREAM=")).toBe(true);
  });

  it("keeps a local copy so a no-cors send is never the only record", async () => {
    (globalThis as any).fetch = vi.fn(async () => undefined);
    const { record, sent } = await reportRound(base);
    expect(sent).toBe(true);
    expect(pendingRecords()).toContain(record);
  });

  it("still keeps the local copy when the browser is offline", async () => {
    (globalThis as any).fetch = vi.fn(async () => {
      throw new Error("offline");
    });
    const { sent } = await reportRound(base);
    expect(sent).toBe(false);
    expect(pendingRecords()).toHaveLength(1);
  });
});
