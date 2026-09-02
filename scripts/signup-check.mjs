/**
 * Exercises the signup → pay → email → join chain against a stub Square, so
 * nothing here touches a real payment provider or mailbox.
 *
 * The important cases are the ones where money is involved: an unpaid player
 * must not be able to play, and a forged payment confirmation must not be
 * believed.
 *
 * Usage:  node scripts/signup-check.mjs
 */
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../server/db.mjs";

const RELAY_PORT = 8801;
const SQUARE_PORT = 8802;
const SMTP_PORT = 8803;
const DATA_DIR = mkdtempSync(join(tmpdir(), "signup-check-"));
const WEBHOOK_KEY = "test-webhook-signing-key";
const WEBHOOK_URL = `http://127.0.0.1:${RELAY_PORT}/webhooks/square`;

let pass = 0, fail = 0;
const check = (cond, msg) => {
  if (cond) { console.log("ok:", msg); pass++; }
  else { console.error("FAIL:", msg); fail++; }
};

// --- stub Square: hands out payment links, records what was asked for ---
const linkRequests = [];
let orderSeq = 0;
const square = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    linkRequests.push(JSON.parse(body || "{}"));
    const orderId = `ORDER-${++orderSeq}`;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      payment_link: { id: `LINK-${orderSeq}`, order_id: orderId, url: `https://squareup.test/checkout/${orderId}` },
    }));
  });
});
await new Promise((r) => square.listen(SQUARE_PORT, r));

/**
 * Stub SMTP server: just enough of the protocol to accept one message and keep
 * it, so the credentials email can be inspected without a mail service. It
 * deliberately does not advertise STARTTLS, so the client stays in plaintext.
 */
const inboxes = [];
const smtp = createTcpServer((sock) => {
  let buf = "";
  let inData = false;
  let message = "";
  sock.write("220 stub ESMTP\r\n");
  sock.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    for (;;) {
      const nl = buf.indexOf("\r\n");
      if (nl === -1) break;
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 2);

      if (inData) {
        if (line === ".") {
          inData = false;
          inboxes.push(message);
          message = "";
          sock.write("250 OK queued\r\n");
        } else {
          message += line + "\n";
        }
        continue;
      }
      const cmd = line.slice(0, 4).toUpperCase();
      if (cmd === "EHLO" || cmd === "HELO") sock.write("250-stub\r\n250 SIZE 10485760\r\n");
      else if (cmd === "MAIL" || cmd === "RCPT" || cmd === "RSET") sock.write("250 OK\r\n");
      else if (cmd === "DATA") { inData = true; sock.write("354 go ahead\r\n"); }
      else if (cmd === "QUIT") { sock.write("221 bye\r\n"); sock.end(); }
      else sock.write("250 OK\r\n");
    }
  });
  sock.on("error", () => {});
});
await new Promise((r) => smtp.listen(SMTP_PORT, r));

