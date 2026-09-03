/**
 * The branded intro screen:
 *   "www.strategictitans.ca Presents"  →  PokerSt8ts wordmark  →  mode select.
 * The crest auto-swaps to /assets/logo.png when that file is present.
 */

import { GameMode } from "../engine/index.js";
import { crest } from "./crest.js";
import { SIGNUP_URL } from "../game/relay.js";

export function renderIntro(
  onStart: (mode: GameMode) => void,
  onTournament?: () => void,
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
  if (onTournament) {
    const t = document.createElement("button");
    t.className = "mode-btn primary";
    t.innerHTML = `<span class="mode-label">Tournament</span><span class="mode-sub">Enter your player ID and PIN — score is reported.</span>`;
    t.addEventListener("click", () => onTournament());
    modes.appendChild(t);
  }
  modes.appendChild(makeBtn("Practice", "Golf scoring — warm up before you tee off.", GameMode.GolfMode));

  screen.append(home, presents, crest(), wordmark, tagline, modes);

  // Someone arriving without credentials had no route to get any: the signup
  // page existed but nothing pointed at it.
  if (onTournament) {
    const signup = document.createElement("a");
    signup.className = "signup-link";
    signup.href = SIGNUP_URL;
    signup.textContent = "Not entered yet? Sign up for the tournament";
    screen.appendChild(signup);
  }
  return screen;
}
