/**
 * Credentials have two delivery paths, not one.
 *
 * Email fails in ordinary ways — a typo, a spam folder, a bounce — and it used
 * to be the only route, so a failure left someone who had paid unable to play.
 * The payment-return screen is the second route.
 *
 * The cases worth proving are the awkward ones: the return beating the webhook,
 * and a claim ticket being unable to do anything except claim.
 *
 * Usage:  node scripts/claim-check.mjs
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RELAY_PORT = 8881;
const SQUARE_PORT = 8882;
const DATA_DIR = mkdtempSync(join(tmpdir(), "claim-check-"));
const SECRET = "claim-check-secret";
const WEBHOOK_KEY = "claim-webhook-key";
const WEBHOOK_URL = `http://127.0.0.1:${RELAY_PORT}/webhooks/square`;

const children = [];
const killRelayOnExit = () => { for (const c of children) { try { c.kill("SIGKILL"); } catch {} } };
process.on("exit", killRelayOnExit);
process.on("uncaughtException", (e) => { console.error(e); killRelayOnExit(); process.exit(1); });

let pass = 0, fail = 0;
const check = (cond, msg) => {
  if (cond) { console.log("ok:", msg); pass++; }
  else { console.error("FAIL:", msg); fail++; }
};

// --- stub Square, capturing the redirect URL it is handed ---
const linkRequests = [];
let orderSeq = 0;
const square = createServer((req, res) => {
  let b = ""; req.on("data", (c) => (b += c));
  req.on("end", () => {
    linkRequests.push(JSON.parse(b || "{}"));
    const orderId = `ORDER-${++orderSeq}`;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ payment_link: { id: `L${orderSeq}`, order_id: orderId, url: `https://sq.test/${orderId}` } }));
  });
});
await new Promise((r) => square.listen(SQUARE_PORT, r));

const relay = spawn(process.execPath, ["server/relay.mjs"], {
  env: {
    ...process.env,
    PORT: String(RELAY_PORT), DATA_DIR, SESSION_SECRET: SECRET,
    AS400_URL: "http://127.0.0.1:9/x",
    SQUARE_API_BASE: `http://127.0.0.1:${SQUARE_PORT}`,
    SQUARE_ACCESS_TOKEN: "t", SQUARE_LOCATION_ID: "L",
    SQUARE_WEBHOOK_KEY: WEBHOOK_KEY, SQUARE_WEBHOOK_URL: WEBHOOK_URL,
    PLAY_URL: "https://example.test/play/",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
children.push(relay);
relay.stdout.on("data", (d) => process.stdout.write(`  relay| ${d}`));

const base = `http://127.0.0.1:${RELAY_PORT}`;
for (let i = 0; i < 80; i++) {
  try { await fetch(`${base}/health`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
}
const post = (path, body, headers = {}) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const sign = (raw) => createHmac("sha256", WEBHOOK_KEY).update(WEBHOOK_URL + raw).digest("base64");
const paymentEvent = (orderId) =>
  JSON.stringify({ type: "payment.updated", data: { object: { payment: { status: "COMPLETED", order_id: orderId } } } });

// --- signup hands Square a return URL carrying a signed ticket ---
const signup = await (await post("/signup", { name: "Gordon Stitt", email: "gordon@example.com" })).json();
const redirect = linkRequests[0]?.checkout_options?.redirect_url ?? "";
check(redirect.startsWith("https://example.test/play/?claim="), `the return URL carries a claim ticket: ${redirect.slice(0, 46)}…`);
// The ticket is signed, not encrypted: the player id inside is readable by
// anyone who base64-decodes it. That is fine — a player id is not a secret,
// and the signature is what stops someone minting a ticket for somebody else.
check(!redirect.includes(signup.playerId), "the player id is not sitting in the URL in the clear");
check(
  JSON.parse(Buffer.from(decodeURIComponent(new URL(redirect).searchParams.get("claim")).split(".")[0], "base64url")).purpose === "claim",
  "the ticket says what it is for, so it cannot be mistaken for a session",
);
const claim = decodeURIComponent(new URL(redirect).searchParams.get("claim"));

// --- the return usually beats the webhook; that is not an error ---
const early = await (await post("/claim", { claim })).json();
check(early.paid === false, "claiming before the webhook lands reports not-yet rather than failing");
check(early.pin === undefined, "and hands out no PIN while the payment is unconfirmed");

// --- a forged or unrelated ticket gets nothing ---
check((await post("/claim", { claim: "not-a-real-ticket" })).status === 403, "a made-up ticket is refused");
check((await post("/claim", {})).status === 403, "a missing ticket is refused");

// --- payment clears ---
const raw = paymentEvent("ORDER-1");
check((await post("/webhooks/square", raw, { "x-square-hmacsha256-signature": sign(raw) })).ok, "the payment webhook is accepted");

const claimed = await (await post("/claim", { claim })).json();
check(claimed.paid === true, "after payment the claim reports paid");
check(claimed.playerId === signup.playerId, `it returns the right player (${claimed.playerId})`);
check(/^\d{6}$/.test(claimed.pin ?? ""), `it returns a six-digit PIN, so email is no longer the only route`);
check(claimed.name === "Gordon Stitt", "and the name, so the page can greet them");

// --- the credentials actually work ---
const joined = await (await post("/join", { playerId: claimed.playerId, pin: claimed.pin })).json();
check(joined.ok === true, `the claimed PIN really opens the door (${joined.reason ?? "ok"})`);

// --- a claim ticket must not double as a session ---
const asSession = await post("/round", { score: 9999 }, { Authorization: `Bearer ${claim}` });
check(asSession.status === 401, `a claim ticket cannot submit a score (${asSession.status})`);
const asClaim = await post("/claim", { claim: joined.token });
check(asClaim.status === 403, `and a session token cannot claim credentials (${asClaim.status})`);

// --- the PIN is never written to the database ---
const { Db } = await import("../server/db.mjs");
const db = new Db(DATA_DIR);
const row = db.playerById(signup.playerId);
check(row.pin_hash && row.pin_hash !== claimed.pin, "the database holds only a hash, never the PIN itself");
db.close();

relay.kill("SIGTERM");
square.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
