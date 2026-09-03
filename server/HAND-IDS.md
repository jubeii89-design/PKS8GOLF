# Hand IDs — what this engine produces

For whoever maintains `TNPKCGI1.pgm`. The 36-character hand block in each
record is 18 two-character IDs, one per hole. This is every ID this engine can
produce, derived exhaustively rather than sampled.

The question to settle: **does the AS400 use the same table?** If it does not,
that block is being misread, and so is the score derived from it.

## Confirmed by the supplied sample

The first character of each ID is the number of cards in that hand, and the
sequence in the sample matches this course's hole layout exactly:

```
sample leading digits : 3 4 4 4 3 4 5 5 4 3 4 4 4 3 4 5 5 4
our hole layout       : 3 4 4 4 3 4 5 5 4 3 4 4 4 3 4 5 5 4
```

Par-3 holes are 1, 5, 10 and 14. So the block's shape is agreed.

## The table

Strokes are Golf scoring; points are PokerStr8ts. Frequency is out of all
possible hands of that size, which is why some IDs are rare enough that you may
never see them in a hundred-player field.

| ID | Strokes | vs par | Points | Frequency | Hand |
|---|---|---|---|---|---|
| 3A | 1 | eagle+ | 35 | 48 | Eagle Hole In One |
| 3B | 2 | birdie | 33 | 52 | Birdie |
| 3C | 2 | birdie | 18 | 720 | Birdie |
| 3D | 3 | **par** | 14 | 1,096 | Par |
| 3E | 3 | **par** | 9 | 3,744 | Par |
| 3F | 4 | bogey | −3 | 16,440 | Bogey |
| 4A | 2 | eagle+ | 47 | 44 | Eagle |
| 4B | 2 | eagle+ | 43 | 13 | Eagle |
| 4C | 3 | birdie | 28 | 2,496 | Birdie |
| 4D | 3 | birdie | 25 | 2,772 | Birdie |
| 4E | 4 | **par** | 23 | 2,808 | Par |
| 4F | 4 | **par** | 22 | 2,816 | Par |
| 4G | 5 | bogey | 7 | 82,368 | Bogey |
| 4H | 6 | **double bogey** | −4 | 177,408 | Double |
| 5A | 2 | eagle+ | 58 | 4 | Albatross |
| 5B | 3 | eagle+ | 50 | 36 | Eagle |
| 5C | 3 | eagle+ | 42 | 624 | Eagle |
| 5D | 4 | birdie | 38 | 3,744 | Birdie |
| 5E | 4 | birdie | 34 | 5,108 | Birdie |
| 5F | 5 | **par** | 31 | 10,200 | Par |
| 5G | 5 | **par** | 19 | 54,912 | Par |
| 5H | 5 | **par** | 16 | 123,552 | Par |
| 5I | 6 | bogey | 5 | 1,098,240 | Bogey |
| 5J | 7 | **double bogey** | −5 | 1,302,540 | Double |

Letters run best to worst within each hand size. They identify the **hand
type**, not the score — which is why several letters share a stroke value (two
different poker hands can both be pars).

## The discrepancy

The written spec says:

> `3E` represents a bad 3-card hand and is scored a double bogey 5

In this engine `3E` is a **par, 3 strokes** — the second most common par there
is. And more structurally:

**No 3-card hand in this engine scores 5.** The worst is `3F` at 4 strokes, a
bogey. Four- and five-card hands *do* reach a double bogey (`4H` = 6, `5J` = 7),
so par-3 holes are the odd ones out. That asymmetry may be deliberate, or it may
be a quirk carried over from the original game — but if the AS400 expects a
3-card hand to be able to score 5, the two systems disagree about every badly
played par 3.

**What that would cost.** `3F` is the most common 3-card outcome by far (16,440
of 22,100 combinations). Measured over 300 rounds it appears **3 times per round
on average, up to 4**. If the mainframe scores it 5 where this engine scores 4,
every occurrence is a stroke, so a typical round differs by 3 strokes on a
88–103 range — easily enough to reorder a leaderboard.

## The supplied sample cannot settle this

Worth saying plainly so nobody spends time on it: the example record is
placeholder data, not a real round.

1. Its first nine and back nine are **byte-identical** —
   `3E 4A 4A 4A 3E 4A 5G 5G 4A` twice.
2. That makes the block 4×`3E`, 10×`4A`, 4×`5G`, so the total is
   `4a + 10b + 4c = 2(2a + 5b + 2c)` — **always even**, whatever stroke values
   are assigned. The record states **097**, which is odd. No table can produce
   it, including one where `3E` = 5.
3. Under this engine's table it contains **ten eagles**, which does not happen
   (`4A` occurs in 44 of 270,725 four-card hands).
4. It is 104 characters, not 106 — the prefix is one short (`TOUT`, not
   `TOURT`), the PIN one long (7 digits, not 6), and the top-card block two
   short.

## How to settle it in one step

Take a **real** record the mainframe produced and run:

```bash
node scripts/decode-record.mjs "<the record>"
```

It decodes every field, reads each hand ID against this table, and adds them up.
In golf a round is the sum of its holes, so:

- **the hands sum to the stated score** → the tables agree, and it also tells
  you whether the score field is carrying strokes or points;
- **they do not** → it prints the difference, and which holes this engine reads
  differently.

`node scripts/decode-record.mjs --table` prints the table above on its own.

## The three questions

1. Does the score field want **golf strokes** or **PokerStr8ts points**?
   (Strokes run 88–103 and are never negative; points run −62 to +109 and are
   negative in a third of rounds.)
2. If points — how is a **negative** written into three characters with no room
   for a sign?
3. Can you share the mainframe's **hand-ID table**, so it can be diffed against
   the one above?
