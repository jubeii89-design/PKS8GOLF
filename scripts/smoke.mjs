/**
 * Headless UI smoke test: drives the built game through a full round and
 * asserts the intro branding, deck mechanics, and scorecard all behave.
 *
 * Usage:
 *   npm run build && npm run preview -- --port 4317 &
 *   CHROMIUM_PATH=/path/to/chrome BASE_URL=http://localhost:4317 node scripts/smoke.mjs
 *
 * CHROMIUM_PATH defaults to the Playwright-managed Chromium; override for CI.
 */
import { chromium } from "playwright-core";
import { existsSync } from "node:fs";
import { globSync } from "node:fs";

function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || "/opt/pw-browsers";
  const hits = globSync(`${root}/chromium-*/chrome-linux/chrome`);
  if (hits[0] && existsSync(hits[0])) return hits[0];
  throw new Error("Chromium not found; set CHROMIUM_PATH");
}

const EXE = findChromium();
const BASE = process.env.BASE_URL || "http://localhost:4317";
const OUT = process.env.OUT_DIR || ".";

function assert(cond, msg) {
  if (!cond) { console.error("FAIL:", msg); process.exitCode = 1; throw new Error(msg); }
  console.log("ok:", msg);
}

const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

// Real JS errors only. 404s from the art-probe loader (logo/card PNGs not
// present yet) are the intended CSS/SVG fallback, so they are ignored.
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
  if (m.type() !== "error") return;
  const t = m.text();
  if (/Failed to load resource/i.test(t) || /assets\//.test(t)) return;
  errors.push(t);
});

// --- Portal (marketing landing page) ---
await page.goto(BASE, { waitUntil: "networkidle" });
// The repo may ship a custom public/assets/portal.(jpg|jpeg|png) hero image,
// which replaces the text overlay entirely (see designOverrides/portal/main.ts)
// — wait for that async probe to settle either way before asserting.
await page.waitForFunction(
  () => document.body.classList.contains("has-portal-bg") || document.readyState === "complete",
  { timeout: 2000 },
).catch(() => {});
await page.waitForTimeout(300);
const hasPortalBg = await page.evaluate(() => document.body.classList.contains("has-portal-bg"));
if (hasPortalBg) {
  assert(await page.locator(".portal-copy").isHidden(), "portal text overlay hidden when a custom hero image is active");
} else {
  const portalPresents = await page.locator(".presents").innerText();
  assert(/strategictitans\.ca/i.test(portalPresents), `portal shows the site: "${portalPresents.replace(/\n/g, " ")}"`);
  const portalWordmark = await page.locator(".wordmark").innerText();
  assert(/PokerSt8ts/i.test(portalWordmark.replace(/\s/g, "")), `portal wordmark is PokerSt8ts: "${portalWordmark}"`);
  assert(await page.locator(".portal-features li").count() >= 3, "portal shows feature bullets");
  // The repo ships a real public/assets/logo.png — assert it actually loaded via
  // the portal's ASSET_BASE (""), not just that the SVG fallback shows. This is
  // the check that would catch an asset-path regression; the generic no-console-
  // errors assertion below intentionally ignores art-probe 404s and would miss it.
  await page.waitForSelector(".crest-img", { timeout: 3000 });
  assert(await page.locator(".crest-img").count() === 1, "portal crest loads the real logo.png (root asset path resolves)");
}
const enterHref = await page.locator(".enter-btn").getAttribute("href");
assert(/play\/?$/.test(enterHref ?? ""), `ENTER points at /play/: ${enterHref}`);
// The repo now ships public/assets/music.mp3 — the mute button should appear
// (and default to unmuted) since a track was found.
await page.waitForSelector(".mute-btn", { timeout: 3000 });
assert(await page.locator(".mute-btn").innerText() === "🔊", "mute button shows unmuted by default (portal)");
await page.screenshot({ path: `${OUT}/smoke-portal.png` });

await page.locator(".enter-btn").click();
await page.waitForURL(/\/play\/?$/, { waitUntil: "networkidle" });
assert(/\/play\/?$/.test(page.url()), `navigated to /play/: ${page.url()}`);

