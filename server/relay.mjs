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
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { Db } from "./db.mjs";
import { Roster } from "./roster.mjs";
import * as square from "./square.mjs";
import * as email from "./email.mjs";
import {
  bearerFrom, issueClaimToken, issueToken, newRoundId, PURPOSE_CLAIM,
  usingEphemeralSecret, verifyToken,
} from "./auth.mjs";
import { deriveRound } from "./replay.mjs";

const PORT = Number(process.env.PORT ?? 8787);
const DATA_DIR = process.env.DATA_DIR ?? "./relay-data";
const AS400_URL = process.env.AS400_URL ?? "https://www.centriko.com/pgolfe/TNPKCGI1.pgm";
const QUERY_PARAM = "HDATASTREAM";
const RETRIES = 3;
const RETRY_BACKOFF_MS = 2000;
const AS400_TIMEOUT_MS = 30_000;
const DRAIN_INTERVAL_MS = 30_000;
/**
 * How long a finishing player will wait on the mainframe before the queue
 * takes over. Short enough not to be felt, long enough that a healthy AS400
 * (~350ms under load) almost always answers inside it.
 */
const FIRST_ATTEMPT_TIMEOUT_MS = 2_000;
/** Browsers may only send what the game actually sends; keeps junk out. */
const MAX_BODY_BYTES = 1_000_000;
/** PokerStr8ts. The tournament is one mode; practice is never reported. */
const TOURNAMENT_MODE = 0;
/**
 * Which mode's score goes in the AS400 record.
 *
 * "poker" sends the points the leaderboard shows. "golf" scores the same
 * finished board as strokes instead — which is what the supplied sample and
 * its bogey language suggest the field actually wants, since golf strokes run
 * 88-103 and are never negative while points go negative in a third of rounds.
 * Unconfirmed, so the default preserves existing behaviour.
 */
const AS400_SCORE_MODE = (process.env.AS400_SCORE_MODE ?? "poker").toLowerCase() === "golf" ? 1 : 0;
/** How a negative score is written; see NegativeConvention in as400Record.ts. */
const AS400_NEGATIVE = process.env.AS400_NEGATIVE ?? "abs";

// --- the event itself. All of this belongs in config, not in the code. ---
const ENTRY_FEE_CENTS = Number(process.env.ENTRY_FEE_CENTS ?? 2500);
const CURRENCY = process.env.CURRENCY ?? "CAD";
const PLAY_URL = process.env.PLAY_URL ?? "https://www.strategictitans.ca/play/";
/**
 * The moment after which nobody new may start. One deadline for the whole
 * field, which is what a shotgun-start charity event actually runs on. Unset
 * means no cutoff at all — playable any time, which is the safe default for a
 * date that has not been fixed yet.
 */
const TEE_OFF_AT = process.env.TEE_OFF_AT ?? "";
/** Guards the credential re-issue endpoint. Unset leaves it closed. */
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? "";
/**
 * Which sites may call this relay from a browser.
 *
 * Comma-separated origins, e.g. "https://www.strategictitans.ca". Left unset
 * it allows any origin, which is the right default while the signup page and
 * the game are still moving around — but once their homes are fixed, naming
 * them means a stranger's page cannot drive signups and create real Square
 * orders on your account.
 */
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

/** Each signup creates a real Square order, so the endpoint is worth limiting. */
const SIGNUP_LIMIT = Number(process.env.SIGNUP_LIMIT ?? 5);
const SIGNUP_WINDOW_MS = 10 * 60 * 1000;

/**
 * Wrong PINs tolerated per player before the door closes on them.
 *
 * A PIN is six digits and player IDs are guessable from a name, so without a
 * limit an entry can simply be ground out — measured at ~23 tries a second
 * against one player, which is a matter of hours, less in parallel. Locking
 * the *player* rather than the address is what actually helps: an attacker
 * has many addresses but only one target.
 *
 * The cost is that someone can be locked out by a stranger guessing at them,
 * so the window is short and an organiser can clear it.
 */
