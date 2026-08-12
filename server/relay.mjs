#!/usr/bin/env node
/**
 * Tournament relay.
 *
 * The game is a static site, and the AS400 is send-only: it accepts a record
 * when a round ends and never serves anything back. That leaves two things a
 * player's phone cannot do on its own — deliver the per-move audit trail
 * anywhere, and find out how the rest of the field is doing. This server sits
 * between the phones and the AS400 and does both, because every score passes
 * through it on the way.
 *
 * What it gives you that the phone cannot:
 *   - Confirmed delivery. A browser sending cross-origin to the AS400 cannot
 *     read the response, so it never learns whether the record landed. Here the
 *     HTTP status is visible, so a failed record is retried instead of lost.
 *   - Standings. Every round reported is a row; the field is just what has
 *     arrived so far. No AS400 read path needed.
 *   - Somewhere for the audit trail to land, off the player's device.
 *
 * Storage is append-only JSONL — one line per event, flushed as it arrives.
 * A tournament is ~100 players x ~45 moves, so this is a few thousand lines;
 * a database would be more moving parts than the problem has. Restarting the
 * server replays the files, so nothing is lost to a crash.
 *
 * Run:
 *   node server/relay.mjs
 *   PORT=8080 DATA_DIR=/var/lib/pks8golf node server/relay.mjs
 *
 * Point the game at it at build time:
 *   VITE_RELAY_URL=https://relay.example.com npm run build
 */

import { createServer } from "node:http";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const PORT = Number(process.env.PORT ?? 8787);
const DATA_DIR = process.env.DATA_DIR ?? "./relay-data";
const AS400_URL = process.env.AS400_URL ?? "https://www.centriko.com/pgolfe/TNPKCGI1.pgm";
const QUERY_PARAM = "HDATASTREAM";
const RETRIES = 3;
const RETRY_BACKOFF_MS = 2000;
const AS400_TIMEOUT_MS = 30_000;
/** Browsers may only send what the game actually sends; keeps junk out. */
const MAX_BODY_BYTES = 1_000_000;

const MOVES_LOG = join(DATA_DIR, "moves.jsonl");
const ROUNDS_LOG = join(DATA_DIR, "rounds.jsonl");

/**
 * Rounds seen this tournament, newest wins per player. Rebuilt from disk at
 * boot so a restart mid-tournament does not empty the leaderboard.
 */
const rounds = new Map();

/** Records the AS400 has not accepted yet. Retried in the background. */
const undelivered = [];

// ---------------------------------------------------------------------------
// AS400 delivery
// ---------------------------------------------------------------------------

/**
 * Forward one record. Unlike the browser, this can read the response, so a
 * failure is a fact rather than a guess.
 */
async function sendToAS400(record) {
  const url = `${AS400_URL}?${QUERY_PARAM}=${encodeURIComponent(record)}`;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        method: "GET",
        signal: AbortSignal.timeout(AS400_TIMEOUT_MS),
      });
      if (res.ok) return { delivered: true, status: res.status };
      // 4xx means the record itself is wrong; retrying cannot fix it.
      if (res.status >= 400 && res.status < 500) {
        return { delivered: false, status: res.status, permanent: true };
      }
      log(`as400 http ${res.status}, attempt ${attempt}/${RETRIES}`);
    } catch (err) {
      log(`as400 ${err.name === "TimeoutError" ? "timeout" : err.message}, attempt ${attempt}/${RETRIES}`);
    }
    if (attempt < RETRIES) await sleep(RETRY_BACKOFF_MS * attempt);
  }
  return { delivered: false, permanent: false };
}

/**
 * Keep trying anything the AS400 has not taken. A tournament score is worth
 * more than the request that carried it, so a record is never dropped for
 * being inconvenient — only a hard 4xx rejection retires it.
 */
async function drainUndelivered() {
  if (undelivered.length === 0) return;
  const batch = undelivered.splice(0, undelivered.length);
  for (const record of batch) {
    const result = await sendToAS400(record);
    if (result.delivered) {
      log(`as400 delivered on retry: ${record.slice(0, 24)}...`);
    } else if (result.permanent) {
      log(`as400 rejected permanently, not retrying: ${record.slice(0, 24)}...`);
    } else {
      undelivered.push(record);
    }
  }
}