// --- Intro screen (game, now at /play/) ---
const presents = await page.locator(".presents").innerText();
assert(/strategictitans\.ca/i.test(presents), `intro shows the site: "${presents.replace(/\n/g, " ")}"`);
assert(/presents/i.test(presents), "intro says Presents");
const wordmark = await page.locator(".wordmark").innerText();
assert(/PokerSt8ts/i.test(wordmark.replace(/\s/g, "")), `wordmark is PokerSt8ts: "${wordmark}"`);
const link = await page.locator(".presents").getAttribute("href");
assert(link === "https://www.strategictitans.ca", `site link is real: ${link}`);
await page.waitForSelector(".crest-img", { timeout: 3000 });
assert(await page.locator(".crest-img").count() === 1, "game crest loads the real logo.png (../ asset path resolves under /play/)");
const homeHref = await page.locator(".home-link").getAttribute("href");
assert(homeHref === "../", `game intro links back to the portal: ${homeHref}`);
await page.waitForSelector(".mute-btn", { timeout: 3000 });
assert(await page.locator(".mute-btn").innerText() === "🔊", "mute button shows unmuted by default (game)");
await page.locator(".mute-btn").click();
assert(await page.locator(".mute-btn").innerText() === "🔇", "mute button toggles to muted");
await page.locator(".mute-btn").click();
assert(await page.locator(".mute-btn").innerText() === "🔊", "mute button toggles back to unmuted");

// --- Course & poker table backgrounds ---
assert(await page.locator("#bg .course-svg").count() === 1, "course background SVG mounted");
assert(await page.locator("#bg-poker .table-svg").count() === 1, "poker table SVG mounted");
assert(await page.getAttribute("body", "data-bg") === "intro", "intro sets body[data-bg=intro]");
const bgOpacityIntro = await page.locator("#bg").evaluate((el) => getComputedStyle(el).opacity);
assert(Number(bgOpacityIntro) > 0 && Number(bgOpacityIntro) < 1, `course dimmed on intro (opacity ${bgOpacityIntro})`);
const pokerBgIntro = Number(await page.locator("#bg-poker").evaluate((el) => getComputedStyle(el).opacity));
assert(pokerBgIntro < 0.05, `poker table hidden on intro (opacity ${pokerBgIntro})`);
await page.screenshot({ path: `${OUT}/bg-intro.png` });

// --- Golf mode shows the course full-strength ---
await page.locator(".mode-btn:not(.primary)").click(); // Golf
await page.waitForSelector(".board");
assert(await page.getAttribute("body", "data-bg") === "golf", "golf sets body[data-bg=golf]");
await page.waitForTimeout(1200); // let the opacity transition settle
const golfOpacity = Number(await page.locator("#bg").evaluate((el) => getComputedStyle(el).opacity));
assert(golfOpacity > 0.9, `course visible in golf mode (opacity ${golfOpacity})`);
const pokerBgGolf = Number(await page.locator("#bg-poker").evaluate((el) => getComputedStyle(el).opacity));
assert(pokerBgGolf < 0.05, `poker table hidden in golf mode (opacity ${pokerBgGolf})`);
await page.screenshot({ path: `${OUT}/bg-golf.png` });

// --- Tournament: 15-digit code → scored round → score reported ---
// Stub the scoring endpoint (stands in for the AS400 gateway).
const posted = [];
await page.route("**/api/score", async (route) => {
  posted.push(JSON.parse(route.request().postData() || "{}"));
  await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
});
// Per-move audit trail (stands in for the forensics store).
const moved = [];
await page.route("**/api/moves", async (route) => {
  moved.push(...(JSON.parse(route.request().postData() || "{}").moves ?? []));
  await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
});

