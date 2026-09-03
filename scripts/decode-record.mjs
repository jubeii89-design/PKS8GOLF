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
    const e = table.get(golf.handID);
    if (!e) {
      table.set(golf.handID, {
        golf: new Set([golf.points]), poker: new Set([poker.points]), name: golf.handName,
      });
    } else {
      e.golf.add(golf.points);
      e.poker.add(poker.points);
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

/** Most IDs carry one score; 3A carries two, so ranges are shown as "0-1". */
const span = (set) => {
  const v = [...set].sort((a, b) => a - b);
  return v.length === 1 ? String(v[0]) : `${v[0]}-${v[v.length - 1]}`;
};
const lo = (set) => Math.min(...set);
const hi = (set) => Math.max(...set);

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
    const amb = v.golf.size > 1 ? "  << more than one score" : "";
    console.log(
      `  ${id}   ${span(v.golf).padStart(4)}     ${relativeToPar(id, hi(v.golf)).padEnd(9)} ${span(v.poker).padStart(5)}   ${v.name}${amb}`,
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
let strokesLo = 0, strokesHi = 0;
let pointsLo = 0, pointsHi = 0;
let unknown = 0;
let sizeMismatch = 0;
let ambiguous = 0;

ids.forEach((id, i) => {
  const known = table.get(id);
  const expectedSize = sizes[i];
  const declaredSize = Number(id[0]);
  const sizeOk = declaredSize === expectedSize;
  if (!sizeOk && id.trim() !== "") sizeMismatch++;
  if (!known && id.trim() !== "") unknown++;
  if (known) {
    strokesLo += lo(known.golf); strokesHi += hi(known.golf);
    pointsLo += lo(known.poker); pointsHi += hi(known.poker);
    if (known.golf.size > 1) ambiguous++;
  }
  console.log(
    `  ${String(i + 1).padStart(2)}  ${id}   ${expectedSize}${sizeOk ? " " : "!"}   ` +
      `${(known ? `${known.name} (${relativeToPar(id, hi(known.golf))})` : "UNKNOWN TO THIS ENGINE").padEnd(26)} ` +
      `${known ? span(known.golf).padStart(6) : "     ?"}  ${known ? span(known.poker).padStart(6) : "     ?"}`,
  );
});

console.log();
if (sizeMismatch) console.log(`${sizeMismatch} hand(s) declare a size that does not match this course's hole layout.`);
if (unknown) console.log(`${unknown} hand ID(s) this engine cannot produce — the tables differ.`);

if (ambiguous) {
  console.log(`${ambiguous} hand(s) carry an ID that does not pin down a single score (3A is 0 or 1),`);
  console.log("so the totals below are a range rather than one number.");
}
const rng = (a, b) => (a === b ? String(a) : `${a}-${b}`);
console.log(`hands add up to   ${rng(strokesLo, strokesHi)} strokes  /  ${rng(pointsLo, pointsHi)} points`);
console.log(`record states     ${f.score}`);

const stated = Number(f.score);
const inRange = (a, b) => stated >= a && stated <= b;
if (!Number.isNaN(stated)) {
  if (inRange(strokesLo, strokesHi)) {
    console.log("\nMATCH on strokes — this engine and the mainframe agree on the hand table,");
    console.log("and the score field carries GOLF STROKES.");
  } else if (inRange(pointsLo, pointsHi)) {
    console.log("\nMATCH on points — the tables agree, and the score field carries");
    console.log("POKERSTR8TS POINTS.");
  } else {
    console.log(`\nNo match: stated ${stated}, we make it ${rng(strokesLo, strokesHi)} strokes or ${rng(pointsLo, pointsHi)} points.`);
    console.log(`Difference from strokes: ${stated - strokesHi}.`);
    console.log("Either the hand tables differ, or the score is not the sum of the holes.");
  }
}
