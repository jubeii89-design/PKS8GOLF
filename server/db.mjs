/**
 * The tournament database.
 *
 * SQLite via `node:sqlite`, which ships with Node 22 — a real database with no
 * dependency to install and no server to run alongside this one. For a hundred
 * players it is comfortably the right size of tool: one file you can copy,
 * inspect with any SQLite client, and hand to someone after the event.
 *
 * It replaces the append-only JSONL logs. Those were fine for writing but gave
 * no way to *ask* anything — "who paid but never played", "which records has
 * the AS400 not taken" — which is exactly what you need mid-event when
 * something has gone wrong.
 *
 * Every write that spans more than one row goes through a transaction, so a
 * crash cannot leave a round half-recorded.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const SCHEMA = `
PRAGMA journal_mode = WAL;      -- readers never block the writer
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS players (
  player_id   TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  email       TEXT NOT NULL UNIQUE,
  pin_salt    TEXT,
  pin_hash    TEXT,
  status      TEXT NOT NULL DEFAULT 'pending',
  order_id    TEXT UNIQUE,
  tee_time    TEXT,
  signed_up_at TEXT NOT NULL,
  paid_at     TEXT
);

CREATE TABLE IF NOT EXISTS rounds (
  round_id    TEXT PRIMARY KEY,
  player_id   TEXT NOT NULL REFERENCES players(player_id),
  seed        TEXT NOT NULL,
  mode        INTEGER NOT NULL,
  score       INTEGER,
  record      TEXT,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  -- How the score was arrived at. 'derived' means the server replayed the
  -- moves and computed it; anything else is not trustworthy for prizes.
  score_source TEXT
);

CREATE TABLE IF NOT EXISTS moves (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id    TEXT NOT NULL,
  player_id   TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  action      TEXT NOT NULL,
  card        INTEGER,
  grid        INTEGER,
  col         INTEGER,
  row         INTEGER,
  score_after INTEGER,
  client_ts   TEXT,
  received_at TEXT NOT NULL,
  -- One row per move per round. A retried flush is therefore harmless, which
  -- matters because the client re-sends anything it could not confirm.
  UNIQUE (round_id, seq)
);

CREATE INDEX IF NOT EXISTS moves_by_round ON moves (round_id, seq);

CREATE TABLE IF NOT EXISTS as400_queue (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id    TEXT,
  record      TEXT NOT NULL,
  state       TEXT NOT NULL DEFAULT 'pending',  -- pending | delivered | rejected
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  created_at  TEXT NOT NULL,
  delivered_at TEXT
);

CREATE INDEX IF NOT EXISTS as400_pending ON as400_queue (state);
`;

export class Db {
  #db;

  constructor(dataDir) {
    const file = join(dataDir, "tournament.db");
    mkdirSync(dirname(file), { recursive: true });
    this.#db = new DatabaseSync(file);
    this.#db.exec(SCHEMA);
  }

  close() {
    this.#db.close();
  }

  /**
   * Snapshot the database to a file, safely, while it is being written to.
   *
   * Copying a live SQLite file with `cp` can catch it mid-write and produce a
   * corrupt copy — which is worse than no backup, because you will not find
   * out until you need it. SQLite's own VACUUM INTO takes a consistent
   * snapshot instead, and it works fine under WAL with readers and writers
   * active.
   *
   * Everything the event owns is in here: who paid, what they scored, and
   * which records the AS400 still has not taken. One file lost is the whole
   * tournament.
   */
  backupTo(path) {
    // A leftover file from an interrupted run would make this fail; the caller
    // names a fresh path per snapshot, so a collision means something is wrong.
    this.#db.exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`);
    return path;
  }

  /** Escape hatch for one-off queries and the admin views. */
  get raw() {
    return this.#db;
  }

  #run(sql, ...params) {
    return this.#db.prepare(sql).run(...params);
  }
  #all(sql, ...params) {
    return this.#db.prepare(sql).all(...params);
  }
  #get(sql, ...params) {
    return this.#db.prepare(sql).get(...params);
  }

  /** Run several statements as one unit; either all of it lands or none does. */
  transaction(fn) {
    this.#db.exec("BEGIN");
    try {
      const result = fn();
      this.#db.exec("COMMIT");
      return result;
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    }
  }

  // --- players -------------------------------------------------------------

  insertPlayer(p) {
    this.#run(
      `INSERT INTO players (player_id, name, email, status, signed_up_at, tee_time)
       VALUES (?, ?, ?, ?, ?, ?)`,
      p.playerId, p.name, p.email, p.status, p.signedUpAt, p.teeTime ?? null,
    );
  }

  playerById(playerId) {
    return this.#get(`SELECT * FROM players WHERE player_id = ?`, playerId) ?? null;
  }

  playerByEmail(email) {
    return this.#get(`SELECT * FROM players WHERE email = ? COLLATE NOCASE`, email) ?? null;
  }

  playerByOrder(orderId) {
    return this.#get(`SELECT * FROM players WHERE order_id = ?`, orderId) ?? null;
  }

  attachOrder(playerId, orderId) {
    this.#run(`UPDATE players SET order_id = ? WHERE player_id = ?`, orderId, playerId);
  }

  markPaid(playerId, paidAt) {
    this.#run(`UPDATE players SET status = 'paid', paid_at = ? WHERE player_id = ?`, paidAt, playerId);
  }

  setPin(playerId, salt, hash) {
    this.#run(`UPDATE players SET pin_salt = ?, pin_hash = ? WHERE player_id = ?`, salt, hash, playerId);
  }

  setTeeTime(playerId, teeTime) {
    this.#run(`UPDATE players SET tee_time = ? WHERE player_id = ?`, teeTime, playerId);
  }

  playerCounts() {
    const row = this.#get(
      `SELECT COUNT(*) AS total, COALESCE(SUM(status = 'paid'), 0) AS paid FROM players`,
    );
    return { total: row?.total ?? 0, paid: row?.paid ?? 0 };
  }

  /** IDs already taken, so a new one can be minted without colliding. */
  playerIdExists(playerId) {
    return this.#get(`SELECT 1 AS x FROM players WHERE player_id = ?`, playerId) !== undefined;
  }

  // --- rounds --------------------------------------------------------------

  startRound({ roundId, playerId, seed, mode, startedAt }) {
    this.#run(
      `INSERT INTO rounds (round_id, player_id, seed, mode, started_at) VALUES (?, ?, ?, ?, ?)`,
      roundId, playerId, seed, mode, startedAt,
    );
  }

  round(roundId) {
    return this.#get(`SELECT * FROM rounds WHERE round_id = ?`, roundId) ?? null;
  }

  finishRound({ roundId, score, record, finishedAt, scoreSource }) {
    this.#run(
      `UPDATE rounds SET score = ?, record = ?, finished_at = ?, score_source = ? WHERE round_id = ?`,
      score, record, finishedAt, scoreSource, roundId,
    );
  }

  /**
   * The standings: each player's best finished round.
   *
   * Best rather than latest, because a player whose tab died and who replayed
   * should not be punished for the round that was lost — and because "best"
   * is what a tournament means by a score.
   */
  leaderboard() {
    return this.#all(
      `SELECT p.player_id AS playerId, p.name AS playerName, MAX(r.score) AS score
         FROM rounds r
         JOIN players p ON p.player_id = r.player_id
        WHERE r.finished_at IS NOT NULL AND r.score IS NOT NULL
        GROUP BY p.player_id, p.name
        ORDER BY score DESC`,
    );
  }

  // --- moves ---------------------------------------------------------------

  /**
   * Record a batch. `INSERT OR IGNORE` makes a repeated flush a no-op rather
   * than a duplicate, which the client relies on when it retries.
   */
  insertMoves(moves) {
    const stmt = this.#db.prepare(
      `INSERT OR IGNORE INTO moves
         (round_id, player_id, seq, action, card, grid, col, row, score_after, client_ts, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    let inserted = 0;
    this.transaction(() => {
      for (const m of moves) {
        const result = stmt.run(
          m.roundId, m.playerId, m.seq, m.action,
          m.card ?? null,
          m.cell?.grid ?? null, m.cell?.col ?? null, m.cell?.row ?? null,
          m.scoreAfter ?? null, m.ts ?? null, m.receivedAt,
        );
        inserted += Number(result.changes ?? 0);
      }
    });
    return inserted;
  }

  /** Every move of a round, in play order — what a replay reads. */
  movesForRound(roundId) {
    return this.#all(
      `SELECT seq, action, card, grid, col, row FROM moves WHERE round_id = ? ORDER BY seq ASC`,
      roundId,
    );
  }

  moveCount(roundId) {
    return this.#get(`SELECT COUNT(*) AS n FROM moves WHERE round_id = ?`, roundId)?.n ?? 0;
  }

  // --- AS400 delivery queue ------------------------------------------------

  queueRecord(roundId, record, createdAt) {
    const result = this.#run(
      `INSERT INTO as400_queue (round_id, record, created_at) VALUES (?, ?, ?)`,
      roundId, record, createdAt,
    );
    return Number(result.lastInsertRowid);
  }

  pendingRecords(limit = 50) {
    return this.#all(`SELECT id, record FROM as400_queue WHERE state = 'pending' ORDER BY id LIMIT ?`, limit);
  }

  markDelivered(id, deliveredAt) {
    this.#run(`UPDATE as400_queue SET state = 'delivered', delivered_at = ? WHERE id = ?`, deliveredAt, id);
  }

  markRejected(id, error) {
    this.#run(`UPDATE as400_queue SET state = 'rejected', last_error = ? WHERE id = ?`, error, id);
  }

  recordAttempt(id, error) {
    this.#run(`UPDATE as400_queue SET attempts = attempts + 1, last_error = ? WHERE id = ?`, error, id);
  }

  pendingCount() {
    return this.#get(`SELECT COUNT(*) AS n FROM as400_queue WHERE state = 'pending'`)?.n ?? 0;
  }

  // --- operational views ---------------------------------------------------

  /**
   * The questions you actually ask when something is wrong, which the JSONL
   * files could not answer.
   */
  paidButNeverPlayed() {
    return this.#all(
      `SELECT p.player_id AS playerId, p.name, p.email
         FROM players p
         LEFT JOIN rounds r ON r.player_id = p.player_id AND r.finished_at IS NOT NULL
        WHERE p.status = 'paid' AND r.round_id IS NULL`,
    );
  }

  paidButNoPin() {
    return this.#all(
      `SELECT player_id AS playerId, name, email FROM players WHERE status = 'paid' AND pin_hash IS NULL`,
    );
  }
}