await page.reload({ waitUntil: "networkidle" });
assert(
  (await page.locator(".mode-btn.primary .mode-label").innerText()) === "Tournament",
  "Tournament has replaced PokerStr8ts as the primary button",
);
await page.locator(".mode-btn.primary").click();
await page.waitForSelector(".code-prompt");
const codeInput = page.locator(".code-prompt .name-input");
const codeStart = page.locator(".code-prompt .mode-btn.primary");
assert(await codeStart.isDisabled(), "Start disabled before a code is entered");
await codeInput.fill("12345");
assert(await codeStart.isDisabled(), "Start still disabled on a short code");
await codeInput.fill("12345678901234x");
assert((await codeInput.inputValue()) === "12345678901234", "non-digits are stripped from the code");
assert(await codeStart.isDisabled(), "Start disabled at 14 digits");
await codeInput.fill("123456789012345");
assert(!(await codeStart.isDisabled()), "Start enabled at exactly 15 digits");
await codeStart.click();
await page.waitForSelector(".board");
assert(await page.getAttribute("body", "data-bg") === "poker", "poker sets body[data-bg=poker]");
await page.waitForTimeout(1200);
const pokerOpacity = Number(await page.locator("#bg").evaluate((el) => getComputedStyle(el).opacity));
assert(pokerOpacity < 0.05, `course hidden in poker mode (opacity ${pokerOpacity})`);
const pokerTableOpacity = Number(await page.locator("#bg-poker").evaluate((el) => getComputedStyle(el).opacity));
assert(pokerTableOpacity > 0.9, `poker table visible in poker mode (opacity ${pokerTableOpacity})`);
assert(await page.locator(".grid").count() === 2, "two grids render");
const preplaced = await page.locator(".board .card:not(.card-empty)").count();
assert(preplaced === 6, `6 cards auto-placed at start (got ${preplaced})`);
assert(await page.locator(".pass-btn").isVisible(), "PASS button visible");
const remainStart = await page.locator(".remain-value").innerText();
assert(remainStart === "41", `cards remaining starts at 41 (got ${remainStart})`);

// --- Place one card; the counter ticks ---
await page.locator(".card-empty.placeable").first().click();
await page.waitForTimeout(50);
assert(await page.locator(".board .card:not(.card-empty)").count() === 7, "placing adds a card to the board");
assert(await page.locator(".remain-value").innerText() === "40", "counter ticks down on place");

// --- Pass one card ---
await page.locator(".pass-btn").click();
await page.waitForTimeout(50);
assert(await page.locator(".remain-value").innerText() === "39", "counter ticks down on pass");

// --- Fast-play to completion ---
async function fastPlayToEnd() {
  let guard = 0;
  while (guard++ < 60) {
    if ((await page.locator(".overlay").count()) > 0) break;
    const placeable = page.locator(".card-empty.placeable").first();
    if ((await placeable.count()) > 0) await placeable.click();
    else await page.locator(".pass-btn").click();
    await page.waitForTimeout(15);
  }
}
await fastPlayToEnd();
assert(await page.locator(".overlay").count() > 0, "end panel appears when the round completes");
assert(await page.locator(".board .card:not(.card-empty)").count() === 36, "all 36 cells filled at completion");
assert(await page.locator(".score-box").count() === 0, "strokes/score box removed from the rail");

// --- End panel: your own scorecard (same grid shown during play), centered on screen ---
assert(await page.locator(".overlay .end-panel.wide").count() === 1, "end panel is the wide variant");
assert((await page.locator(".overlay .end-panel h2").innerText()) === "Round complete!", "end panel heading is Round complete!");
assert(await page.locator(".end-hint").count() === 1, "press-any-key hint shown on the personal scorecard panel");
const tourneyRound = await page.locator(".screen.game .scorecard .round").innerText();
const overlayRound = await page.locator(".overlay .scorecard .round").innerText();
assert(overlayRound === tourneyRound, `personal scorecard round (${overlayRound}) matches the in-game scorecard (${tourneyRound})`);
assert(await page.locator(".final-stat").count() === 1, "best-hand stat shown alongside the personal scorecard");
await page.screenshot({ path: `${OUT}/smoke-complete.png`, fullPage: true });

