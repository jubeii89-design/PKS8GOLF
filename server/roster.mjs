/**
 * Player roster: who signed up, who paid, and what credentials they hold.
 *
 * Until now a player ID and PIN only had to *look* right — the game admitted
 * anyone whose input matched the format, because there was no list to check
 * against. This is that list. Signup mints the credentials, payment activates
 * them, and joining checks them.
 *
 * PINs are stored as a salted hash, never in the clear. The plaintext exists
 * exactly once, in the moment between generating it and putting it in the
 * player's email, and is never written to disk or logged. A roster file that
 * leaks therefore does not hand over the field's credentials.
 *
 * Storage matches the rest of the relay: append-only JSONL, replayed on boot.
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { randomBytes, randomInt, scryptSync, timingSafeEqual } from "node:crypto";
import { join } from "node:path";

/** Signed up but not paid — cannot join. */
export const PENDING = "pending";
/** Paid; credentials are live. */
export const PAID = "paid";

const SCRYPT_KEYLEN = 32;

export class Roster {
  #byPlayerId = new Map();
  #byOrderId = new Map();
  #byEmail = new Map();
  #file;

  constructor(dataDir) {
    this.#file = join(dataDir, "roster.jsonl");
  }

  /** Replay previous runs so a restart does not forget who paid. */
  async restore() {
    await mkdir(join(this.#file, ".."), { recursive: true });
    try {
      const text = await readFile(this.#file, "utf8");
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        this.#index(JSON.parse(line));
      }
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
    return this.size;
  }

  get size() {
    return this.#byPlayerId.size;
  }

  get paidCount() {
    let n = 0;
    for (const p of this.#byPlayerId.values()) if (p.status === PAID) n++;
    return n;
  }

  #index(entry) {
    this.#byPlayerId.set(entry.playerId, entry);
    if (entry.orderId) this.#byOrderId.set(entry.orderId, entry);
    if (entry.email) this.#byEmail.set(entry.email.toLowerCase(), entry);
  }

  async #persist(entry) {
    this.#index(entry);
    await appendFile(this.#file, JSON.stringify(entry) + "\n");
  }

  /**
   * Register a player. This reserves their ID but issues no PIN: a credential
   * that exists before payment is a credential that can be used before payment,
   * so the PIN is minted only when the money clears (see `issuePin`).
   */
  async signup({ name, email }) {
    const existing = this.#byEmail.get(String(email).toLowerCase());
    if (existing) return { ok: false, reason: "already-registered", playerId: existing.playerId };

    const entry = {
      playerId: this.#mintPlayerId(name),
      name: String(name).trim(),
      email: String(email).trim(),
      pinSalt: null,
      pinHash: null,
      status: PENDING,
      orderId: null,
      signedUpAt: new Date().toISOString(),
      paidAt: null,
    };
    await this.#persist(entry);
    return { ok: true, playerId: entry.playerId, entry };
  }

  /**
   * Mint the PIN, once payment has cleared.
   *
   * The plaintext is returned here and nowhere else — it is never written to
   * disk or logged, so the caller must put it straight into the player's email
   * and let it go. Only the hash is kept.
   *
   * Re-issuing replaces the old PIN, which is what you want if a player never
   * received their email and an organiser has to send it again.
   */
  async issuePin(playerId) {
    const entry = this.#byPlayerId.get(playerId);
    if (!entry) return null;
    const pin = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const pinSalt = randomBytes(16).toString("hex");
    const updated = {
      ...entry,
      pinSalt,
      pinHash: scryptSync(pin, pinSalt, SCRYPT_KEYLEN).toString("hex"),
    };
    await this.#persist(updated);
    return { pin, entry: updated };
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
      if (!this.#byPlayerId.has(candidate)) return candidate;
    }
    // Astronomically unlikely; fall back to something guaranteed unique.
    return randomBytes(8).toString("hex").toUpperCase().slice(0, 15);
  }

  /** Remember which Square order belongs to this player, so the webhook can find them. */
  async attachOrder(playerId, orderId) {
    const entry = this.#byPlayerId.get(playerId);
    if (!entry) return null;
    const updated = { ...entry, orderId };
    await this.#persist(updated);
    return updated;
  }

  /** Payment cleared: the credentials go live. Idempotent — Square retries webhooks. */
  async markPaid(orderId) {
    const entry = this.#byOrderId.get(orderId);
    if (!entry) return { ok: false, reason: "unknown-order" };
    if (entry.status === PAID) return { ok: true, alreadyPaid: true, entry };
    const updated = { ...entry, status: PAID, paidAt: new Date().toISOString() };
    await this.#persist(updated);
    return { ok: true, alreadyPaid: false, entry: updated };
  }

  get(playerId) {
    return this.#byPlayerId.get(playerId) ?? null;
  }

  /**
   * Check credentials at the door. Distinguishes the three real failures so
   * the player is told something useful instead of a generic refusal.
   */
  verify(playerId, pin) {
    const entry = this.#byPlayerId.get(String(playerId).trim());
    if (!entry) return { ok: false, reason: "unknown-player" };
    // Signed up but never paid, so no PIN was ever issued.
    if (!entry.pinHash) return { ok: false, reason: "not-paid" };

    const attempt = scryptSync(String(pin).trim(), entry.pinSalt, SCRYPT_KEYLEN);
    const stored = Buffer.from(entry.pinHash, "hex");
    if (attempt.length !== stored.length || !timingSafeEqual(attempt, stored)) {
      return { ok: false, reason: "wrong-pin" };
    }
    if (entry.status !== PAID) return { ok: false, reason: "not-paid" };
    return { ok: true, entry };
  }
}
