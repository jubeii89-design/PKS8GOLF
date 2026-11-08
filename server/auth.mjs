/**
 * Session tokens.
 *
 * Joining is the only place credentials are checked. Everything after it —
 * streaming moves, finishing a round — has to prove it belongs to that same
 * join, or anyone who knows the endpoint can post whatever they like on
 * anyone's behalf.
 *
 * The token carries its own proof: the payload is signed with a server secret,
 * so verifying it is pure computation. That means no session table to keep, no
 * cleanup of expired rows, and tokens that still work after the relay
 * restarts — which matters mid-event, when a restart must not eject the field.
 *
 * It is deliberately not a general-purpose auth system. It answers exactly one
 * question: did the holder of this token pass the door as this player, for
 * this round, recently enough to still be playing?
 */

import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

/**
 * A round is long but not unbounded. Long enough that a slow player is never
 * timed out mid-hand; short enough that a leaked token is not useful tomorrow.
 */
export const TOKEN_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * A claim token lives longer than a round: it is handed out at checkout and a
 * player may not open the link until later the same day.
 */
export const CLAIM_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * What a token is allowed to do.
 *
 * Both kinds are signed with the same key, so without this a claim token —
 * which is handed out in a URL and therefore lands in browser history, logs
 * and shoulder-view — would also be a valid ticket to submit scores. Every
 * verification names the purpose it expects.
 */
export const PURPOSE_SESSION = "session";
export const PURPOSE_CLAIM = "claim";

const CONFIGURED_SECRET = process.env.SESSION_SECRET ?? "";
/**
 * Falling back to a random secret keeps the relay runnable without setup, at
 * the cost of invalidating live tokens on restart. The caller warns about it;
 * silently inventing a secret and pretending nothing is different would be
 * worse than saying so.
 */
const SECRET = CONFIGURED_SECRET || randomBytes(32).toString("hex");

export function usingEphemeralSecret() {
  return CONFIGURED_SECRET === "";
}

const b64url = (buf) => Buffer.from(buf).toString("base64url");

function sign(payloadB64) {
  return createHmac("sha256", SECRET).update(payloadB64).digest("base64url");
}

/** A fresh round identity, so one join cannot be reused to submit many rounds. */
export function newRoundId() {
  return randomUUID();
}

/**
 * Mint a token for a player who has just passed the credential check.
 * `extra` is signed along with the rest, so anything put there is tamper-proof
 * — the deck seed lives there, which is what stops a player shopping for a
 * better deal by re-joining.
 */
export function issueToken({ playerId, roundId, extra = {} }, now = Date.now()) {
  const payload = { playerId, roundId, purpose: PURPOSE_SESSION, exp: now + TOKEN_TTL_MS, ...extra };
  const payloadB64 = b64url(JSON.stringify(payload));
  return `${payloadB64}.${sign(payloadB64)}`;
}

/**
 * A ticket proving the holder is the person who just paid for `playerId`.
 *
 * It goes in the URL Square returns them to, which is why it may do nothing
 * except claim credentials — see PURPOSE_CLAIM.
 */
export function issueClaimToken(playerId, now = Date.now()) {
  const payloadB64 = b64url(JSON.stringify({ playerId, purpose: PURPOSE_CLAIM, exp: now + CLAIM_TTL_MS }));
  return `${payloadB64}.${sign(payloadB64)}`;
}

/**
 * Check a token and return what it claims.
 *
 * `purpose` is required rather than optional: a caller that forgets to say
 * what it expects would accept either kind, which is the exact confusion this
 * guards against.
 */
export function verifyToken(token, purpose = PURPOSE_SESSION, now = Date.now()) {
  if (typeof token !== "string" || !token.includes(".")) return { ok: false, reason: "malformed" };
  const [payloadB64, providedSig] = token.split(".", 2);
  if (!payloadB64 || !providedSig) return { ok: false, reason: "malformed" };

  const expected = Buffer.from(sign(payloadB64));
  const provided = Buffer.from(providedSig);
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    return { ok: false, reason: "bad-signature" };
  }

  let claims;
  try {
    claims = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof claims.exp !== "number" || claims.exp < now) return { ok: false, reason: "expired" };
  // Tokens issued before purposes existed have none; treat that as a session
  // token, which is what they were.
  if ((claims.purpose ?? PURPOSE_SESSION) !== purpose) return { ok: false, reason: "wrong-purpose" };
  return { ok: true, claims };
}

/** Pull a bearer token out of the request headers. */
export function bearerFrom(req) {
  const header = req.headers.authorization ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}