// --- Tournament finish shows round standings instead of prompting for a name ---
await page.keyboard.press("Enter");
await page.waitForSelector(".standings");
assert(
  /^\d+(st|nd|rd|th) of \d+$/.test(await page.locator(".overlay .end-panel h2").innerText()),
  `tournament finish shows the player's placing: "${await page.locator(".overlay .end-panel h2").innerText()}"`,
);
const standingRows = await page.locator(".standings-row, .standing-row").count();
assert(standingRows > 1, `standings list the whole field (got ${standingRows} rows)`);
assert(await page.locator(".standing-row.you").count() === 1, "the player's own row is highlighted");
assert(
  (await page.locator(".standings-note").innerText()).includes("DEMO DATA"),
  "mock standings are clearly marked as demo data",
);
assert(await page.locator(".name-prompt").count() === 0, "tournament round never asks for a name");
assert(posted.length === 1, `exactly one score POSTed (got ${posted.length})`);
assert(posted[0].playerCode === "123456789012345", `POST carries the player code: ${posted[0].playerCode}`);
assert(posted[0].score === Number(tourneyRound), `POSTed score matches the round (${posted[0].score} vs ${tourneyRound})`);

// --- Audit trail: every card played is captured, in order, replayable ---
// 36 cells - 6 auto-placed = 30 placements by the player, plus every pass.
assert(
  moved.filter((m) => m.action === "round-start").length === 6,
  "the 6 auto-placed cards are logged so the round replays from an empty board",
);
assert(
  moved.filter((m) => m.action === "place").length === 30,
  `every one of the player's 30 placements was logged (got ${moved.filter((m) => m.action === "place").length})`,
);
assert(
  moved.filter((m) => m.action === "pass").length >= 1,
  "passes are logged too, not just placements",
);
assert(
  moved.every((m) => m.playerCode === "123456789012345" && m.tournamentId),
  "every move carries the player code and tournament id",
);
assert(
  moved.every((m, i) => m.seq === i),
  "move sequence numbers are contiguous with no gaps",
);
assert(
  moved.filter((m) => m.action === "place").every((m) => m.cell && typeof m.card === "number"),
  "each placement records which card went into which cell",
);
assert(
  moved[moved.length - 1].scoreAfter === Number(tourneyRound),
  `the last logged score matches the final round (${moved[moved.length - 1].scoreAfter} vs ${tourneyRound})`,
);
await page.screenshot({ path: `${OUT}/smoke-tournament.png` });
await page.keyboard.press("Enter"); // back to intro

// --- Practice round: Golf scoring, and nothing is recorded anywhere ---
await page.waitForSelector(".mode-select");
assert(
  (await page.locator(".mode-btn:not(.primary) .mode-label").innerText()) === "Practice",
  "Golf is presented as Practice alongside Tournament",
);
assert(await page.locator(".lb-link").count() === 0, "no leaderboard link — practice scores are not kept");
const postsBeforePractice = posted.length;
const movesBeforePractice = moved.length;

await page.locator(".mode-btn:not(.primary)").click(); // Practice (Golf scoring)
await page.waitForSelector(".board");
assert(await page.getAttribute("body", "data-bg") === "golf", "practice uses golf scoring");
await fastPlayToEnd();
assert(await page.locator(".overlay .end-panel").count() === 1, "practice shows its own scorecard at the end");
await page.keyboard.press("Enter");

await page.waitForSelector(".mode-select");
assert(await page.locator(".name-prompt").count() === 0, "practice never asks for a name");
assert(await page.locator(".standings").count() === 0, "practice never shows tournament standings");
assert(posted.length === postsBeforePractice, "practice reports no score");
assert(moved.length === movesBeforePractice, "practice logs no moves");
const stored = await page.evaluate(() =>
  Object.keys(localStorage).filter((k) => k.includes("leaderboard") || k.includes("handHistory")),
);
assert(stored.length === 0, `practice writes nothing to storage (found ${JSON.stringify(stored)})`);
await page.screenshot({ path: `${OUT}/smoke-practice.png` });

assert(errors.length === 0, `no page/console errors (${errors.length}): ${errors.slice(0, 3).join(" | ")}`);

await browser.close();
console.log("\nSMOKE TEST PASSED");
