#!/usr/bin/env node
/**
 * Decode an AS400 datastream record and check it against this engine.
 *
 * Point of it: the hand IDs and the score in a record are not independent —
 * in golf the round score is the sum of the holes. So if a *real* record from
 * the mainframe has hand IDs that add up to its own score under our table,
 * the two systems agree about what each hand is worth. If they do not, the
 * difference tells you where.
 *
 * Usage:
 *   node scripts/decode-record.mjs "TOURT22422GORDONSTITT0001..."
 *   node scripts/decode-record.mjs --table        # just print our ID table
 */
import { evaluateHand, allHands } from "../server/lib/engine/index.js";

const PAR = { 3: 3, 4: 4, 5: 5 };

/** Every hand ID this engine can produce, exhaustively. */
function buildTable() {
  const cards = [];
  for (let s = 0; s < 4; s++) for (let r = 1; r <= 13; r++) cards.push(s * 100 + r);
  const table = new Map();
  const note = (h) => {
    const golf = evaluateHand(h, 1);
    const poker = evaluateHand(h, 0);
    if (!table.has(golf.handID)) {
      table.set(golf.handID, { golf: golf.points, poker: poker.points, name: golf.handName });
    }
  };
  for (let a = 0; a < 52; a++) for (let b = a + 1; b < 52; b++) for (let c = b + 1; c < 52; c++) {
    note([cards[a], cards[b], cards[c]]);
    for (let d = c + 1; d < 52; d++) {
      note([cards[a], cards[b], cards[c], cards[d]]);
      for (let e = d + 1; e < 52; e++) note([cards[a], cards[b], cards[c], cards[d], cards[e]]);
    }
  }
  return table;
}

const table = buildTable();
const sizes = allHands().map((h) => h.cells.length);

function relativeToPar(id, strokes) {
  const par = PAR[Number(id[0])];
  if (par === undefined) return "?";
  const d = strokes - par;
  return d <= -2 ? "eagle+" : d === -1 ? "birdie" : d === 0 ? "par" : d === 1 ? "bogey" : `${d} over`;
}

if (process.argv.includes("--table")) {
  console.log("Hand IDs this engine produces (strokes in Golf, points in PokerStr8ts):\n");
  console.log("  ID   strokes  vs par     points   hand");
  for (const [id, v] of [...table].sort()) {
    console.log(
      `  ${id}   ${String(v.golf).padStart(4)}     ${relativeToPar(id, v.golf).padEnd(9)} ${String(v.poker).padStart(5)}   ${v.name}`,
    );
  }
  console.log(`\nHand size per hole: ${sizes.join(" ")}`);
  console.log("Note: 3-card hands stop at a bogey (3F = 4). Only 4- and 5-card");
  console.log("hands reach a double bogey (4H = 6, 5J = 7).");
  process.exit(0);
}

const record = process.argv[2];
if (!record) {
  console.error("usage: decode-record.mjs <record> | --table");
  process.exit(2);
}

// Field positions, per the written spec.
const f = {
  prefix: record.slice(0, 5),
  day: record.slice(5, 8),
  qtrHour: record.slice(8, 10),
  playerId: record.slice(10, 25),
  pin: record.slice(25, 31),
  hands: record.slice(31, 67),
  score: record.slice(67, 70),
  topCards: record.slice(70, 106),
};

console.log(`length      ${record.length}${record.length === 106 ? "" : "   << expected 106"}`);
console.log(`prefix      "${f.prefix}"`);
console.log(`day / qtr   ${f.day} / ${f.qtrHour}`);
console.log(`player      "${f.playerId.trim()}"`);
console.log(`pin         "${f.pin}"`);
console.log(`score       "${f.score}"`);
console.log();

const ids = f.hands.match(/../g) ?? [];
console.log("hole  id   size  our reading                 strokes  points");
let strokes = 0;
let points = 0;
let unknown = 0;
let sizeMismatch = 0;

ids.forEach((id, i) => {
  const known = table.get(id);
  const expectedSize = sizes[i];
  const declaredSize = Number(id[0]);
  const sizeOk = declaredSize === expectedSize;
  if (!sizeOk && id.trim() !== "") sizeMismatch++;
  if (!known && id.trim() !== "") unknown++;
  if (known) { strokes += known.golf; points += known.poker; }
  console.log(
    `  ${String(i + 1).padStart(2)}  ${id}   ${expectedSize}${sizeOk ? " " : "!"}   ` +
      `${(known ? `${known.name} (${relativeToPar(id, known.golf)})` : "UNKNOWN TO THIS ENGINE").padEnd(26)} ` +
      `${known ? String(known.golf).padStart(6) : "     ?"}  ${known ? String(known.poker).padStart(6) : "     ?"}`,
  );
});

console.log();
if (sizeMismatch) console.log(`${sizeMismatch} hand(s) declare a size that does not match this course's hole layout.`);
if (unknown) console.log(`${unknown} hand ID(s) this engine cannot produce — the tables differ.`);

console.log(`hands add up to   ${strokes} strokes  /  ${points} points`);
console.log(`record states     ${f.score}`);

const stated = Number(f.score);
if (!Number.isNaN(stated)) {
  if (stated === strokes) {
    console.log("\nMATCH on strokes — this engine and the mainframe agree on the hand table,");
    console.log("and the score field carries GOLF STROKES.");
  } else if (stated === points) {
    console.log("\nMATCH on points — the tables agree, and the score field carries");
    console.log("POKERSTR8TS POINTS.");
  } else {
    console.log(`\nNo match: stated ${stated}, we make it ${strokes} strokes or ${points} points.`);
    console.log(`Difference from strokes: ${stated - strokes}.`);
    console.log("Either the hand tables differ, or the score is not the sum of the holes.");
  }
}
