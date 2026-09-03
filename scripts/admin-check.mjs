/**
 * The organiser's page, driven the way an organiser would drive it.
 *
 * This is the tool someone reaches for when a player is standing in front of
 * them saying "it says I haven't paid" — so the checks are the things that
 * would actually be done under that pressure, not just that the page renders.
 *
 * Usage:  node scripts/admin-check.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync, existsSync, globSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { Db } from "../server/db.mjs";
import { Roster } from "../server/roster.mjs";

const PORT = 8975;
const DATA_DIR = mkdtempSync(join(tmpdir(), "admin-check-"));
const TOKEN = "admin-check-token";

const children = [];
const killRelayOnExit = () => { for (const c of children) { try { c.kill("SIGKILL"); } catch {} } };
process.on("exit", killRelayOnExit);
process.on("uncaughtException", (e) => { console.error(e); killRelayOnExit(); process.exit(1); });

let pass = 0, fail = 0;
const check = (cond, msg) => {
  if (cond) { console.log("ok:", msg); pass++; }
  else { console.error("FAIL:", msg); fail++; }
};

// --- a field with the two states that need an organiser, and a hostile name ---
const db = new Db(DATA_DIR);
const roster = new Roster(db);
async function enrol(name, email, { pay = true, pin = true, play = false, score = 0 } = {}) {
  const c = roster.signup({ name, email });
  if (pay) { roster.attachOrder(c.playerId, `O-${c.playerId}`); roster.markPaid(`O-${c.playerId}`); }
  if (pin) await roster.issuePin(c.playerId);
  if (play) {
    db.startRound({ roundId: `R${c.playerId}`, playerId: c.playerId, seed: "s", mode: 0, startedAt: new Date().toISOString() });
    db.finishRound({ roundId: `R${c.playerId}`, score, record: "X", finishedAt: new Date().toISOString(), scoreSource: "derived" });
  }
  return c.playerId;
}
await enrol("Ada Lovelace", "ada@example.com", { play: true, score: 71 });
const stuckId = await enrol("Stuck Player", "stuck@example.com", { pin: false });
// A name is whatever the public typed at signup, so it must never be trusted.
const hostile = await enrol('<img src=x onerror="document.title=\'PWNED\'">', "xss@example.com", { play: true, score: 12 });
db.close();

const relay = spawn(process.execPath, ["server/relay.mjs"], {
  env: {
    ...process.env, PORT: String(PORT), DATA_DIR, SESSION_SECRET: "admin-check",
    ADMIN_TOKEN: TOKEN, AS400_URL: "http://127.0.0.1:9/x",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
children.push(relay);
const logLines = [];
relay.stdout.on("data", (d) => logLines.push(String(d)));

const base = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 80; i++) {
  try { await fetch(`${base}/health`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
}

// --- the data behind the page is guarded ---
check((await fetch(`${base}/admin/players`)).status === 403, "the roster needs the admin token");
check(
  (await fetch(`${base}/admin/players`, { headers: { Authorization: "Bearer wrong" } })).status === 403,
  "and rejects a wrong one",
);
check((await fetch(`${base}/admin`)).status === 200, "the page itself is served (it carries no data)");

const exe = globSync(`${process.env.PLAYWRIGHT_BROWSERS_PATH || "/opt/pw-browsers"}/chromium-*/chrome-linux/chrome`).find(existsSync);
const browser = await chromium.launch({ executablePath: exe, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto(`${base}/admin`, { waitUntil: "networkidle" });
check(await page.locator("#gate").isVisible(), "the page opens locked");

await page.fill("#token", "not-the-token");
await page.click("#unlock");
await page.waitForSelector("#gateMsg:not([hidden])", { timeout: 5000 });
check((await page.locator("#gateMsg").innerText()).includes("rejected"), "a wrong token is refused at the gate");
check(await page.locator("#app").isHidden(), "and nothing is shown behind it");

await page.fill("#token", TOKEN);
await page.click("#unlock");
await page.waitForSelector("#app:not([hidden])", { timeout: 8000 });
await page.waitForTimeout(500);

// --- a hostile name must be text, never markup ---
check(await page.title() === "Tournament control", `a name containing markup did not execute (title: "${await page.title()}")`);
const shown = (await page.locator("td").allInnerTexts()).join(" ");
check(shown.includes("<img src=x"), "and appears verbatim as text");
check(await page.locator("td img").count() === 0, "no element was created from it");

// --- the thing an organiser is actually here to do ---
const before = new Db(DATA_DIR);
check(before.playerById(stuckId).pin_hash === null, "the stuck player starts with no PIN");
before.close();

const stuckRow = page.locator("#attention tr", { hasText: "Stuck Player" }).first();
check(await stuckRow.count() > 0, "they are listed under Needs attention");
await stuckRow.getByRole("button", { name: "Re-send PIN" }).click();
await page.waitForSelector("#msg:not([hidden])", { timeout: 8000 });
const msg = await page.locator("#msg").innerText();
check(msg.length > 0, `the page reports what happened: "${msg.slice(0, 70)}"`);

const after = new Db(DATA_DIR);
check(after.playerById(stuckId).pin_hash !== null, "and a PIN was actually issued — the button did the work");
after.close();

// --- unlocking works from the page too ---
await page.fill("#search", "ada");
await page.waitForTimeout(300);
const adaRow = page.locator("#results tr", { hasText: "Ada Lovelace" }).first();
check(await adaRow.count() > 0, "search finds a player by name");
await adaRow.getByRole("button", { name: "Unlock" }).click();
await page.waitForSelector("#msg:not([hidden])", { timeout: 8000 });
check(logLines.join("").includes("admin cleared PIN lockout"), "unlocking reaches the server");

check(errors.length === 0, `no page errors (${errors.slice(0, 2).join(" | ")})`);

await browser.close();
relay.kill("SIGTERM");
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