const relay = spawn(process.execPath, ["server/relay.mjs"], {
  env: {
    ...process.env,
    PORT: String(RELAY_PORT),
    DATA_DIR,
    AS400_URL: "http://127.0.0.1:9/unused",
    SQUARE_API_BASE: `http://127.0.0.1:${SQUARE_PORT}`,
    SQUARE_ACCESS_TOKEN: "test-token",
    SQUARE_LOCATION_ID: "TESTLOC",
    SQUARE_WEBHOOK_KEY: WEBHOOK_KEY,
    SQUARE_WEBHOOK_URL: WEBHOOK_URL,
    ENTRY_FEE_CENTS: "2500",
    CURRENCY: "CAD",
    TOURNAMENT_NAME: "Test Charity Cup",
    TOURNAMENT_DATE: "Saturday 12 October",
    TOURNAMENT_TEE_OFF: "9:00 AM",
    PLAY_URL: "https://example.test/play/",
    // Points at the stub above, so a real address is never mailed.
    SMTP_HOST: "127.0.0.1",
    SMTP_PORT: String(SMTP_PORT),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
const relayLog = [];
relay.stdout.on("data", (d) => { relayLog.push(String(d)); process.stdout.write(`  relay| ${d}`); });
relay.stderr.on("data", (d) => process.stderr.write(`  relay! ${d}`));

const base = `http://127.0.0.1:${RELAY_PORT}`;
for (let i = 0; i < 60; i++) {
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

// --- the page can show the real fee ---
const info = await (await fetch(`${base}/tournament`)).json();
check(info.entryFeeCents === 2500 && info.currency === "CAD", "tournament endpoint reports the configured fee");
check(info.acceptingSignups === true, "signups are open when Square is configured");
check(info.tournament.name === "Test Charity Cup", "tournament name comes from config");

// --- signup ---
const signupRes = await post("/signup", { name: "Gordon Stitt", email: "gordon@example.com" });
const signup = await signupRes.json();
check(signupRes.ok, "signup accepted");
check(/^[A-Z0-9]{1,15}$/.test(signup.playerId), `player id is AS400-shaped: ${signup.playerId}`);
check(signup.playerId.length === 15, `player id is exactly 15 chars (${signup.playerId.length})`);
check(typeof signup.checkoutUrl === "string" && signup.checkoutUrl.includes("squareup"), "a checkout URL comes back");
check(signup.pin === undefined, "signup does NOT return a PIN (it is emailed after payment)");
check(linkRequests[0]?.quick_pay?.price_money?.amount === 2500, "Square was asked for the configured amount");
check(linkRequests[0]?.pre_populated_data?.buyer_email === "gordon@example.com", "Square prefills the buyer email");

// --- validation ---
check((await post("/signup", { name: "A", email: "x@y.co" })).status === 400, "a one-character name is refused");
check((await post("/signup", { name: "Real Name", email: "not-an-email" })).status === 400, "a bad email is refused");
check((await post("/signup", { name: "Gordon Again", email: "gordon@example.com" })).status === 409,
  "the same email cannot register twice");

// --- an unpaid player cannot play, whatever they type ---
const unpaid = await (await post("/join", { playerId: signup.playerId, pin: "000000" })).json();
check(unpaid.ok === false && unpaid.reason === "not-paid", `unpaid player is refused (${unpaid.reason})`);

// --- a forged payment confirmation must not be believed ---
const forged = await post("/webhooks/square", paymentEvent("ORDER-1"), { "x-square-hmacsha256-signature": "obviously-wrong" });
check(forged.status === 403, `an unsigned webhook is rejected (${forged.status})`);
const noSig = await post("/webhooks/square", paymentEvent("ORDER-1"));
check(noSig.status === 403, `a webhook with no signature at all is rejected (${noSig.status})`);
const stillUnpaid = await (await post("/join", { playerId: signup.playerId, pin: "000000" })).json();
check(stillUnpaid.reason === "not-paid", "the forged webhook did NOT mark the player paid");

// --- the real thing ---
const raw = paymentEvent("ORDER-1");
const realHook = await post("/webhooks/square", raw, { "x-square-hmacsha256-signature": sign(raw) });
check(realHook.ok, "a correctly signed webhook is accepted");

// The PIN only exists in the email. With SMTP unconfigured it is not logged
// either, so read it from the roster the only legitimate way: by checking that
// a wrong PIN fails and that the hash was issued.
const checkDb = new Db(DATA_DIR);
const stored = checkDb.playerById(signup.playerId);
check(stored.status === "paid", "roster records the player as paid");
check(typeof stored.pin_hash === "string" && stored.pin_hash.length === 64, "a PIN was issued and stored hashed");
check(stored.pin_salt !== null && stored.pin_hash !== null, "the PIN is stored salted, not in the clear");
check(!relayLog.join("").match(/\b\d{6}\b/), "no six-digit PIN appears in the log");

const wrongPin = await (await post("/join", { playerId: signup.playerId, pin: "999999" })).json();
check(wrongPin.ok === false && ["wrong-pin"].includes(wrongPin.reason), `a wrong PIN is refused (${wrongPin.reason})`);
const unknown = await (await post("/join", { playerId: "NOSUCHPLAYER001", pin: "123456" })).json();
check(unknown.reason === "unknown-player", `an unknown player id is refused (${unknown.reason})`);

// --- the email, and the happy path it unlocks ---
for (let i = 0; i < 50 && inboxes.length === 0; i++) await new Promise((r) => setTimeout(r, 100));
check(inboxes.length === 1, `exactly one credentials email was sent (${inboxes.length})`);
const mail = inboxes[0] ?? "";
check(/Test Charity Cup/.test(mail), "the email names the tournament");
check(/Saturday 12 October/.test(mail), "the email carries the tournament date");
check(/9:00 AM/.test(mail), "the email carries the tee-off time");
check(mail.includes(signup.playerId), "the email carries the player's ID");
check(/example\.test\/play/.test(mail), "the email links to the game");

// The PIN is in the mail and nowhere else — which is exactly the point.
const pinMatch = mail.match(/PIN:\s*(\d{6})/);
check(pinMatch !== null, "the email contains a six-digit PIN");
const realPin = pinMatch?.[1];

const admitted = await (await post("/join", { playerId: signup.playerId, pin: realPin })).json();
check(admitted.ok === true, `a paid player with the emailed PIN IS admitted (${JSON.stringify(admitted)})`);
check(admitted.playerName === "Gordon Stitt", `the game learns their real name (${admitted.playerName})`);

// --- Square retries webhooks; a duplicate must not re-issue or re-mail ---
const dup = await (await post("/webhooks/square", raw, { "x-square-hmacsha256-signature": sign(raw) })).json();
check(dup.duplicate === true, "a repeated webhook is recognised as a duplicate");
const afterDup = checkDb.playerById(signup.playerId);
check(afterDup.pin_hash === stored.pin_hash, "a duplicate webhook does not issue a second PIN");

// --- unrelated events are ignored, not errors ---
const other = JSON.stringify({ type: "refund.created", data: {} });
const otherRes = await (await post("/webhooks/square", other, { "x-square-hmacsha256-signature": sign(other) })).json();
check(otherRes.ignored === true, "an unrelated Square event is ignored cleanly");

// --- health reflects reality ---
const health = await (await fetch(`${base}/health`)).json();
check(health.registered === 1 && health.paid === 1, `health reports the roster (${health.registered}/${health.paid})`);
check(health.email === "smtp", "health reports the configured mail path");
check(health.webhooksVerifiable === true, "health confirms webhooks can be verified");

checkDb.close();
relay.kill("SIGTERM");
square.close();
smtp.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
