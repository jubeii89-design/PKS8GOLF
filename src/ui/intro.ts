/**
 * The branded intro screen:
 *   "www.strategictitans.ca Presents"  →  PokerSt8ts wordmark  →  mode select.
 * The crest auto-swaps to /assets/logo.png when that file is present.
 */

import { GameMode } from "../engine/index.js";
import { crest } from "./crest.js";

export function renderIntro(
  onStart: (mode: GameMode) => void,
  onLeaderboard?: () => void,
): HTMLElement {
  const screen = document.createElement("div");
  screen.className = "screen intro";

  const home = document.createElement("a");
  home.className = "home-link";
  home.href = "../";
  home.textContent = "⌂ Home";
  home.setAttribute("aria-label", "Back to PokerSt8ts home");

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
  tagline.className = "tagline";
  tagline.textContent = "Build 18 poker hands across two grids. One card at a time.";

  const modes = document.createElement("div");
  modes.className = "mode-select";
  const makeBtn = (label: string, sub: string, mode: GameMode, primary = false) => {
    const b = document.createElement("button");
    b.className = "mode-btn" + (primary ? " primary" : "");
    b.innerHTML = `<span class="mode-label">${label}</span><span class="mode-sub">${sub}</span>`;
    b.addEventListener("click", () => onStart(mode));
    return b;
  };
  modes.appendChild(makeBtn("PokerStr8ts", "Score points per hand — chase a high round.", GameMode.PokerStraightsMode, true));
  modes.appendChild(makeBtn("Golf", "Par & strokes — chase a low round.", GameMode.GolfMode));

  screen.append(home, presents, crest(), wordmark, tagline, modes);

  if (onLeaderboard) {
    const lbBtn = document.createElement("button");
    lbBtn.className = "lb-link";
    lbBtn.innerHTML = "🏆 Leaderboard";
    lbBtn.addEventListener("click", () => onLeaderboard());
    screen.appendChild(lbBtn);
  }
  return screen;
}
