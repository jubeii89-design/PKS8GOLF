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

`GET /health` reports which of these are live, so you can confirm the setup
before opening entries rather than discovering a gap mid-event.

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

## Storage

SQLite (`tournament.db`), via `node:sqlite` — built into Node 22, so there is
nothing to install and no second process to run. One file you can copy, inspect
with any SQLite client, and hand to someone after the event.

Tables: `players`, `rounds`, `moves`, `as400_queue`. Beyond being queryable it
buys correctness a log could not — a round must belong to a player who exists,
moves are unique per `(round, seq)` so a retried flush is a no-op, the delivery
queue survives a restart, and multi-row writes are transactional.

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
