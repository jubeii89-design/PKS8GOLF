# PokerSt8ts

A **Strategic Titans** ([www.strategictitans.ca](https://www.strategictitans.ca)) web game — the
solo mode of the original Unity *PokerStraights*, rebuilt in TypeScript. Place one card at a time
across two grids to build 18 poker hands; play for **PokerStr8ts** (high round) or **Golf**
strokes (low round). The scoring engine is a verified statement-for-statement port of the
decompiled `Engine.cs`.

## Run it

```sh
npm install
npm run dev        # play locally (Vite dev server)
npm run build      # static bundle → dist/ (deployable to strategictitans.ca)
npm run preview    # serve the built bundle
npm test           # engine + game-state unit tests
npm run typecheck
```

The site is a two-page Vite build: **`/`** is a marketing portal (branding, tagline, gold ENTER
button) and **`/play/`** is the game itself. Playable slice: branded intro
(`www.strategictitans.ca Presents → PokerSt8ts`) → mode select → two 4×5 grids with the original's
cut corners, next-card rail, PASS button, cards-remaining counter, and a live 18-hole scorecard →
round-complete panel. Cards and the crest render as CSS/SVG and **auto-swap to real PNGs** when
dropped into `public/assets/` (see `public/assets/README.md`).

## Status

- [x] Card model (`id = suit*100 + rank`, Spades bare, blank filler = 500)
- [x] Deck (random 52-card shuffle, injectable RNG)
- [x] Board topology (two 4×5 grids with opposite corners cut → 18 cells / 9 hands per grid,
      hole order verified against `Engine.FinishLoadingCardHandList`)
- [x] Scoring, ported statement-for-statement from the decompiled `Engine.cs`
      (`GetNameOfHand`, `HandIDValue`, `LookupHandPointValue`, `AddScoreToHand`) —
      both PokerStraights points and golf strokes
- [x] Parity harness: all 24 hand IDs × concrete hands, exact IDs + points
- [x] Completed-game screenshot as end-to-end oracle: golf mode reproduces the
      original scorecard exactly (46 / 38 / 84)
- [x] Pure-function refactor (`src/engine/scoring.ts`) kept equivalent to the legacy
      port by a 48k-hand randomized cross-check (IDs, points, names, factor values)

## Layout

- `src/engine/cards.ts` — card ID encoding/decoding
- `src/engine/deck.ts` — shuffle (solo mode only; tournament deck plumbing was cut)
- `src/engine/board.ts` — cell mask, hand membership, `BoardState`
- `src/engine/scoring-legacy.ts` — phase-1 "ugly" port; kept as the porting reference,
  exercised by the same suites as the pure implementation
- `src/engine/scoring.ts` — phase-3 pure implementation (default)
- `src/engine/index.ts` — public API: `evaluateHand(cards, mode)`, `scoreBoard(board, mode)`
- `src/game/gameState.ts` — solo game loop (deck draw, 6 auto-placed, place/pass, end detection);
  no DOM, no player identity
- `src/game/leaderboard.ts` — persistent leaderboard behind a `LeaderboardStore`
  interface (`localStorage` now, `RemoteLeaderboardStore` seam for a shared DB later)
- `src/ui/` — framework-free renderers: `cards`, `board`, `scorecard`, `intro`,
  `leaderboard`, `courseBackground`, `pokerTableBackground`, `crest` (shared logo, used by both the
  portal and the intro), `assetBase` (resolves the optional-art probe paths correctly regardless of
  which page — `/` or `/play/` — is loaded); `src/main.ts` wires intro → round → end panel →
  leaderboard; `src/ui/styles.css`
- `src/portal/` — the marketing portal at site root (`main.ts`, `portal.css`); links to `/play/`
  via the gold ENTER button
- `tests/` — parity fixture, screenshot-board oracle, equivalence suite, game-state tests
- `scripts/smoke.mjs` — headless Chromium end-to-end check (`npm run smoke` against a running
  `preview`)

The engine scores any `BoardState` without knowing who placed the cards, and the game-state layer
imports only the engine (no UI).

## Leaderboard

Persistent, separate top-20 boards for PokerStr8ts (high) and Golf (low). Storage sits behind
an async `LeaderboardStore`: `LocalLeaderboardStore` (per-browser `localStorage`, ships with the
static build) today, with a documented `RemoteLeaderboardStore` seam so a shared hosted database
drops in later with zero UI rework. A qualifying finish prompts for a name (remembered) and shows
the ranked board with the new entry highlighted.

## Hand ID reference (decoded from the original code)

| Type | 5 cards | 4 cards | 3 cards |
|---|---|---|---|
| Royal Flush | 5A = 58 | (scores as SF) | (scores as SF) |
| Straight Flush | 5B = 50 | 4A = 47 | 3A = 35 |
| Four of a Kind | 5C = 42 | 4B = 43 | — |
| Full House | 5D = 38 | — | — |
| Flush | 5E = 34 | 4F = 22 | 3D = 14 |
| Straight | 5F = 31 | 4D = 25 | 3C = 18 |
| Three of a Kind | 5G = 19 | 4C = 28 | 3B = 33 |
| Two Pairs | 5H = 16 | 4E = 23 | — |
| Pair | 5I = 5 | 4G = 7 | 3E = 9 |
| Nothing | 5J = −5 | 4H = −4 | 3F = −3 |

## Canonical 286 board — hand-lock finding

The task brief's canonical scorecard (front 133 / back 153 / round 286) is reproduced
exactly by the engine (`tests/canonical-board.test.ts`), with one important mechanic
uncovered along the way: the original game **froze three hands' scores before their
last card arrived**. In the canonical game the last three cards placed were 3♥,4♥,5♥
into the top row (completing hole 1), and columns 7/8/9 kept the scores of the cards
below — the scorecard shows `4H,4C,3F` for those holes even though the final layout
evaluates to `5J,5G,4H` (pure board-state scoring of the final layout gives
122/153/275; the frozen 4/4/3-card subsets give the scorecard's 133/153/286).

With `Engine.cs`, `CardSlot.cs`, and the complete `CardHand.cs` all inspected, the
freeze is provably impossible in the decompiled assembly: `CheckIfHandIsComplete`
requires every slot filled, `SetCard`/`GetCard` are synchronous with placement,
`CardHand` has no provisional scoring, and `CheckForCompletedHands` always passes
`hand.Count` cards to the scorer. The 286 scorecard therefore came from an **earlier
build** of the game that could lock a hand's score before its last card arrived (the
two reference screenshots even use different scoreboard layouts). Per-hand scoring
parity is unaffected — every ID→points pair on both scorecards matches the engine.

Rule for the future game-loop, per the current assembly: `CheckIfHandIsComplete`
sets `handCompletedAnimationCompleted = true` **as a side effect of the check**, so a
hand is scored exactly once, at the moment its last cell fills. Pure board-state
scoring stays placement-order independent, as required for the future multi-player
mode.

## Commands

```sh
npm install
npm test        # vitest
npm run typecheck
```
