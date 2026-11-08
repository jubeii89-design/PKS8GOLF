/**
 * Build the whole game as one HTML file you can double-click.
 *
 * No server, no install, works offline — for sending someone the game to try.
 * Everything is inlined: script, styles, the music and the art.
 *
 * At runtime the game reaches for its assets by path (`assets/music.mp3`,
 * `assets/logo.png`, ...) because normally Vite copies them to the site root.
 * Opened from a file there is no site root, so a small shim at the top of the
 * page rewrites those paths to the inlined data URLs. Three places ask for
 * them — an <img> src, an <audio> src, and a CSS background-image — so the
 * shim covers all three rather than patching one and leaving the others to
 * fail quietly, which is exactly how the music went missing the first time.
 *
 * Usage:  npm run singlefile  [-- out.html]
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = process.argv[2] ?? join(ROOT, "PKS8GOLF-play.html");
const TMP = mkdtempSync(join(tmpdir(), "pks8-single-"));

const MIME = {
  ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".wav": "audio/wav",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp", ".svg": "image/svg+xml", ".gif": "image/gif",
};

// --- bundle ---------------------------------------------------------------
// esbuild rather than Vite because Vite splits into chunks that then have to
// be fetched, which is the one thing a single file cannot do.
execFileSync("npx", [
  "esbuild", "src/main.ts", "--bundle", "--format=esm", "--minify", "--target=es2020",
  // Vite's env shim does not exist here; an empty relay URL is what solo play
  // wants anyway, and tournament mode is meaningless without a server.
  `--define:import.meta.env={"VITE_RELAY_URL":"","VITE_SIGNUP_URL":""}`,
  `--outfile=${join(TMP, "b.js")}`,
], { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"] });

const js = readFileSync(join(TMP, "b.js"), "utf8");
const css = existsSync(join(TMP, "b.css")) ? readFileSync(join(TMP, "b.css"), "utf8") : "";

// --- inline every real asset ---------------------------------------------
const assetDir = join(ROOT, "public", "assets");
const assets = {};
let assetBytes = 0;
for (const name of readdirSync(assetDir)) {
  const ext = name.slice(name.lastIndexOf("."));
  const mime = MIME[ext];
  if (!mime) continue; // README.md and friends
  const buf = readFileSync(join(assetDir, name));
  assets[`assets/${name}`] = `data:${mime};base64,${buf.toString("base64")}`;
  assetBytes += buf.length;
  console.log(`  inlined assets/${name} (${(buf.length / 1024).toFixed(0)} KB)`);
}
// Loud, not a warning. A single file that quietly lost its soundtrack is
// exactly what shipped last time, and it looked fine.
if (!Object.keys(assets).length) throw new Error("no assets found to inline — is public/assets/ there?");
const music = Object.keys(assets).find((k) => /music\.(mp3|ogg|wav)$/.test(k));
if (!music) throw new Error("no music track inlined — expected public/assets/music.mp3");

const shim = `
const A = ${JSON.stringify(assets)};
const hit = (v) => {
  if (typeof v !== "string" || v.startsWith("data:")) return v;
  for (const k in A) if (v === k || v.endsWith("/" + k)) return A[k];
  return v;
};
const patchSrc = (proto) => {
  const d = Object.getOwnPropertyDescriptor(proto, "src");
  if (!d || !d.set) return;
  Object.defineProperty(proto, "src", { ...d, set(v) { d.set.call(this, hit(v)); } });
};
patchSrc(HTMLImageElement.prototype);
patchSrc(HTMLMediaElement.prototype);
// Backgrounds are set from the same path string after the probe succeeds, so
// rewriting the <img> src alone would load the probe and show nothing.
const bg = Object.getOwnPropertyDescriptor(CSSStyleDeclaration.prototype, "backgroundImage");
if (bg && bg.set) {
  Object.defineProperty(CSSStyleDeclaration.prototype, "backgroundImage", {
    ...bg,
    set(v) { bg.set.call(this, String(v).replace(/url\\((["']?)([^"')]+)\\1\\)/g, (m, q, u) => {
      const r = hit(u); return r === u ? m : 'url("' + r + '")';
    })); },
  });
}`;

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>PokerSt8ts — Play</title>
<style>${css}</style>
</head>
<body>
<div id="bg" aria-hidden="true"></div>
<div id="bg-poker" aria-hidden="true"></div>
<div id="app"></div>
<script>(() => {${shim}})();</script>
<script type="module">${js}</script>
</body>
</html>`;

writeFileSync(OUT, html);
console.log(
  `\n${OUT}\n${(Buffer.byteLength(html) / 1024 / 1024).toFixed(1)} MB ` +
  `(${(assetBytes / 1024 / 1024).toFixed(1)} MB of it audio and art)`,
);
