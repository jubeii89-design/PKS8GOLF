# Tournament relay

The game is a static site and the AS400 is send-only — it takes a record when a
round ends and never serves anything back. That leaves two gaps a player's
phone cannot close on its own:

- the per-move audit trail has nowhere to go, and
- nobody can see how the rest of the field is doing.

This server closes both, because every score passes through it on its way to
the AS400. It is the "phones → server → AS400" shape, with one addition: since
the server sees every score anyway, it can also answer *what is everyone
scoring* — no AS400 read path required.

It also makes delivery **verifiable**. A browser sending cross-origin to the
AS400 cannot read the response, so it never learns whether the record landed.
This server sees the real HTTP status, so a failure is a fact and gets retried.

## Running it

```bash
npm run relay
# or
PORT=8080 DATA_DIR=/var/lib/pks8golf node server/relay.mjs
```

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | Port to listen on |
| `DATA_DIR` | `./relay-data` | Where the JSONL logs are written |
| `AS400_URL` | `https://www.centriko.com/pgolfe/TNPKCGI1.pgm` | Where records are forwarded |

### Signups, payment and email

Signups stay closed until Square is configured — the server will not pretend to
charge anyone. Everything here is an environment variable; **none of these
values belong in the repository.**

| Variable | Meaning |
|---|---|
| `SQUARE_ACCESS_TOKEN` | Square API token. Required for signups to open. |
| `SQUARE_LOCATION_ID` | Which Square location the entry fee belongs to. |
| `SQUARE_ENVIRONMENT` | `sandbox` (default) or `production`. |
| `SQUARE_WEBHOOK_KEY` | Signature key. Without it every payment confirmation is refused. |
| `SQUARE_WEBHOOK_URL` | The public URL Square posts to; it forms part of the signature, so it must match exactly. |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | Mail server. Unset means credentials are **not sent**. |
| `MAIL_FROM` | e.g. `Strategic Titans <tournament@strategictitans.ca>` |
| `ENTRY_FEE_CENTS` | Entry fee in cents. Default `2500` (CA$25.00). |
| `CURRENCY` | Default `CAD`. |
| `PLAY_URL` | Link put in the email. |
| `TOURNAMENT_NAME` / `_CHARITY` / `_DATE` / `_TEE_OFF` / `_CONTACT` | Shown on the signup page and in the email. |
| `SESSION_SECRET` | Signs session tokens. Unset means a random one, so a restart ejects players mid-round. **Set it.** |
| `TEE_OFF_AT` | ISO timestamp after which nobody new may start. Unset means no cutoff. |
| `ADMIN_TOKEN` | Guards `/admin/*`. Unset leaves those endpoints closed. |
| `SIGNUP_LIMIT` | Signups allowed per address per 10 minutes (default 5). |
| `ALLOWED_ORIGINS` | Comma-separated sites that may call this relay from a browser. Unset allows any. |
| `AS400_SCORE_MODE` | `poker` (default) or `golf` — which score goes in the record. See below. |
| `AS400_NEGATIVE` | `abs` (default), `minus`, or `overpunch` — how a negative score is written. |
| `BACKUP_DIR` | Where database snapshots go. **Unset means no backups.** Put it on different storage. |
| `BACKUP_INTERVAL_MS` | How often to snapshot (default 5 min). |
| `BACKUP_KEEP` | How many snapshots to keep (default 12). |
| `PIN_ATTEMPT_LIMIT` | Wrong PINs per player before lockout (default 10). |
| `PIN_LOCKOUT_MS` | How long a lockout lasts (default 15 min). |

`GET /health` reports which of these are live, so you can confirm the setup
before opening entries rather than discovering a gap mid-event.

## Building your own signup page

The signup page can live anywhere — see [SIGNUP-API.md](SIGNUP-API.md). It is
two endpoints and a redirect, and it never touches card details. Point the
game's "Not entered yet?" links at it with `VITE_SIGNUP_URL` when building.

## How a player gets in

1. They open `/signup/`, enter a name and email, and are sent to **Square's own
   checkout page**. No card details ever reach this server or the game — that
   is the whole reason for using a hosted checkout.
2. Square posts a webhook when the payment completes. It is believed only if the
   signature verifies; a forged one is refused and logged.
3. Only then is a **PIN minted**. It reaches the player two ways: emailed with
   the tournament details, **and** shown on the screen Square returns them to.
   Email fails in ordinary ways — a typo, a spam folder, a bounce — and it used
   to be the only route, which meant a failed email left someone who had paid
   unable to play.

   The return carries a signed claim ticket rather than a player id, so nobody
   can harvest PINs by guessing ids, and that ticket may do nothing except
   claim — it is not a session and cannot submit a score. A credential that
   existed before payment could be used before payment, so none does.
