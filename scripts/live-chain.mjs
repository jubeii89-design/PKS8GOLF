/**
 * Drives two real players through the browser against a running relay, and
 * checks the whole chain: moves land server-side, the AS400 gets the record,
 * and the second player sees the first on a real (non-mock) leaderboard.
 *
 * Usage:
 *   PORT=8794 ... node server/relay.mjs &
 *   VITE_RELAY_URL=http://127.0.0.1:8794 npm run build && npm run preview -- --port 4319 &
 *   node scripts/live-chain.mjs
 */
import { chromium } from "playwright-core";
import { existsSync, globSync, readFileSync } from "node:fs";

function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || "/opt/pw-browsers";
  const hits = globSync(`${root}/chromium-*/chrome-linux/chrome`);
  if (hits[0] && existsSync(hits[0])) return hits[0];
  throw new Error("Chromium not found; set CHROMIUM_PATH");
}

const BASE = process.env.BASE_URL || "http://localhost:4319";
const RELAY = process.env.RELAY_URL || "http://127.0.0.1:8794";
const DATA_DIR = process.env.DATA_DIR || "/tmp/relay-live";
const OUT = process.env.OUT_DIR || "/tmp/claude-0/-home-user-strategic/6962f10e-7bb8-5bbc-b431-0479c4cea5dd/scratchpad/play";

let pass = 0, fail = 0;
const check = (cond, msg) => {
  if (cond) { console.log("ok:", msg); pass++; }
  else { console.error("FAIL:", msg); fail++; }
};

const browser = await chromium.launch({ executablePath: findChromium(), args: ["--no-sandbox"] });

async function playRound(playerId, pin, shotName) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto(`${BASE}/play/?player=${playerId}&pin=${pin}`, { waitUntil: "networkidle" });
  await page.waitForSelector(".board", { timeout: 10000 });

  let guard = 0;
  while (guard++ < 60 && (await page.locator(".overlay").count()) === 0) {
    const placeable = page.locator(".card-empty.placeable").first();
    if ((await placeable.count()) > 0) await placeable.click();
    else await page.locator(".pass-btn").click();
    await page.waitForTimeout(12);
  }
  const finalScore = await page.locator(".screen.game .scorecard .round").innerText();
  await page.keyboard.press("Enter");
  await page.waitForSelector(".leaderboard-screen", { timeout: 10000 });
  await page.waitForTimeout(900);
  if (shotName) await page.screenshot({ path: `${OUT}/${shotName}.png` });

  const result = {
    score: Number(finalScore),
    isMock: (await page.locator(".lb-mock").count()) > 0,
    warning: (await page.locator(".lb-warning").count()) > 0,
    subtitle: await page.locator(".lb-subtitle").innerText().catch(() => ""),
    names: await page.locator(".lb-skin-name, .lb-name").allInnerTexts(),
    errors,
  };
  await page.close();
  return result;
}

// --- player one ---
const p1 = await playRound("GORDONSTITT0001", "100005");
check(p1.errors.length === 0, `player one: no page errors (${p1.errors.slice(0, 2).join(" | ")})`);
check(!p1.isMock, "player one: leaderboard is NOT flagged as demo data (it is real)");
check(!p1.warning, "player one: no 'score did not reach the server' warning");

// --- player two, a different device ---
const p2 = await playRound("SECONDPLAYER001", "100005", "9-live-relay-standings");
check(p2.errors.length === 0, `player two: no page errors (${p2.errors.slice(0, 2).join(" | ")})`);
check(!p2.isMock, "player two: leaderboard is real, not demo");

// --- the point of the whole exercise: they can see each other ---
check(p2.names.length === 2, `player two sees a 2-player field, not an invented one (${p2.names.join(", ")})`);
check(p2.names.includes("You"), "player two sees themselves flagged as You");
check(
  p2.names.some((n) => n === "GORDONSTITT0001"),
  `player two sees player one by name (${p2.names.join(", ")})`,
);

// --- server-side evidence ---
const relayHealth = await (await fetch(`${RELAY}/health`)).json();
check(relayHealth.rounds === 2, `relay holds both rounds (${relayHealth.rounds})`);
check(relayHealth.as400Pending === 0, `every record reached the AS400 (${relayHealth.as400Pending} pending)`);

const moveLines = readFileSync(`${DATA_DIR}/moves.jsonl`, "utf8").trim().split("\n").filter(Boolean);
const byPlayer = {};
for (const l of moveLines) {
  const m = JSON.parse(l);
  byPlayer[m.playerId] = (byPlayer[m.playerId] ?? 0) + 1;
}
check(moveLines.length > 60, `audit trail landed server-side: ${moveLines.length} moves on disk`);
check(
  Object.keys(byPlayer).length === 2,
  `moves recorded for both players (${JSON.stringify(byPlayer)})`,
);
const starts = moveLines.filter((l) => JSON.parse(l).action === "round-start").length;
check(starts === 12, `both rounds replayable from an empty board (${starts} round-start moves)`);

const roundLines = readFileSync(`${DATA_DIR}/rounds.jsonl`, "utf8").trim().split("\n").filter(Boolean);
check(roundLines.length === 2, `both finished rounds persisted (${roundLines.length})`);
const rec = JSON.parse(roundLines[0]).record;
check(rec.startsWith("TOURT") && rec.length === 106, `stored record is a valid 106-char AS400 row`);

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
