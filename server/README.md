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
| `GET` | `/health` | `{ ok, rounds, as400Pending }` |

## Storage

Append-only JSONL, one line per event, written as it arrives:

- `rounds.jsonl` — one line per finished round, including the exact AS400 record
- `moves.jsonl` — one line per move, with the server's receipt time

A tournament is roughly 100 players × 45 moves, so this stays in the low
thousands of lines. A database would be more moving parts than the problem has.
Restarting replays `rounds.jsonl`, so the field survives a crash.

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
npm run relay:check
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
