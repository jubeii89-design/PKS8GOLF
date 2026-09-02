#!/usr/bin/env node
/**
 * Tournament relay.
 *
 * The game is a static site and the AS400 is send-only: it accepts a record
 * when a round ends and never serves anything back. That leaves things a
 * player's phone cannot do on its own — deliver the per-move audit trail
 * anywhere, find out how the rest of the field is doing, or be trusted about
 * its own score. This server sits between the phones and the AS400 and does
 * all three, because every round passes through it on the way.
 *
 * What it gives you that the phone cannot:
 *   - Confirmed delivery. A browser sending cross-origin to the AS400 cannot
 *     read the response, so it never learns whether the record landed. Here
 *     the HTTP status is visible, so a failed record is retried, not lost.
 *   - Standings. Every finished round is a row; the field is what has arrived
 *     so far. No AS400 read path needed.
 *   - Somewhere for the audit trail to land, off the player's device.
 *   - An identity that cannot be forged: joining issues a signed token, and
 *     every later write is filed under whoever that token says they are.
 *
 * State lives in SQLite (db.mjs) — a real database with nothing to install,
 * which matters because mid-event you need to *ask* things ("who paid but
 * never played?") and not just append to a log.
 *
 * Run:
 *   node server/relay.mjs
 *   PORT=8080 DATA_DIR=/var/lib/pks8golf node server/relay.mjs
 *
 * Point the game at it at build time:
 *   VITE_RELAY_URL=https://relay.example.com npm run build
 */

import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { Db } from "./db.mjs";
import { Roster } from "./roster.mjs";
import * as square from "./square.mjs";
import * as email from "./email.mjs";
import { bearerFrom, issueToken, newRoundId, usingEphemeralSecret, verifyToken } from "./auth.mjs";

const PORT = Number(process.env.PORT ?? 8787);
const DATA_DIR = process.env.DATA_DIR ?? "./relay-data";
const AS400_URL = process.env.AS400_URL ?? "https://www.centriko.com/pgolfe/TNPKCGI1.pgm";
const QUERY_PARAM = "HDATASTREAM";
const RETRIES = 3;
const RETRY_BACKOFF_MS = 2000;
const AS400_TIMEOUT_MS = 30_000;
const DRAIN_INTERVAL_MS = 30_000;
/** Browsers may only send what the game actually sends; keeps junk out. */
const MAX_BODY_BYTES = 1_000_000;
/** PokerStr8ts. The tournament is one mode; practice is never reported. */
const TOURNAMENT_MODE = 0;

// --- the event itself. All of this belongs in config, not in the code. ---
const ENTRY_FEE_CENTS = Number(process.env.ENTRY_FEE_CENTS ?? 2500);
const CURRENCY = process.env.CURRENCY ?? "CAD";
const PLAY_URL = process.env.PLAY_URL ?? "https://www.strategictitans.ca/play/";
const TOURNAMENT = {
  name: process.env.TOURNAMENT_NAME ?? "Strategic Titans Charity Tournament",
  charity: process.env.TOURNAMENT_CHARITY ?? "our charity partner",
  date: process.env.TOURNAMENT_DATE ?? "To be announced",
  teeOff: process.env.TOURNAMENT_TEE_OFF ?? "To be announced",
  contact: process.env.TOURNAMENT_CONTACT ?? "www.strategictitans.ca",
};

const db = new Db(DATA_DIR);
const roster = new Roster(db);

const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// AS400 delivery
// ---------------------------------------------------------------------------

/**
 * Forward one record. Unlike the browser this can read the response, so a
 * failure is a fact rather than a guess.
 */