// ---------------------------------------------------------------------------
// Standings
// ---------------------------------------------------------------------------

/** PokerStr8ts: more points is better. Ties share a rank. */
function leaderboard(playerId) {
  const sorted = [...rounds.values()].sort((a, b) => b.score - a.score);
  let rank = 0;
  let prev = null;
  return sorted.map((r, i) => {
    if (prev === null || r.score !== prev) rank = i + 1;
    prev = r.score;
    return {
      playerName: r.playerId === playerId ? "You" : r.playerName,
      score: r.score,
      rank,
      isYou: r.playerId === playerId,
    };
  });
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The game is served from another origin, so preflight has to be answered. */
function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function json(res, status, body) {
  cors(res);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        reject(new Error("invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "OPTIONS") {
    cors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    // Audit trail. Accepted and persisted before anything else can fail, so a
    // move that reached the server is a move that survives.
    if (req.method === "POST" && url.pathname === "/moves") {
      const body = await readBody(req);
      const moves = Array.isArray(body.moves) ? body.moves : [];
      if (moves.length === 0) return json(res, 200, { received: 0 });
      const received = new Date().toISOString();
      const lines = moves.map((m) => JSON.stringify({ ...m, received })).join("\n") + "\n";
      await appendFile(MOVES_LOG, lines);
      log(`moves +${moves.length} (${moves[0]?.playerId ?? "?"})`);
      return json(res, 200, { received: moves.length });
    }

    // A finished round: recorded for the standings, then forwarded to the
    // AS400. Recording first means a mainframe outage cannot cost us the
    // score — the record is on disk and the retry loop owns it from there.
    if (req.method === "POST" && url.pathname === "/round") {
      const body = await readBody(req);
      const { playerId, playerName, score, record } = body;
      if (typeof playerId !== "string" || typeof record !== "string") {
        return json(res, 400, { error: "playerId and record are required" });
      }

      const entry = {
        playerId,
        playerName: typeof playerName === "string" ? playerName : playerId,
        score: Number(score) || 0,
        record,
        received: new Date().toISOString(),
      };
      rounds.set(playerId, entry);
      await appendFile(ROUNDS_LOG, JSON.stringify(entry) + "\n");

      const result = await sendToAS400(record);
      if (!result.delivered && !result.permanent) undelivered.push(record);
      log(
        `round ${playerId} score=${entry.score} as400=${
          result.delivered ? "delivered" : result.permanent ? "rejected" : "queued"
        }`,
      );
      return json(res, 200, {
        recorded: true,
        as400Delivered: result.delivered,
        as400Pending: !result.delivered && !result.permanent,
      });
    }

    // Standings. This is the read path the AS400 cannot provide.
    if (req.method === "GET" && url.pathname === "/leaderboard") {
      return json(res, 200, { rows: leaderboard(url.searchParams.get("playerId") ?? "") });
    }

    if (req.method === "GET" && url.pathname === "/health") {
      return json(res, 200, {
        ok: true,
        rounds: rounds.size,
        as400Pending: undelivered.length,
      });
    }

    json(res, 404, { error: "not found" });
  } catch (err) {
    log(`error ${req.method} ${url.pathname}: ${err.message}`);
    json(res, 400, { error: err.message });
  }
});

/** Replay what previous runs recorded so a restart keeps the field intact. */
async function restore() {
  await mkdir(DATA_DIR, { recursive: true });
  try {
    const text = await readFile(ROUNDS_LOG, "utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line);
      rounds.set(entry.playerId, entry); // later lines win: newest round per player
    }
    log(`restored ${rounds.size} rounds from ${ROUNDS_LOG}`);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
}

await restore();
setInterval(() => void drainUndelivered(), 30_000).unref();

server.listen(PORT, () => {
  log(`relay listening on :${PORT}`);
  log(`  data     ${DATA_DIR}`);
  log(`  as400    ${AS400_URL}`);
});
