/**
 * Solo PokerSt8ts must still be a game you can just play.
 *
 * The tournament work moved PokerStr8ts scoring behind a player ID and PIN,
 * which is right for a scored round and wrong for someone who only wants to
 * play. This drives the solo button the way a visitor would and checks the
 * round is genuinely standalone: no credentials asked for, nothing reported,
 * nothing kept.
 *
 * Usage:  BASE_URL=http://localhost:4173 node scripts/solo-check.mjs
 */
import { chromium } from "playwright-core";
import { existsSync, globSync } from "node:fs";

const EXE = process.env.CHROMIUM_PATH
  ?? globSync(`${process.env.PLAYWRIGHT_BROWSERS_PATH || "/opt/pw-browsers"}/chromium-*/chrome-linux/chrome`).find(existsSync);
const BASE = process.env.BASE_URL || "http://localhost:4173";

let pass = 0, fail = 0;
const check = (cond, msg) => {
  if (cond) { console.log("ok:", msg); pass++; }
  else { console.error("FAIL:", msg); fail++; }
};

const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

// Anything leaving the machine would mean this is not a solo round.
const outbound = [];
page.on("request", (r) => {
  const u = r.url();
  if (!u.startsWith(BASE) && !u.startsWith("data:") && !u.startsWith("blob:")) outbound.push(u);
});

await page.goto(`${BASE}/play/`, { waitUntil: "networkidle" });
await page.waitForTimeout(600);

const labels = await page.locator(".mode-label").allInnerTexts();
check(labels.some((l) => /pokerstr8ts/i.test(l)), `PokerStr8ts is offered on the menu (saw: ${labels.join(", ")})`);
check(labels.some((l) => /practice/i.test(l)), "Practice is still offered alongside it");

const solo = page.locator(".mode-btn", { hasText: /PokerStr8ts/i }).first();
await solo.click();
await page.waitForTimeout(800);

// The point of the whole exercise: it starts, with nothing asked of the player.
const body = await page.locator("body").innerText();
check(!/player id/i.test(body) && !/\bPIN\b/.test(body), "starting solo never asks for a player ID or PIN");
await page.waitForSelector(".board");
check(await page.locator(".board .card:not(.card-empty)").count() === 6,
  "the round started with its 6 cards auto-placed");

// Poker scoring, not golf: the backdrop is the poker table.
check(await page.evaluate(() => document.body.dataset.bg) === "poker",
  "it is the PokerStr8ts round, not the golf one");

// Play it out: take the first legal cell, else pass. A finished round is the
// real test — a menu entry that starts something unplayable is no restoration.
for (let i = 0; i < 260; i++) {
  if (await page.locator(".overlay .end-panel").count() > 0) break;
  const placeable = page.locator(".card-empty.placeable").first();
  if ((await placeable.count()) > 0) await placeable.click();
  else if (await page.locator(".pass-btn").isEnabled()) await page.locator(".pass-btn").click();
  else break;
}
await page.waitForTimeout(400);

check(await page.locator(".board .card:not(.card-empty)").count() === 36,
  "all 36 cells filled — the round plays through to completion");
check(await page.locator(".overlay .end-panel").count() === 1, "it shows its own scorecard at the end");
check(!/player id/i.test(await page.locator("body").innerText()),
  "finished without ever demanding credentials");

// Standalone means standalone.
check(outbound.length === 0, `nothing was sent off the machine (${outbound.slice(0, 2).join(", ") || "no outbound requests"})`);
const stored = await page.evaluate(() => Object.keys(localStorage));
check(stored.length === 0, `nothing written to storage (found: ${JSON.stringify(stored)})`);
check(errors.length === 0, `no page errors (${errors.slice(0, 2).join(" | ")})`);

await page.screenshot({ path: `${process.env.OUT_DIR || "."}/solo-pokerst8ts.png` });

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