4. `POST /join` checks the ID and PIN against the roster. Unknown player, wrong
   PIN, and paid-but-not-yet are now real, distinguishable answers.

PINs are stored salted and hashed. The plaintext is held in memory for 30
minutes so the return screen can show it, and never written to the database or
the log — so a leaked database still does not hand over the field's
credentials. A relay restart drops those held PINs; the email remains the
fallback.

If mail fails after a payment succeeds the log says `PAID BUT NOT EMAILED` with
the player ID. That person has been charged and cannot play until their
credentials are re-issued, so it is worth alerting on.

Then build the game pointed at it:

```bash
VITE_RELAY_URL=https://relay.example.com npm run build
```

Leave `VITE_RELAY_URL` unset and the game behaves as before: scores go straight
to the AS400 as a blind cross-origin GET, moves have nowhere to land, and the
leaderboard shows an invented field stamped `DEMO DATA`. Set it and all three
become real. There is no configuration in which a record is sent twice — it is
one path or the other.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/moves` | Accept a batch of move events; appended to `moves.jsonl` |
| `POST` | `/round` | Record a finished round, forward the record to the AS400 |
| `GET` | `/leaderboard?playerId=` | Current standings, caller flagged as `You` |
| `POST` | `/join` | Check credentials, open a round, issue a session token and deck seed |
| `POST` | `/claim` | Exchange the ticket in Square's return URL for the player's credentials |
| `POST` | `/admin/reissue` | Re-send a paid player's credentials with a fresh PIN |
| `GET` | `/admin/attention` | Who paid but has no PIN, or paid but never played |
| `POST` | `/admin/unlock` | Clear a player's PIN lockout |
| `GET` | `/admin` | The organiser's page (see below) |
| `GET` | `/admin/players` | The whole field, with status and scores |
| `GET` | `/health` | Roster counts, pending deliveries, and what is configured |

Every write after `/join` needs the session token as `Authorization: Bearer`.
Identity is taken from the token, not the request body, so a caller cannot act
for anyone but themselves.

## Scores are derived, never accepted

A client that computes its own score can lie about it, and authentication does
not fix that — a paying player can authenticate honestly and still send
`score: 9999`. So the server works the score out itself.

It holds both halves. The **deck** is issued at join and signed into the session
token, so a player cannot re-join until they like their cards. The **moves** are
already streamed for the audit trail. Replaying those through the same engine
the browser ran gives the score; the client's own figure is only compared, and
logged when it differs.

`npm run build:server` compiles the real engine to `server/lib/`, so the relay
runs the identical scoring code rather than a second implementation that would
drift. The engine validates a replay for free: `place()` throws on an occupied
or out-of-play cell, so fabricated moves fail to replay instead of quietly
producing a score. Such a round is refused with 422 and left open rather than
guessed at.

The AS400 record is built server-side from the derived score, so what the
mainframe is told and what the leaderboard shows cannot disagree.

## The score field — two things still unconfirmed

**Which mode's score belongs there.** Measured over 400 rounds:

| Mode | Range | Negative rounds |
|---|---|---|
| Golf (strokes) | 88 – 103 | **0%** |
| PokerStr8ts (points) | −62 – 109 | **34%** |

The supplied sample read `097`, which sits mid-range for golf, and the field
description talks in bogeys. That points at strokes. Set
`AS400_SCORE_MODE=golf` to send them — the relay replays the round once and
scores the same finished board both ways, so the leaderboard keeps showing
points either way.

Worth checking alongside it: the supplied spec says hand ID `3E` is *"a bad
3-card hand, double bogey 5"*, but this engine scores `3E` as **Par, 3
strokes**, and has no 3-card hand worth 5 at all. See
[HAND-IDS.md](HAND-IDS.md) for the full table, what a mismatch would cost
(~3 strokes a round), and why the supplied sample record cannot settle it.

`npm run decode -- "<a real record>"` reads a record against this engine's
table and checks whether its hands add up to its own score — which answers
both the table question and the strokes-or-points question in one step.

**How a negative is written**, if points are what it wants. The field is three
characters with no room for a sign:

| `AS400_NEGATIVE` | −18 becomes | Note |
|---|---|---|
| `abs` (default) | `018` | **Wrong** — read as +18. Logged loudly per player. |
| `minus` | `-18` | Only fits to −99 |
| `overpunch` | `01Q` | Zoned decimal, the usual AS/400 convention |

Until this is settled the relay logs `NEGATIVE SCORE ... SENT AS` naming the
player and the true score, and the database keeps the real figure, so anything
misreported can be reconciled afterwards.

## Storage

SQLite (`tournament.db`), via `node:sqlite` — built into Node 22, so there is
nothing to install and no second process to run. One file you can copy, inspect
with any SQLite client, and hand to someone after the event.

Tables: `players`, `rounds`, `moves`, `as400_queue`. Beyond being queryable it
buys correctness a log could not — a round must belong to a player who exists,
moves are unique per `(round, seq)` so a retried flush is a no-op, the delivery
queue survives a restart, and multi-row writes are transactional.

## The organiser's page

`http://your-relay/admin` — everything an organiser needs on the day, without a
terminal. Set `ADMIN_TOKEN` to enable it; unset, the page says so plainly
rather than 404ing.

