/**
 * Marketing portal: the site root. Sells PokerSt8ts with the same branding
 * as the in-game intro, then hands off to the actual game at /play/ via the
 * gold ENTER button.
 */

import { setAssetBase, ASSET_BASE } from "../ui/assetBase.js";
import { mountCourseBackground } from "../ui/courseBackground.js";
import { mountPokerTableBackground } from "../ui/pokerTableBackground.js";
import { crest } from "../ui/crest.js";
import { mountBackgroundMusic } from "../ui/audio.js";
import "../ui/styles.css";
import "./portal.css";

setAssetBase(""); // portal is at the site root; assets/ is a sibling

const app = document.getElementById("app")!;
const bg = document.getElementById("bg");
const bgPoker = document.getElementById("bg-poker");
if (bg) mountCourseBackground(bg);
if (bgPoker) mountPokerTableBackground(bgPoker);
mountBackgroundMusic(document.body);
document.body.dataset.bg = "portal";

function renderPortal(): HTMLElement {
  const screen = document.createElement("div");
  screen.className = "screen intro portal";

  const copy = document.createElement("div");
  copy.className = "portal-copy";

  const presents = document.createElement("a");
  presents.className = "presents";
  presents.href = "https://www.strategictitans.ca";
  presents.target = "_blank";
  presents.rel = "noopener";
  presents.innerHTML = `<span class="site">www.strategictitans.ca</span> <span class="presents-word">Presents</span>`;

  const wordmark = document.createElement("h1");
  wordmark.className = "wordmark";
  wordmark.innerHTML = `Poker<span class="st8">St8ts</span>`;

  const tagline = document.createElement("p");
  tagline.className = "tagline portal-tagline";
  tagline.textContent = "A solo poker-and-golf card game — build 18 hands across two grids, one card at a time.";

  const features = document.createElement("ul");
  features.className = "portal-features";
  features.innerHTML = `
    <li>Two ways to play — PokerStr8ts or Golf strokes</li>
    <li>Fast solo rounds, right in your browser</li>
    <li>Persistent leaderboard, no account needed</li>`;

  copy.append(presents, crest(), wordmark, tagline, features);

  const enter = document.createElement("a");
  enter.className = "enter-btn";
  enter.href = "./play/";
  enter.innerHTML = `<span class="enter-label">ENTER</span>`;

  screen.append(copy, enter);
  return screen;
}

const portalScreen = renderPortal();
app.appendChild(portalScreen);

// Optional custom hero image (public/assets/portal.jpg/.jpeg/.png) replaces
// the golf-course/poker-table crossfade and the text overlay entirely —
// probed once, so a missing file costs nothing and leaves the default look.
(function probePortalImage(exts = ["jpg", "jpeg", "png"], i = 0): void {
  if (i >= exts.length) return;
  const img = new Image();
  const url = `${ASSET_BASE}assets/portal.${exts[i]}`;
  img.onload = () => {
    document.body.classList.add("has-portal-bg");
    portalScreen.style.backgroundImage = `url("${url}")`;
  };
  img.onerror = () => probePortalImage(exts, i + 1);
  img.src = url;
})();
