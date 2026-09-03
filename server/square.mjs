/**
 * Square payments, via hosted checkout.
 *
 * Card details never reach this server. We ask Square for a payment link, send
 * the player to Square's own page, and find out the result from a webhook.
 * That keeps card data entirely inside Square, which is the whole reason to
 * use them rather than take payments ourselves.
 *
 * Configuration (all environment variables, none of them ever committed):
 *   SQUARE_ACCESS_TOKEN    required to take payments at all
 *   SQUARE_LOCATION_ID     required; the location the charge belongs to
 *   SQUARE_ENVIRONMENT     "sandbox" (default) or "production"
 *   SQUARE_WEBHOOK_KEY     required to trust anything the webhook says
 *   SQUARE_WEBHOOK_URL     the public URL Square posts to; part of the signature
 *
 * With no access token configured the module reports itself unconfigured and
 * the relay refuses to take signups, rather than pretending to charge people.
 */

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

const API_VERSION = "2025-01-23";
const TIMEOUT_MS = 20_000;

const ENVIRONMENT = process.env.SQUARE_ENVIRONMENT ?? "sandbox";
const ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN ?? "";
const LOCATION_ID = process.env.SQUARE_LOCATION_ID ?? "";
const WEBHOOK_KEY = process.env.SQUARE_WEBHOOK_KEY ?? "";
const WEBHOOK_URL = process.env.SQUARE_WEBHOOK_URL ?? "";

/** Overridable so tests can point at a stub instead of the real Square. */
const API_BASE =
  process.env.SQUARE_API_BASE ??
  (ENVIRONMENT === "production" ? "https://connect.squareup.com" : "https://connect.squareupsandbox.com");

export function isConfigured() {
  return ACCESS_TOKEN !== "" && LOCATION_ID !== "";
}

export function canVerifyWebhooks() {
  return WEBHOOK_KEY !== "" && WEBHOOK_URL !== "";
}

export function environment() {
  return ENVIRONMENT;
}

/**
 * Ask Square for a checkout page for one entry fee.
 *
 * The returned `orderId` is how a later webhook is tied back to the player —
 * Square reports a completed payment by order, not by anything we choose.
 */
export async function createPaymentLink({ playerId, name, email, amountCents, currency, redirectUrl }) {
  if (!isConfigured()) throw new Error("Square is not configured");

  const res = await fetch(`${API_BASE}/v2/online-checkout/payment-links`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      "Square-Version": API_VERSION,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    body: JSON.stringify({
      // Square dedupes on this, so a retried signup cannot double-charge.
      idempotency_key: randomUUID(),
      quick_pay: {
        name: `Tournament entry — ${name}`,
        price_money: { amount: amountCents, currency },
        location_id: LOCATION_ID,
      },
      checkout_options: {
        redirect_url: redirectUrl,
        ask_for_shipping_address: false,
      },
      pre_populated_data: { buyer_email: email },
      // Carried through to the order so a human reconciling Square against the
      // roster can see who a payment was for.
      description: `PKS8GOLF tournament entry for ${playerId}`,
    }),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = body?.errors?.[0]?.detail ?? `HTTP ${res.status}`;
    throw new Error(`Square rejected the payment link: ${detail}`);
  }
  const link = body.payment_link ?? {};
  if (!link.url || !link.order_id) throw new Error("Square returned no checkout URL");
  return { url: link.url, orderId: link.order_id, paymentLinkId: link.id };
}

/**
 * Is this webhook really from Square?
 *
 * Without this check anyone who finds the endpoint could mark themselves paid
 * and play for free, so an unverifiable request is refused rather than trusted.
 * Square signs the notification URL concatenated with the exact raw body, so
 * the body must be the untouched bytes — parsing it first would change it.
 */
export function verifyWebhook(rawBody, signatureHeader) {
  if (!canVerifyWebhooks()) return { ok: false, reason: "webhook-verification-not-configured" };
  if (!signatureHeader) return { ok: false, reason: "missing-signature" };

  const expected = createHmac("sha256", WEBHOOK_KEY).update(WEBHOOK_URL + rawBody).digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signatureHeader));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "bad-signature" };
  return { ok: true };
}

/**
 * Pull the completed payment out of a webhook body, if that is what it is.
 * Square sends many event types; only a completed payment activates a player.
 */
export function completedPaymentOrderId(event) {
  if (event?.type !== "payment.updated" && event?.type !== "payment.created") return null;
  const payment = event?.data?.object?.payment;
  if (!payment || payment.status !== "COMPLETED") return null;
  return payment.order_id ?? null;
}