It shows the field at a glance, who is **stuck** (paid but holding no PIN, or
paid and not started), a search, the live standings, and whether the AS400
queue is backing up — the one number that grows silently while everything else
looks fine. Two actions: re-send a player's credentials, and clear a PIN
lockout.

It deliberately **cannot edit scores.** Those are derived from replayed moves,
so a wrong one is a question to answer, not a number to overwrite — and a tool
that can rewrite results at a prize event is a liability.

It is served by the relay rather than built into the game, so it never ships to
the public site, it can never drift out of sync with the endpoints it calls,
and you can restrict `/admin` at your reverse proxy as a second layer. The page
carries no data and no secrets — everything it shows is fetched with the token
afterwards — so the page itself is served without one.

Player names are typed by the public at signup and are rendered as text, never
markup. `npm run admin:check` includes a player whose name is an XSS payload
and asserts it does not execute, because the admin page is the one page holding
the token.

## Holding up on the day

Three things were measured as real problems with a 100-player field and fixed;
`npm run resilience:check` holds the line on each.

**A slow mainframe used to be the players' problem.** The delivery attempt ran
inline with the full retry ladder, so an unreachable AS400 dragged every round
submission to **6.1s** — a hundred people watching a spinner at the moment
their round ends, for a record that was already safe in the database. The
record is now queued first and given one short attempt; the drain loop does the
rest in the background. Same test, dead mainframe: **233ms**.

**A shotgun start used to serialise.** `scryptSync` holds the event loop for
its whole duration, so 100 simultaneous joins stalled each other — worst wait
**3.6s**. Hashing now runs on the thread pool: **439ms at p95**.

**The door had no lock.** Signup was rate limited and `/join` was not, so a
six-digit PIN could be ground out at ~23 tries a second against a player ID
guessable from a name. Wrong PINs are now limited **per player** — an attacker
has many addresses but only one target — and an organiser can clear a lockout
with `/admin/unlock`.

## Backups

Everything the event owns is in one file: who paid, what they scored, and which
records the AS400 has not taken. Set `BACKUP_DIR` and it is snapshotted every
five minutes with `VACUUM INTO`, which takes a consistent copy of a live
database — plain `cp` can catch it mid-write and produce a corrupt file, which
is worse than no backup because you find out only when you need it.

Put `BACKUP_DIR` on **different storage** from `DATA_DIR`. A backup on the same
disk survives every failure except the one that is actually likely.

## When the AS400 is down

A round is recorded and acknowledged **before** the forward is attempted, so a
mainframe outage cannot cost you a score. Undelivered records are retried every
30 seconds. A `4xx` retires a record (the record itself is wrong; retrying will
not help) and is logged; anything else keeps retrying. `/health` reports how
many are outstanding.

Records are also still written to each player's device, so
`scripts/as400_report.py` remains available as a manual last resort.

## Checking it works

```bash
npm run checks         # everything below, in order

npm run auth:check     # nobody writes without having joined
npm run relay:check    # moves, AS400 delivery, standings, restart recovery
npm run signup:check   # signup, payment, webhook forgery, email, join
npm run verify:check   # a cheat and an honest player score identically
npm run ops:check      # tee-off lockout, credential re-issue, rate limiting
npm run claim:check    # collecting credentials after payment, and the race
npm run score:check    # what reaches the AS400 for a round that finished under
```

Spins up a stub AS400 and exercises the whole thing: move batches persist,
delivery is confirmed, a failed send is queued rather than lost, standings rank
correctly, and the field survives a restart.

For the full chain including real browsers, see `scripts/live-chain.mjs`.

## Before a real tournament

This is deliberately minimal and there is no authentication — anyone who can
reach it can post a score. That is fine on a private network or behind a
reverse proxy that restricts access; it is not fine on the open internet.
Put it behind TLS and restrict who can reach it before using it for a real
event.
