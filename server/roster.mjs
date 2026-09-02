/**
 * Player roster: who signed up, who paid, and what credentials they hold.
 *
 * Until signup existed, a player ID and PIN only had to *look* right — the
 * game admitted anyone whose input matched the format, because there was no
 * list to check against. This is that list. Signup mints the ID, payment
 * activates it, and joining checks it.
 *
 * PINs are stored as a salted hash, never in the clear. The plaintext exists
 * exactly once, between minting it and putting it in the player's email, and
 * is never written to disk or logged. A database that leaks therefore does not
 * hand over the field's credentials.
 *
 * State lives in SQLite (see db.mjs) so it can be queried, not just appended.
 */

import { randomBytes, randomInt, scryptSync, timingSafeEqual } from "node:crypto";

/** Signed up but not paid — cannot join. */
export const PENDING = "pending";
/** Paid; credentials are live. */
export const PAID = "paid";

const SCRYPT_KEYLEN = 32;

export class Roster {
  #db;

  constructor(db) {
    this.#db = db;
  }

  get size() {
    return this.#db.playerCounts().total;
  }

  get paidCount() {
    return this.#db.playerCounts().paid;
  }

  /**
   * Register a player. This reserves their ID but issues no PIN: a credential
   * that exists before payment is a credential that can be used before
   * payment, so the PIN is minted only when the money clears (see `issuePin`).
   */
  signup({ name, email, teeTime = null }) {
    const existing = this.#db.playerByEmail(String(email).trim());
    if (existing) return { ok: false, reason: "already-registered", playerId: existing.player_id };

    const entry = {
      playerId: this.#mintPlayerId(name),
      name: String(name).trim(),
      email: String(email).trim(),
      status: PENDING,
      signedUpAt: new Date().toISOString(),
      teeTime,
    };
    this.#db.insertPlayer(entry);
    return { ok: true, playerId: entry.playerId, entry };
  }

  /**
   * A 15-character alphanumeric ID in the shape the AS400 record expects —
   * the player's name, uppercased and stripped, with a sequence number so two
   * people called Gordon Stitt do not collide.
   */
  #mintPlayerId(name) {
    const base = String(name).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 11) || "PLAYER";
    for (let n = 1; n < 10_000; n++) {
      const candidate = (base + String(n).padStart(15 - base.length, "0")).slice(0, 15);
      if (!this.#db.playerIdExists(candidate)) return candidate;
    }
    // Astronomically unlikely; fall back to something guaranteed unique.
    return randomBytes(8).toString("hex").toUpperCase().slice(0, 15);
  }

  /** Remember which Square order belongs to this player, so the webhook can find them. */
  attachOrder(playerId, orderId) {
    this.#db.attachOrder(playerId, orderId);
    return this.#db.playerById(playerId);
  }

  /** Payment cleared: the credentials go live. Idempotent — Square retries webhooks. */
  markPaid(orderId) {
    const player = this.#db.playerByOrder(orderId);
    if (!player) return { ok: false, reason: "unknown-order" };
    if (player.status === PAID) return { ok: true, alreadyPaid: true, entry: toEntry(player) };
    this.#db.markPaid(player.player_id, new Date().toISOString());
    return { ok: true, alreadyPaid: false, entry: toEntry(this.#db.playerById(player.player_id)) };
  }

  /**
   * Mint the PIN, once payment has cleared.
   *
   * The plaintext is returned here and nowhere else — never written to disk or
   * logged — so the caller must put it straight into the player's email and
   * let it go. Only the hash is kept.
   *
   * Re-issuing replaces the old PIN, which is what you want when a player
   * never received their email and an organiser has to send it again.
   */
  issuePin(playerId) {
    const player = this.#db.playerById(playerId);
    if (!player) return null;
    const pin = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const pinSalt = randomBytes(16).toString("hex");
    this.#db.setPin(playerId, pinSalt, scryptSync(pin, pinSalt, SCRYPT_KEYLEN).toString("hex"));
    return { pin, entry: toEntry(this.#db.playerById(playerId)) };
  }

  get(playerId) {
    const player = this.#db.playerById(playerId);
    return player ? toEntry(player) : null;
  }

  /**
   * Check credentials at the door. The failures are distinguished so a player
   * can be told something useful instead of a flat refusal.
   *
   * `now` is injectable so the tee-off cutoff is testable without waiting.
   */
  verify(playerId, pin, now = Date.now()) {
    const player = this.#db.playerById(String(playerId).trim());
    if (!player) return { ok: false, reason: "unknown-player" };
    // Signed up but never paid, so no PIN was ever issued.
    if (!player.pin_hash) return { ok: false, reason: "not-paid" };

    const attempt = scryptSync(String(pin).trim(), player.pin_salt, SCRYPT_KEYLEN);
    const stored = Buffer.from(player.pin_hash, "hex");
    if (attempt.length !== stored.length || !timingSafeEqual(attempt, stored)) {
      return { ok: false, reason: "wrong-pin" };
    }
    if (player.status !== PAID) return { ok: false, reason: "not-paid" };

    // A tee time is a deadline to have started by, not a window to sit inside:
    // arriving late means the field has moved on. No tee time means no cutoff.
    if (player.tee_time && now > Date.parse(player.tee_time)) {
      return { ok: false, reason: "missed-tee-time", teeTime: player.tee_time };
    }
    return { ok: true, entry: toEntry(player) };
  }
}

/** Database row → the shape the rest of the server speaks. */
function toEntry(row) {
  if (!row) return null;
  return {
    playerId: row.player_id,
    name: row.name,
    email: row.email,
    status: row.status,
    orderId: row.order_id,
    teeTime: row.tee_time,
    signedUpAt: row.signed_up_at,
    paidAt: row.paid_at,
  };
}