async function sendToAS400(record) {
  const url = `${AS400_URL}?${QUERY_PARAM}=${encodeURIComponent(record)}`;
  let lastError = "";
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(AS400_TIMEOUT_MS) });
      if (res.ok) return { delivered: true, status: res.status };
      // 4xx means the record itself is wrong; retrying cannot fix it.
      if (res.status >= 400 && res.status < 500) {
        return { delivered: false, permanent: true, error: `HTTP ${res.status}` };
      }
      lastError = `HTTP ${res.status}`;
      log(`as400 ${lastError}, attempt ${attempt}/${RETRIES}`);
    } catch (err) {
      lastError = err.name === "TimeoutError" ? "timeout" : err.message;
      log(`as400 ${lastError}, attempt ${attempt}/${RETRIES}`);
    }
    if (attempt < RETRIES) await sleep(RETRY_BACKOFF_MS * attempt);
  }
  return { delivered: false, permanent: false, error: lastError };
}

/** Queue a record and try it once now. The queue owns it from here. */
async function deliverRecord(roundId, record) {
  const id = db.queueRecord(roundId, record, new Date().toISOString());
  const result = await sendToAS400(record);
  if (result.delivered) {
    db.markDelivered(id, new Date().toISOString());
  } else if (result.permanent) {
    db.markRejected(id, result.error ?? "rejected");
  } else {
    db.recordAttempt(id, result.error ?? "unknown");
  }
  return result;
}

/**
 * Keep trying anything the AS400 has not taken. A tournament score is worth
 * more than the request that carried it, so a record is never dropped for
 * being inconvenient — only a hard 4xx rejection retires it.
 */
