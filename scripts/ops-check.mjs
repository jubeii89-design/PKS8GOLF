/**
 * Step 4: the operational gaps.
 *
 * These are the things that bite on the day rather than in a code review — a
 * late player who should have been locked out, someone who paid and never got
 * their PIN, a signup endpoint being hammered.
 *
 * Usage:  node scripts/ops-check.mjs
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../server/db.mjs";
import { Roster } from "../server/roster.mjs";

const RELAY_PORT = 8871;
const SQUARE_PORT = 8872;
const DATA_DIR = mkdtempSync(join(tmpdir(), "ops-check-"));
const ADMIN_TOKEN = "ops-admin-token";
/** Already past, so anyone signing up now has missed the start. */
const TEE_OFF_AT = new Date(Date.now() - 60_000).toISOString();

const children = [];
const killRelayOnExit = () => { for (const c of children) { try { c.kill("SIGKILL"); } catch {} } };
process.on("exit", killRelayOnExit);
process.on("uncaughtException", (e) => { console.error(e); killRelayOnExit(); process.exit(1); });

let pass = 0, fail = 0;
const check = (cond, msg) => {
  if (cond) { console.log("ok:", msg); pass++; }
  else { console.error("FAIL:", msg); fail++; }
};

let orderSeq = 0;
const square = createServer((req, res) => {
  let b = ""; req.on("data", (c) => (b += c));
  req.on("end", () => {
    const orderId = `ORDER-${++orderSeq}`;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ payment_link: { id: `L${orderSeq}`, order_id: orderId, url: `https://sq.test/${orderId}` } }));
  });
});
await new Promise((r) => square.listen(SQUARE_PORT, r));

const relay = spawn(process.execPath, ["server/relay.mjs"], {
  env: {
    ...process.env,
    PORT: String(RELAY_PORT), DATA_DIR, SESSION_SECRET: "ops-secret",
    AS400_URL: "http://127.0.0.1:9/x",
    SQUARE_API_BASE: `http://127.0.0.1:${SQUARE_PORT}`,
    SQUARE_ACCESS_TOKEN: "t", SQUARE_LOCATION_ID: "L",
    ADMIN_TOKEN, TEE_OFF_AT, SIGNUP_LIMIT: "3",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
children.push(relay);
relay.stdout.on("data", (d) => process.stdout.write(`  relay| ${d}`));

const base = `http://127.0.0.1:${RELAY_PORT}`;
for (let i = 0; i < 80; i++) {
  try { await fetch(`${base}/health`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
}
const post = (path, body, token) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

// --- 1. the tee-off lockout actually locks out ---
const s1 = await (await post("/signup", { name: "Late Arrival", email: "late@example.com" })).json();
check(typeof s1.playerId === "string", "a player signs up");

// Pay them and issue a PIN directly, standing in for the Square webhook.
const db = new Db(DATA_DIR);
const roster = new Roster(db);
roster.markPaid(`ORDER-1`);
const { pin } = await roster.issuePin(s1.playerId);
check(db.playerById(s1.playerId).tee_time === TEE_OFF_AT, "the tee-off deadline is stored against the player");

const lateJoin = await (await post("/join", { playerId: s1.playerId, pin })).json();
check(lateJoin.ok === false, "a player past their tee-off cannot join");
check(lateJoin.reason === "missed-tee-time", `and is told why (${lateJoin.reason})`);
check(typeof lateJoin.teeTime === "string", "the refusal carries the tee-off time to show them");

// The same player, inside the window, gets in — so it is the deadline doing
// the work and not something else refusing them.
db.setTeeTime(s1.playerId, new Date(Date.now() + 3600_000).toISOString());
const inTime = await (await post("/join", { playerId: s1.playerId, pin })).json();
check(inTime.ok === true, `the same credentials work before the deadline (${inTime.reason ?? "ok"})`);

// --- 2. credential re-issue: the fix for PAID BUT NOT EMAILED ---
check((await post("/admin/reissue", { playerId: s1.playerId })).status === 403,
  "re-issue is refused without the admin token");
check((await post("/admin/reissue", { playerId: s1.playerId }, "wrong-token")).status === 403,
  "re-issue is refused with the wrong admin token");

const before = db.playerById(s1.playerId).pin_hash;
const reissued = await post("/admin/reissue", { playerId: s1.playerId }, ADMIN_TOKEN);
check(reissued.ok, `an organiser can re-issue credentials (${reissued.status})`);
const after = db.playerById(s1.playerId).pin_hash;
check(after !== before, "re-issuing mints a genuinely new PIN");

const oldPinRefused = await (await post("/join", { playerId: s1.playerId, pin })).json();
check(oldPinRefused.ok === false, "the old PIN stops working, so a stray email cannot be used");

check((await post("/admin/reissue", { playerId: "NOSUCHPLAYER" }, ADMIN_TOKEN)).status === 404,
  "re-issuing an unknown player is a clean 404");

// --- 3. the "who needs attention" view ---
const attention = await (await fetch(`${base}/admin/attention`, {
  headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
})).json();
check(Array.isArray(attention.paidButNeverPlayed), "the attention view lists paid-but-never-played");
check(attention.paidButNeverPlayed.some((p) => p.playerId === s1.playerId),
  "a paid player who has not finished a round shows up there");
check((await fetch(`${base}/admin/attention`)).status === 403, "the attention view needs the admin token too");

// --- 4. signup rate limiting ---
let limited = 0;
for (let i = 0; i < 6; i++) {
  const r = await post("/signup", { name: `Spam ${i}`, email: `spam${i}@example.com` });
  if (r.status === 429) limited++;
}
check(limited > 0, `repeated signups are eventually rate limited (${limited} refused)`);

db.close();
relay.kill("SIGTERM");
square.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