const PIN_ATTEMPT_LIMIT = Number(process.env.PIN_ATTEMPT_LIMIT ?? 10);
const PIN_LOCKOUT_MS = Number(process.env.PIN_LOCKOUT_MS ?? 15 * 60 * 1000);

const TOURNAMENT = {
  name: process.env.TOURNAMENT_NAME ?? "Strategic Titans Charity Tournament",
  charity: process.env.TOURNAMENT_CHARITY ?? "our charity partner",
  date: process.env.TOURNAMENT_DATE ?? "To be announced",
  teeOff: process.env.TOURNAMENT_TEE_OFF ?? "To be announced",
  contact: process.env.TOURNAMENT_CONTACT ?? "www.strategictitans.ca",
};

/**
 * How long a freshly minted PIN stays claimable after payment. Long enough to
 * cover a slow redirect and a distracted player, short enough that it is not
 * sitting around.
 */
const CLAIM_HOLD_MS = 30 * 60 * 1000;

/**
 * How often the database is snapshotted, and how many snapshots are kept.
 *
 * Everything the event owns lives in one file. Losing it loses the roster,
 * the record of who paid, and every score — so it is copied aside regularly
 * while the event runs. Set BACKUP_DIR to somewhere on different storage;
 * a backup on the same disk only survives the failures that were not the disk.
 */
const BACKUP_DIR = process.env.BACKUP_DIR ?? "";
const BACKUP_INTERVAL_MS = Number(process.env.BACKUP_INTERVAL_MS ?? 5 * 60 * 1000);
const BACKUP_KEEP = Number(process.env.BACKUP_KEEP ?? 12);

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
async function sendToAS400(record, { attempts = RETRIES, timeoutMs = AS400_TIMEOUT_MS } = {}) {
  const url = `${AS400_URL}?${QUERY_PARAM}=${encodeURIComponent(record)}`;
  let lastError = "";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok) return { delivered: true, status: res.status };
      // 4xx means the record itself is wrong; retrying cannot fix it.
      if (res.status >= 400 && res.status < 500) {
        return { delivered: false, permanent: true, error: `HTTP ${res.status}` };
      }
      lastError = `HTTP ${res.status}`;
      log(`as400 ${lastError}, attempt ${attempt}/${attempts}`);
    } catch (err) {
      lastError = err.name === "TimeoutError" ? "timeout" : err.message;
      log(`as400 ${lastError}, attempt ${attempt}/${attempts}`);
    }
    if (attempt < attempts) await sleep(RETRY_BACKOFF_MS * attempt);
  }
  return { delivered: false, permanent: false, error: lastError };
}

/**
 * Hand a record to the queue and give it one quick attempt.
 *
 * A player must never wait on the mainframe. Measured with 100 concurrent
 * rounds, a healthy AS400 answers in ~350ms but an unreachable one dragged
 * every submission to 6s — because the full retry ladder ran before the
 * player got a reply. Their score was already safe in the database by then;
 * they were queuing for nothing.
 *
 * So the record is queued first, then given a single attempt with a short
 * deadline. If that misses, it stays queued and the drain loop keeps at it
 * with the full retry ladder in the background. The player finds out quickly
 * either way, and a mainframe outage costs them a caption, not a wait.
 */
