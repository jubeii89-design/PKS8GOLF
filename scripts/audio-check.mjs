/**
 * The music must survive a failed first attempt.
 *
 * Browsers block audio until a real user gesture, so the first play() is
 * expected to fail. The old code removed its gesture listeners straight after
 * calling play() — before the promise settled — so one failure meant silence
 * for the rest of the session. This drives the real page and checks it keeps
 * trying until sound is actually coming out.
 *
 * Usage:  node scripts/audio-check.mjs path/to/single-file.html
 */
import { chromium } from "playwright-core";
import { existsSync, globSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const FILE = process.argv[2] ?? resolve("PKS8GOLF-play.html");
if (!existsSync(FILE)) {
  console.error(`no such file: ${FILE}\nbuild one first:  npm run singlefile`);
  process.exit(1);
}
const EXE = process.env.CHROMIUM_PATH
  ?? globSync(`${process.env.PLAYWRIGHT_BROWSERS_PATH || "/opt/pw-browsers"}/chromium-*/chrome-linux/chrome`).find(existsSync);

let pass = 0, fail = 0;
const check = (cond, msg) => {
  if (cond) { console.log("ok:", msg); pass++; }
  else { console.error("FAIL:", msg); fail++; }
};

// Default autoplay policy: what a real browser does, no overrides.
const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });

async function openPage({ failFirstPlays = 0 } = {}) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.addInitScript((n) => {
    const Real = window.Audio;
    window.Audio = function (...a) {
      const el = new Real(...a);
      window.__track = el;
      // Stand in for the browser refusing the first N attempts, which is what
      // happens before a gesture — and, intermittently, after one.
      let refusals = n;
      const realPlay = el.play.bind(el);
      el.play = () => (refusals-- > 0
        ? Promise.reject(new DOMException("blocked", "NotAllowedError"))
        : realPlay());
      window.__attempts = 0;
      const wrapped = el.play;
      el.play = () => { window.__attempts++; return wrapped(); };
      return el;
    };
    window.Audio.prototype = Real.prototype;
  }, failFirstPlays);
  await page.goto(pathToFileURL(FILE).href);
  await page.waitForTimeout(2200);
  return page;
}

const state = (page) => page.evaluate(() => {
  const a = window.__track;
  return a
    ? { muted: a.muted, paused: a.paused, t: +a.currentTime.toFixed(1), attempts: window.__attempts }
    : null;
});

// --- the track loads at all -------------------------------------------
{
  const page = await openPage();
  const s = await state(page);
  check(s !== null, "an audio track was created");
  check(await page.locator(".mute-btn").count() === 1,
    "the mute button is shown — it only renders once the track can play through");
  check(s.paused, "silent on load, as the browser requires");

  await page.mouse.click(640, 700); // a real, trusted gesture
  await page.waitForTimeout(1200);
  const after = await state(page);
  check(!after.paused && after.t > 0, `plays on the first click (t=${after.t}s)`);
  await page.close();
}

// --- the case the old code could not survive --------------------------
{
  const page = await openPage({ failFirstPlays: 3 });
  await page.mouse.click(640, 700);
  await page.waitForTimeout(600);
  const once = await state(page);
  check(once.paused, "still silent after one click when the browser refuses it");

  await page.mouse.click(300, 400);
  await page.waitForTimeout(400);
  await page.keyboard.press("Space");
  await page.waitForTimeout(1400);
  const later = await state(page);
  check(!later.paused && later.t > 0,
    `recovers on a later gesture instead of giving up (${later.attempts} attempts, t=${later.t}s)`);
  await page.close();
}

// --- a mute the player chose is left alone ----------------------------
{
  const page = await openPage();
  await page.mouse.click(640, 700);
  await page.waitForTimeout(1000);
  await page.locator(".mute-btn").click();          // player mutes deliberately
  await page.waitForTimeout(300);
  await page.mouse.click(300, 400);                 // more gestures
  await page.keyboard.press("Space");
  await page.waitForTimeout(800);
  check((await state(page)).muted === true,
    "a deliberate mute is not undone by the retry — it is a choice, not a fault");
  await page.close();
}

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
