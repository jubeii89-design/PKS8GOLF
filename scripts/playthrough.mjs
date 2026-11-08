/**
 * Visual playthrough: drives a full tournament round and captures each stage
 * as a screenshot, so the current state of the game can be reviewed without
 * a live server. Not a test — it asserts nothing, it just plays and shows.
 *
 * Usage:
 *   npm run build && npm run preview -- --port 4318 &
 *   BASE_URL=http://localhost:4318 node scripts/playthrough.mjs
 */
import { chromium } from "playwright-core";
import { existsSync, globSync } from "node:fs";

function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || "/opt/pw-browsers";
  const hits = globSync(`${root}/chromium-*/chrome-linux/chrome`);
  if (hits[0] && existsSync(hits[0])) return hits[0];
  throw new Error("Chromium not found; set CHROMIUM_PATH");
}

const BASE = process.env.BASE_URL || "http://localhost:4318";
const OUT = process.env.OUT_DIR || "/tmp/claude-0/-home-user-strategic/6962f10e-7bb8-5bbc-b431-0479c4cea5dd/scratchpad/play";

const browser = await chromium.launch({ executablePath: findChromium(), args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

// Intercept the AS400 so a playthrough never touches the live mainframe, and
// capture the record it would have sent so it can be shown verbatim.
const as400 = [];
await page.route("**centriko.com/**", async (route) => {
  as400.push(new URL(route.request().url()).searchParams.get("HDATASTREAM") ?? "");
  await route.fulfill({ status: 200, contentType: "text/plain", body: "OK" });
});
await page.route("**/api/moves", async (route) => {
  await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
});

const shot = async (name) => {
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log("captured:", name);
};

// 1. Portal
await page.goto(BASE, { waitUntil: "networkidle" });
await page.waitForTimeout(600);
await shot("1-portal");

// 2. Intro / mode select
await page.locator(".enter-btn").click();
await page.waitForURL(/\/play\/?$/, { waitUntil: "networkidle" });
await page.waitForTimeout(600);
await shot("2-intro-modes");

// 3. Tournament join prompt (player ID + PIN)
await page.locator(".mode-btn.primary").click();
await page.waitForSelector(".code-prompt");
await page.locator(".code-prompt .name-input").nth(0).fill("GORDONSTITT0001");
await page.locator(".code-prompt .name-input").nth(1).fill("100005");
await page.waitForTimeout(200);
await shot("3-join-id-pin");

// 4. Board at the start of a tournament round
await page.locator(".code-prompt .mode-btn.primary").click();
await page.waitForSelector(".board");
await page.waitForTimeout(1200);
await shot("4-board-start");

// 5. Mid-round
for (let i = 0; i < 12; i++) {
  const placeable = page.locator(".card-empty.placeable").first();
  if ((await placeable.count()) > 0) await placeable.click();
  else await page.locator(".pass-btn").click();
  await page.waitForTimeout(20);
}
await shot("5-board-midround");

// 6. Round complete panel
let guard = 0;
while (guard++ < 60 && (await page.locator(".overlay").count()) === 0) {
  const placeable = page.locator(".card-empty.placeable").first();
  if ((await placeable.count()) > 0) await placeable.click();
  else await page.locator(".pass-btn").click();
  await page.waitForTimeout(15);
}
await page.waitForTimeout(400);
await shot("6-round-complete");

// 7. Tournament standings board
await page.keyboard.press("Enter");
await page.waitForSelector(".leaderboard-screen");
await page.waitForTimeout(800);
await shot("7-standings");

// 8. QR-code auto-join: the URL a QR code would encode, joined with no prompt
await page.goto(`${BASE}/play/?player=GORDONSTITT0001&pin=100005`, { waitUntil: "networkidle" });
await page.waitForSelector(".board");
await page.waitForTimeout(1000);
await shot("8-qr-autojoin");

console.log("\nAS400 record that would have been sent:");
for (const r of as400) console.log(`  [${r.length} chars] ${r}`);

await browser.close();