async function deliverRecord(roundId, record) {
  const id = db.queueRecord(roundId, record, new Date().toISOString());
  const result = await sendToAS400(record, { attempts: 1, timeoutMs: FIRST_ATTEMPT_TIMEOUT_MS });
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
// Backups
// ---------------------------------------------------------------------------

/** Snapshot the database, then drop all but the most recent BACKUP_KEEP. */
async function takeBackup() {
  if (!BACKUP_DIR) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = join(BACKUP_DIR, `tournament-${stamp}.db`);
  try {
    await mkdir(BACKUP_DIR, { recursive: true });
    db.backupTo(target);

    const kept = (await readdir(BACKUP_DIR))
      .filter((f) => f.startsWith("tournament-") && f.endsWith(".db"))
      .sort()
      .reverse();
    for (const stale of kept.slice(BACKUP_KEEP)) {
      await rm(join(BACKUP_DIR, stale), { force: true });
    }
    log(`backup written: ${target} (keeping ${Math.min(kept.length, BACKUP_KEEP)})`);
  } catch (err) {
    // Loud, because a backup that is quietly not happening is worse than none:
    // you would be relying on it.
    log(`BACKUP FAILED: ${err.message} — the tournament data has no recent copy`);
  }
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

/**
 * PINs waiting to be collected from the payment-return screen.
 *
 * Email is one delivery path and it fails in ordinary ways — a typo, a spam
 * folder, a bounce — leaving someone who has paid unable to play. Showing the
 * credentials when Square sends them back gives a second, independent path.
 *
 * Held in memory only, never written to the database, and dropped after
 * CLAIM_HOLD_MS. That keeps the property that matters: a leaked database still
 * does not hand over the field's credentials, because the plaintext was never
 * in it. A restart loses these, and the email remains the fallback.
 */
const claimable = new Map();

function holdForClaim(playerId, pin) {
  claimable.set(playerId, { pin, expiresAt: Date.now() + CLAIM_HOLD_MS });
}

function takeClaim(playerId) {
  const held = claimable.get(playerId);
  if (!held) return null;
  if (held.expiresAt < Date.now()) {
    claimable.delete(playerId);
    return null;
  }
  return held.pin;
}

/** Drop anything nobody came back for, so this cannot grow unbounded. */
setInterval(() => {
  const now = Date.now();
  for (const [playerId, held] of claimable) {
    if (held.expiresAt < now) claimable.delete(playerId);
  }
}, CLAIM_HOLD_MS).unref();

/**
 * Payment cleared: mint the PIN and mail it out.
 *
 * A failure here is loud, because it is the worst quiet failure in the system
 * — the player has been charged and has no way to play. The PIN is
 * recoverable by re-issuing, so the fix is to send it again, not to refund.
 */
async function issueCredentials(entry) {
  const issued = await roster.issuePin(entry.playerId);
  if (!issued) return { sent: false, reason: "unknown-player" };

  // Collectable from the payment-return screen for a short while, so a failed
  // email is no longer the difference between playing and not.
  holdForClaim(entry.playerId, issued.pin);

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
function cors(res, req) {
  const origin = req?.headers?.origin;
  // With an allowlist, echo the caller's origin only when it is on it —
  // answering "*" would defeat the point of having one.
  if (ALLOWED_ORIGINS.length > 0) {
    if (origin && ALLOWED_ORIGINS.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function json(res, status, body) {
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

/**
 * A crude per-address limit on signups.
 *
 * In memory rather than in the database because it is a courtesy, not a
 * security boundary — anyone determined has more addresses. It exists so a
 * stuck retry loop or a bored visitor cannot fill your Square dashboard with
 * abandoned orders.
 */
const signupAttempts = new Map();

function signupAllowed(ip) {
  const now = Date.now();
  const recent = (signupAttempts.get(ip) ?? []).filter((t) => now - t < SIGNUP_WINDOW_MS);
  if (recent.length >= SIGNUP_LIMIT) {
    signupAttempts.set(ip, recent);
    return false;
  }
  recent.push(now);
  signupAttempts.set(ip, recent);
  return true;
}

/**
 * Failed PIN attempts per player. In memory rather than the database because
 * a lockout should not outlive a restart — on tournament morning, a relay
 * restart clearing a lockout is the failure mode you want, not the one that
 * strands a paid-up player.
 */
const pinFailures = new Map();

function pinLockedOut(playerId, now = Date.now()) {
  const rec = pinFailures.get(playerId);
  if (!rec) return false;
  if (now - rec.first > PIN_LOCKOUT_MS) {
    pinFailures.delete(playerId);
    return false;
  }
  return rec.count >= PIN_ATTEMPT_LIMIT;
}

function notePinFailure(playerId, now = Date.now()) {
  const rec = pinFailures.get(playerId);
  if (!rec || now - rec.first > PIN_LOCKOUT_MS) pinFailures.set(playerId, { count: 1, first: now });
  else rec.count++;
}

/** A correct PIN clears the record — an honest fumble should not accumulate. */
function clearPinFailures(playerId) {
  pinFailures.delete(playerId);
}

/** Behind a reverse proxy the real address is in the forwarded header. */
function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length > 0) return fwd.split(",")[0].trim();
  return req.socket.remoteAddress ?? "unknown";
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
  // Applied to every response, including errors — a reply the browser refuses
  // to read is the same as no reply at all.
  cors(res, req);

  if (req.method === "OPTIONS") {
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

      if (!signupAllowed(clientIp(req))) {
        return json(res, 429, { error: "Too many attempts. Please wait a few minutes and try again." });
      }
      if (name.length < 2 || name.length > 60) return json(res, 400, { error: "Please give your full name." });
      if (!looksLikeEmail(playerEmail)) return json(res, 400, { error: "Please give a valid email address." });
      if (!square.isConfigured()) {
        return json(res, 503, { error: "Signups are not open yet — payment is not configured." });
      }

      const created = roster.signup({ name, email: playerEmail, teeTime: TEE_OFF_AT || null });
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
          // Signed, and good for nothing but collecting these credentials —
          // a bare player id here would let anyone harvest PINs by guessing.
          redirectUrl: `${PLAY_URL}?claim=${encodeURIComponent(issueClaimToken(created.playerId))}`,
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

    // Collect credentials after paying.
    //
    // The player is sent here by Square with a signed ticket. It races the
    // webhook that confirms the payment, and usually loses — so "not paid yet"
    // is a normal answer the page polls on, not a failure.
    if (req.method === "POST" && url.pathname === "/claim") {
      const body = await readBody(req);
      const verdict = verifyToken(String(body.claim ?? ""), PURPOSE_CLAIM);
      if (!verdict.ok) {
        log(`claim refused: ${verdict.reason}`);
        return json(res, 403, { error: "invalid claim", reason: verdict.reason });
      }

      const player = roster.get(verdict.claims.playerId);
      if (!player) return json(res, 404, { error: "unknown player" });
      if (player.status !== "paid") {
        // Square has not told us yet. Nothing is wrong; ask again shortly.
        return json(res, 200, { paid: false, playerId: player.playerId, name: player.name });
      }

      const pin = takeClaim(player.playerId);
      log(`claim ${player.playerId} (pin ${pin ? "shown" : "expired — email only"})`);
      return json(res, 200, {
        paid: true,
        playerId: player.playerId,
        name: player.name,
        // Absent once the hold has lapsed or the relay restarted. The page says
        // to use the email rather than pretending something went wrong.
        pin: pin ?? undefined,
        teeTime: player.teeTime,
        tournament: TOURNAMENT,
      });
    }

    // The door. Credentials are checked here and nowhere else, so this is
    // where a session begins and where the round's deck is decided.
    if (req.method === "POST" && url.pathname === "/join") {
      const body = await readBody(req);
      const attemptedId = String(body.playerId ?? "").trim().slice(0, 15);

      // Refuse before hashing: otherwise the lockout still costs a scrypt per
      // attempt, and the attacker gets to burn our CPU for free.
      if (pinLockedOut(attemptedId)) {
        log(`join refused for ${attemptedId}: locked out after ${PIN_ATTEMPT_LIMIT} wrong PINs`);
        return json(res, 429, { ok: false, reason: "too-many-attempts" });
      }

      const verdict = await roster.verify(body.playerId ?? "", body.pin ?? "");
      if (!verdict.ok) {
        // Only a wrong PIN counts. An unknown player or an unpaid one is not
        // someone guessing at a credential, and a missed tee-off is not their
        // fault at all.
        if (verdict.reason === "wrong-pin") notePinFailure(attemptedId);
        log(`join refused for ${attemptedId}: ${verdict.reason}`);
        return json(res, 200, { ok: false, reason: verdict.reason, teeTime: verdict.teeTime });
      }
      clearPinFailures(attemptedId);

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

      // The record the AS400 wants includes the PIN, which is only ever stored
      // hashed — so the verified PIN rides along in the signed token. It is not
      // a new disclosure (the player just typed it) and it never reaches disk.
      const token = issueToken({
        playerId: verdict.entry.playerId,
        roundId,
        extra: { seed, pin: String(body.pin ?? "").trim() },
      });
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
      const claimedScore = typeof body.score === "number" ? body.score : null;

      const round = db.round(session.roundId);
      if (!round) return json(res, 409, { error: "unknown round" });
      if (round.finished_at) {
        return json(res, 200, { recorded: true, duplicate: true, score: round.score });
      }

      // Anything the client still had buffered belongs to this round.
      if (Array.isArray(body.moves) && body.moves.length > 0) {
        const receivedAt = new Date().toISOString();
        db.insertMoves(
          body.moves.map((m) => ({
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
      }

      // The score is derived, never accepted. The client's figure is compared
      // and kept as evidence, but it decides nothing.
      const derived = deriveRound({
        seed: round.seed,
        mode: round.mode,
        moves: db.movesForRound(session.roundId),
        playerId: session.playerId,
        pin: session.pin ?? "",
        claimedScore,
        reportMode: AS400_SCORE_MODE,
        negatives: AS400_NEGATIVE,
      });

      if (!derived.ok) {
        // A round that will not replay cannot be scored. It is left open and
        // logged rather than guessed at, because guessing is how a wrong score
        // reaches the mainframe.
        log(`round ${session.playerId} WILL NOT REPLAY: ${derived.reason} at seq ${derived.atSeq ?? "?"}`);
        return json(res, 422, { error: "round could not be verified", reason: derived.reason });
      }

      if (!derived.agrees) {
        log(
          `round ${session.playerId} SCORE MISMATCH: client claimed ${claimedScore}, ` +
            `replay says ${derived.round} — the replay stands`,
        );
      }
      // A negative score written as its magnitude reaches the mainframe as a
      // positive one. Say so per player rather than letting it pass quietly —
      // the database keeps the true score, so it can be reconciled.
      if (derived.reportedScore < 0 && AS400_NEGATIVE === "abs") {
        log(
          `round ${session.playerId} NEGATIVE SCORE ${derived.reportedScore} SENT AS ` +
            `"${String(Math.abs(derived.reportedScore)).padStart(3, "0")}" — the AS400 will read it as ` +
            `positive. Set AS400_NEGATIVE once the convention is known.`,
        );
      }
      if (derived.cardMismatches > 0) {
        log(`round ${session.playerId}: ${derived.cardMismatches} move(s) named a card the deck did not deal`);
      }

      db.finishRound({
        roundId: session.roundId,
        score: derived.round,
        record: derived.record,
        finishedAt: new Date().toISOString(),
        scoreSource: "derived",
      });

      const result = await deliverRecord(session.roundId, derived.record);
      log(
        `round ${session.playerId} score=${derived.round} (derived from ${derived.movesApplied} moves) as400=${
          result.delivered ? "delivered" : result.permanent ? "rejected" : "queued"
        }`,
      );
      return json(res, 200, {
        recorded: true,
        score: derived.round,
        verified: true,
        as400Delivered: result.delivered,
        as400Pending: !result.delivered && !result.permanent,
      });
    }

    // Re-send a paid player's credentials.
    //
    // The counterpart to the PAID BUT NOT EMAILED log line: without this, a
    // player whose email failed has been charged and cannot play, and the only
    // remedy would be editing the database by hand during the event.
    if (req.method === "POST" && url.pathname === "/admin/reissue") {
      if (ADMIN_TOKEN === "" || bearerFrom(req) !== ADMIN_TOKEN) {
        return json(res, 403, { error: "forbidden" });
      }
      const body = await readBody(req);
      const player = roster.get(String(body.playerId ?? "").trim());
      if (!player) return json(res, 404, { error: "unknown player" });
      if (player.status !== "paid") return json(res, 409, { error: "player has not paid" });

      // Issues a fresh PIN and invalidates the old one, which is what you want:
      // if the first email went astray, it should stop working.
      const issued = await issueCredentials(player);
      log(`admin re-issued credentials for ${player.playerId} (emailed=${issued.sent})`);
      return json(res, 200, { ok: true, emailed: issued.sent, reason: issued.reason });
    }

    // Clear a lockout, for the player who fumbled their own PIN ten times or
    // was locked out by someone else guessing at them.
    if (req.method === "POST" && url.pathname === "/admin/unlock") {
      if (ADMIN_TOKEN === "" || bearerFrom(req) !== ADMIN_TOKEN) {
        return json(res, 403, { error: "forbidden" });
      }
      const body = await readBody(req);
      const playerId = String(body.playerId ?? "").trim();
      const wasLocked = pinLockedOut(playerId);
      clearPinFailures(playerId);
      log(`admin cleared PIN lockout for ${playerId} (was ${wasLocked ? "locked" : "not locked"})`);
      return json(res, 200, { ok: true, wasLocked });
    }

    // Who needs attention: paid but never got a PIN, or paid but never played.
    if (req.method === "GET" && url.pathname === "/admin/attention") {
      if (ADMIN_TOKEN === "" || bearerFrom(req) !== ADMIN_TOKEN) {
        return json(res, 403, { error: "forbidden" });
      }
      return json(res, 200, {
        paidButNoPin: db.paidButNoPin(),
        paidButNeverPlayed: db.paidButNeverPlayed(),
        as400Pending: db.pendingCount(),
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
if (BACKUP_DIR) {
  void takeBackup(); // one immediately, so a misconfiguration is found now
  setInterval(() => void takeBackup(), BACKUP_INTERVAL_MS).unref();
}

server.listen(PORT, () => {
  const counts = db.playerCounts();
  log(`relay listening on :${PORT}`);
  log(`  data     ${DATA_DIR}/tournament.db`);
  log(`  as400    ${AS400_URL}`);
  log(`  roster   ${counts.total} registered, ${counts.paid} paid`);
  log(`  square   ${square.isConfigured() ? square.environment() : "NOT CONFIGURED — signups closed"}`);
  log(`  email    ${email.isConfigured() ? "smtp" : "NOT CONFIGURED — credentials will not be sent"}`);
  log(`  tee-off  ${TEE_OFF_AT || "no cutoff — players may start any time"}`);
  log(`  admin    ${ADMIN_TOKEN ? "enabled" : "disabled — set ADMIN_TOKEN to re-issue credentials"}`);
  log(`  origins  ${ALLOWED_ORIGINS.length > 0 ? ALLOWED_ORIGINS.join(", ") : "any (set ALLOWED_ORIGINS to restrict)"}`);
  log(`  backups  ${BACKUP_DIR ? `${BACKUP_DIR} every ${BACKUP_INTERVAL_MS / 60000}min, keeping ${BACKUP_KEEP}` : "NONE — set BACKUP_DIR"}`);
  log(`  as400    reporting ${AS400_SCORE_MODE === 1 ? "GOLF strokes" : "POKER points"}, negatives=${AS400_NEGATIVE}`);
  if (square.isConfigured() && !square.canVerifyWebhooks()) {
    log(`  WARNING  no webhook key/url set — payment confirmations cannot be trusted and will be refused`);
  }
  if (usingEphemeralSecret()) {
    log(`  WARNING  SESSION_SECRET unset — a random one is in use, so restarting ejects players mid-round`);
  }
});