async function drainPending() {
  const pending = db.pendingRecords();
  for (const { id, record } of pending) {
    const result = await sendToAS400(record);
    if (result.delivered) {
      db.markDelivered(id, new Date().toISOString());
      log(`as400 delivered on retry: ${record.slice(0, 24)}...`);
    } else if (result.permanent) {
      db.markRejected(id, result.error ?? "rejected");
      log(`as400 rejected permanently, not retrying: ${record.slice(0, 24)}...`);
    } else {
      db.recordAttempt(id, result.error ?? "unknown");
    }
  }
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

/**
 * Payment cleared: mint the PIN and mail it out.
 *
 * A failure here is loud, because it is the worst quiet failure in the system
 * — the player has been charged and has no way to play. The PIN is
 * recoverable by re-issuing, so the fix is to send it again, not to refund.
 */
async function issueCredentials(entry) {
  const issued = roster.issuePin(entry.playerId);
  if (!issued) return { sent: false, reason: "unknown-player" };

  const result = await email.sendCredentials({
    to: entry.email,
    name: entry.name,
    playerId: entry.playerId,
    pin: issued.pin,
    tournament: TOURNAMENT,
    playUrl: PLAY_URL,
  });

  if (!result.sent) {
    log(
      `PAID BUT NOT EMAILED: ${entry.playerId} — ${result.reason}. ` +
        `They have paid and cannot play until someone re-issues their credentials.`,
    );
  }
  return result;
}

// ---------------------------------------------------------------------------
// Standings
// ---------------------------------------------------------------------------

/** PokerStr8ts: more points is better. Ties share a rank. */
function leaderboard(playerId) {
  const rows = db.leaderboard();
  let rank = 0;
  let prev = null;
  return rows.map((r, i) => {
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

/** The game is served from another origin, so preflight has to be answered. */
function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function json(res, status, body) {
  cors(res);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/**
 * The exact bytes sent. Square signs the raw body, so a webhook has to be
 * verified against this rather than against a re-serialised parse.
 */
function readRawBody(req) {
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
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function readBody(req) {
  const raw = await readRawBody(req);
  try {
    return JSON.parse(raw || "{}");
  } catch {
    throw new Error("invalid JSON");
  }
}

/** Enough of an address to be plausible; Square will reject a truly bad one. */
function looksLikeEmail(value) {
  return typeof value === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()) && value.length <= 254;
}

/**
 * Every write after the door has to prove it came from a real join.
 *
 * Returns the token's claims, or null having already answered the request.
 * The player a caller *claims* to be is ignored entirely: the identity used
 * downstream is the one inside the signed token, so a caller cannot act for
 * anyone but themselves even if they put another player's ID in the body.
 */
function requireSession(req, res) {
  const verdict = verifyToken(bearerFrom(req));
  if (!verdict.ok) {
    log(`write refused: ${verdict.reason}`);
    json(res, 401, { error: "not joined", reason: verdict.reason });
    return null;
  }
  return verdict.claims;
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
    // What a signup costs and what they are signing up for. Lets the signup
    // page show the real fee instead of hard-coding one that can drift.
    if (req.method === "GET" && url.pathname === "/tournament") {
      return json(res, 200, {
        tournament: TOURNAMENT,
        entryFeeCents: ENTRY_FEE_CENTS,
        currency: CURRENCY,
        acceptingSignups: square.isConfigured(),
      });
    }

    // Register a player and hand back a Square checkout page.
    //
    // Credentials are minted here but stay inert until payment clears, so a
    // signup abandoned at the checkout page cannot be used to play.
    if (req.method === "POST" && url.pathname === "/signup") {
      const body = await readBody(req);
      const name = typeof body.name === "string" ? body.name.trim() : "";
      const playerEmail = typeof body.email === "string" ? body.email.trim() : "";

      if (name.length < 2 || name.length > 60) return json(res, 400, { error: "Please give your full name." });
      if (!looksLikeEmail(playerEmail)) return json(res, 400, { error: "Please give a valid email address." });
      if (!square.isConfigured()) {
        return json(res, 503, { error: "Signups are not open yet — payment is not configured." });
      }

      const created = roster.signup({ name, email: playerEmail });
      if (!created.ok) {
        return json(res, 409, {
          error: "That email is already registered. Check your inbox for your Player ID and PIN.",
        });
      }

      let link;
      try {
        link = await square.createPaymentLink({
          playerId: created.playerId,
          name,
          email: playerEmail,
          amountCents: ENTRY_FEE_CENTS,
          currency: CURRENCY,
          redirectUrl: `${PLAY_URL}?signup=complete`,
        });
      } catch (err) {
        // The player exists but has no way to pay; say so rather than leaving
        // them at a dead end believing they are entered.
        log(`signup ${created.playerId}: square failed: ${err.message}`);
        return json(res, 502, { error: "Could not reach the payment provider. Please try again shortly." });
      }

      roster.attachOrder(created.playerId, link.orderId);
      log(`signup ${created.playerId} → checkout ${link.orderId}`);
      return json(res, 200, { playerId: created.playerId, checkoutUrl: link.url });
    }

    // Square telling us a payment cleared. Anyone can POST here, so nothing is
    // believed until the signature checks out.
    if (req.method === "POST" && url.pathname === "/webhooks/square") {
      const raw = await readRawBody(req);
      const verdict = square.verifyWebhook(raw, req.headers["x-square-hmacsha256-signature"]);
      if (!verdict.ok) {
        log(`webhook REJECTED (${verdict.reason})`);
        return json(res, 403, { error: "signature check failed" });
      }

      let event;
      try {
        event = JSON.parse(raw || "{}");
      } catch {
        return json(res, 400, { error: "invalid JSON" });
      }

      const orderId = square.completedPaymentOrderId(event);
      if (!orderId) return json(res, 200, { ignored: true }); // some other event type

      const paid = roster.markPaid(orderId);
      if (!paid.ok) {
        log(`webhook: completed payment for an order we do not know (${orderId})`);
        return json(res, 200, { ignored: true, reason: paid.reason });
      }
      // Square retries until it gets a 2xx, so a duplicate must not re-send mail.
      if (paid.alreadyPaid) return json(res, 200, { ok: true, duplicate: true });

      const issued = await issueCredentials(paid.entry);
      return json(res, 200, { ok: true, emailed: issued.sent });
    }

    // The door. Credentials are checked here and nowhere else, so this is
    // where a session begins and where the round's deck is decided.
    if (req.method === "POST" && url.pathname === "/join") {
      const body = await readBody(req);
      const verdict = roster.verify(body.playerId ?? "", body.pin ?? "");
      if (!verdict.ok) {
        log(`join refused for ${String(body.playerId).slice(0, 15)}: ${verdict.reason}`);
        return json(res, 200, { ok: false, reason: verdict.reason, teeTime: verdict.teeTime });
      }

      // The deck is the server's to choose. Issuing it here — and signing it
      // into the token — is what stops a player re-joining until they like
      // the cards, and it is what lets the server replay the round later.
      const roundId = newRoundId();
      const seed = randomBytes(16).toString("hex");
      db.startRound({
        roundId,
        playerId: verdict.entry.playerId,
        seed,
        mode: TOURNAMENT_MODE,
        startedAt: new Date().toISOString(),
      });

      const token = issueToken({ playerId: verdict.entry.playerId, roundId, extra: { seed } });
      log(`join ${verdict.entry.playerId} round ${roundId}`);
      return json(res, 200, {
        ok: true,
        playerId: verdict.entry.playerId,
        playerName: verdict.entry.name,
        token,
        seed,
        roundId,
      });
    }

    // Audit trail. Filed under the token's player and round, whatever the
    // payload claims, and de-duplicated so a retried flush is harmless.
    if (req.method === "POST" && url.pathname === "/moves") {
      const session = requireSession(req, res);
      if (!session) return;

      const body = await readBody(req);
      const moves = Array.isArray(body.moves) ? body.moves : [];
      if (moves.length === 0) return json(res, 200, { received: 0 });

      const receivedAt = new Date().toISOString();
      const inserted = db.insertMoves(
        moves.map((m) => ({
          roundId: session.roundId,
          playerId: session.playerId,
          seq: m.seq,
          action: m.action,
          card: m.card,
          cell: m.cell,
          scoreAfter: m.scoreAfter,
          ts: m.ts,
          receivedAt,
        })),
      );
      log(`moves +${inserted} (${session.playerId})`);
      return json(res, 200, { received: moves.length, stored: inserted });
    }

    // A finished round: recorded for the standings, then forwarded to the
    // AS400. Recording first means a mainframe outage cannot cost us the
    // score — it is in the database and the retry loop owns it from there.
    if (req.method === "POST" && url.pathname === "/round") {
      const session = requireSession(req, res);
      if (!session) return;

      const body = await readBody(req);
      const { score, record } = body;
      if (typeof record !== "string") return json(res, 400, { error: "record is required" });

      const round = db.round(session.roundId);
      if (!round) return json(res, 409, { error: "unknown round" });
      if (round.finished_at) return json(res, 200, { recorded: true, duplicate: true });

      db.finishRound({
        roundId: session.roundId,
        score: Number(score) || 0,
        record,
        finishedAt: new Date().toISOString(),
        scoreSource: "client",
      });

      const result = await deliverRecord(session.roundId, record);
      log(
        `round ${session.playerId} score=${Number(score) || 0} as400=${
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
      const counts = db.playerCounts();
      return json(res, 200, {
        ok: true,
        registered: counts.total,
        paid: counts.paid,
        as400Pending: db.pendingCount(),
        square: square.isConfigured() ? square.environment() : "not-configured",
        webhooksVerifiable: square.canVerifyWebhooks(),
        email: email.isConfigured() ? "smtp" : "console-only",
      });
    }

    json(res, 404, { error: "not found" });
  } catch (err) {
    log(`error ${req.method} ${url.pathname}: ${err.message}`);
    json(res, 400, { error: err.message });
  }
});

setInterval(() => void drainPending(), DRAIN_INTERVAL_MS).unref();

server.listen(PORT, () => {
  const counts = db.playerCounts();
  log(`relay listening on :${PORT}`);
  log(`  data     ${DATA_DIR}/tournament.db`);
  log(`  as400    ${AS400_URL}`);
  log(`  roster   ${counts.total} registered, ${counts.paid} paid`);
  log(`  square   ${square.isConfigured() ? square.environment() : "NOT CONFIGURED — signups closed"}`);
  log(`  email    ${email.isConfigured() ? "smtp" : "NOT CONFIGURED — credentials will not be sent"}`);
  if (square.isConfigured() && !square.canVerifyWebhooks()) {
    log(`  WARNING  no webhook key/url set — payment confirmations cannot be trusted and will be refused`);
  }
  if (usingEphemeralSecret()) {
    log(`  WARNING  SESSION_SECRET unset — a random one is in use, so restarting ejects players mid-round`);
  }
});
