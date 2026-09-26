import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import type { PositionInfo, ProtocolId } from './providers/types.js';

fs.mkdirSync(path.dirname(path.resolve(config.dbPath)), { recursive: true });

const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS wallets (
    address    TEXT PRIMARY KEY,
    label      TEXT NOT NULL,
    muted      TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS baselines (
    wallet   TEXT NOT NULL,
    protocol TEXT NOT NULL,
    PRIMARY KEY (wallet, protocol)
  );
  CREATE TABLE IF NOT EXISTS events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    wallet     TEXT NOT NULL,
    label      TEXT NOT NULL,
    kind       TEXT NOT NULL,
    protocol   TEXT NOT NULL,
    position   TEXT NOT NULL,
    pool       TEXT NOT NULL,
    pair       TEXT NOT NULL,
    data       TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS events_wallet ON events (wallet, id);
  CREATE TABLE IF NOT EXISTS positions (
    wallet    TEXT NOT NULL,
    protocol  TEXT NOT NULL,
    position  TEXT NOT NULL,
    pool      TEXT NOT NULL,
    pair      TEXT NOT NULL,
    opened_at INTEGER,
    deposit_usd REAL,
    missing   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (wallet, protocol, position)
  );
`);

export interface Wallet {
  address: string;
  label: string;
  /** Protokol yang di-mute, dipisah koma. */
  muted: string;
  created_at: number;
}

export interface StoredPosition {
  wallet: string;
  protocol: ProtocolId;
  position: string;
  pool: string;
  pair: string;
  opened_at: number | null;
  deposit_usd: number | null;
  /** Berapa kali berturut-turut posisi tidak muncul di API. */
  missing: number;
}

const stmt = {
  listWallets: db.prepare<[], Wallet>('SELECT * FROM wallets ORDER BY created_at, rowid'),
  getWallet: db.prepare<[string], Wallet>('SELECT * FROM wallets WHERE address = ?'),
  getWalletByLabel: db.prepare<[string], Wallet>('SELECT * FROM wallets WHERE lower(label) = lower(?)'),
  addWallet: db.prepare('INSERT INTO wallets (address, label, created_at) VALUES (?, ?, ?)'),
  renameWallet: db.prepare('UPDATE wallets SET label = ? WHERE address = ?'),
  setMuted: db.prepare('UPDATE wallets SET muted = ? WHERE address = ?'),
  deleteWallet: db.prepare('DELETE FROM wallets WHERE address = ?'),
  deleteWalletPositions: db.prepare('DELETE FROM positions WHERE wallet = ?'),
  deleteWalletBaselines: db.prepare('DELETE FROM baselines WHERE wallet = ?'),
  hasBaseline: db.prepare<[string, string], { x: number }>('SELECT 1 AS x FROM baselines WHERE wallet = ? AND protocol = ?'),
  setBaseline: db.prepare('INSERT OR IGNORE INTO baselines (wallet, protocol) VALUES (?, ?)'),
  getPositions: db.prepare<[string, string], StoredPosition>('SELECT * FROM positions WHERE wallet = ? AND protocol = ?'),
  countPositions: db.prepare<[string], { protocol: ProtocolId; n: number }>(
    'SELECT protocol, COUNT(*) AS n FROM positions WHERE wallet = ? GROUP BY protocol',
  ),
  upsertPosition: db.prepare(`
    INSERT INTO positions (wallet, protocol, position, pool, pair, opened_at, deposit_usd, missing)
    VALUES (@wallet, @protocol, @position, @pool, @pair, @opened_at, @deposit_usd, 0)
    ON CONFLICT (wallet, protocol, position) DO UPDATE SET missing = 0`),
  deletePosition: db.prepare('DELETE FROM positions WHERE wallet = ? AND protocol = ? AND position = ?'),
  setMissing: db.prepare('UPDATE positions SET missing = ? WHERE wallet = ? AND protocol = ? AND position = ?'),
  deleteProtocolPositions: db.prepare('DELETE FROM positions WHERE wallet = ? AND protocol = ?'),
};

export const listWallets = () => stmt.listWallets.all();
export const getWallet = (address: string) => stmt.getWallet.get(address);

export const labelTaken = (label: string, exceptAddress?: string) => {
  const w = stmt.getWalletByLabel.get(label);
  return !!w && w.address !== exceptAddress;
};

export const addWallet = (address: string, label: string) =>
  stmt.addWallet.run(address, label, Date.now());

export const renameWallet = (address: string, label: string) => stmt.renameWallet.run(label, address);

export const removeWallet = db.transaction((address: string) => {
  stmt.deleteWallet.run(address);
  stmt.deleteWalletPositions.run(address);
  stmt.deleteWalletBaselines.run(address);
});

export const mutedSet = (w: Wallet) => new Set(w.muted.split(',').filter(Boolean) as ProtocolId[]);
export const setMuted = (address: string, protocols: Iterable<ProtocolId>) =>
  stmt.setMuted.run([...protocols].join(','), address);

export const hasBaseline = (wallet: string, protocol: ProtocolId) => !!stmt.hasBaseline.get(wallet, protocol);

export const getPositions = (wallet: string, protocol: ProtocolId) => stmt.getPositions.all(wallet, protocol);

export function countPositions(wallet: string): Record<ProtocolId, number> {
  const out: Record<ProtocolId, number> = { dlmm: 0, dammv2: 0 };
  for (const r of stmt.countPositions.all(wallet)) out[r.protocol] = r.n;
  return out;
}

const toRow = (wallet: string, p: PositionInfo) => ({
  wallet,
  protocol: p.protocol,
  position: p.position,
  pool: p.pool,
  pair: p.pair,
  opened_at: p.openedAt ?? null,
  deposit_usd: p.depositUsd ?? null,
});

export const insertPositions = db.transaction((wallet: string, positions: PositionInfo[]) => {
  for (const p of positions) stmt.upsertPosition.run(toRow(wallet, p));
});

/** Simpan snapshot awal tanpa memicu alert. */
export const saveBaseline = db.transaction((wallet: string, protocol: ProtocolId, positions: PositionInfo[]) => {
  stmt.deleteProtocolPositions.run(wallet, protocol);
  for (const p of positions) stmt.upsertPosition.run(toRow(wallet, p));
  stmt.setBaseline.run(wallet, protocol);
});

export const deletePosition = (p: StoredPosition) => stmt.deletePosition.run(p.wallet, p.protocol, p.position);
export const setMissing = (p: StoredPosition, missing: number) =>
  stmt.setMissing.run(missing, p.wallet, p.protocol, p.position);

/** Isi wallet dari file seed jika database masih kosong. */
export function seedWallets(seedPath: string) {
  if (listWallets().length > 0 || !fs.existsSync(seedPath)) return 0;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
  } catch (err) {
    console.warn(`[db] ${seedPath} tidak bisa dibaca, dilewati:`, (err as Error).message);
    return 0;
  }
  // Hanya entri dengan alamat base58 & nama yang valid; sisanya dilewati.
  const seed = (Array.isArray(parsed) ? parsed : []).filter(
    (w): w is { label: string; address: string } =>
      typeof w?.address === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(w.address) && typeof w?.label === 'string' && !!w.label.trim(),
  );
  const insert = db.transaction(() => {
    for (const w of seed) addWallet(w.address, w.label.trim().slice(0, 40));
  });
  insert();
  return seed.length;
}

// ---------- event open / close (feed aktivitas) ----------

type EventKind = 'open' | 'close';

export interface EventRecord {
  id: number;
  wallet: string;
  label: string;
  kind: EventKind;
  protocol: ProtocolId;
  position: string;
  pool: string;
  pair: string;
  data: PositionInfo;
  /** Unix detik saat terdeteksi. */
  created_at: number;
}

type EventRow = Omit<EventRecord, 'data'> & { data: string };

const insertEvent = db.prepare(`
  INSERT INTO events (wallet, label, kind, protocol, position, pool, pair, data, created_at)
  VALUES (@wallet, @label, @kind, @protocol, @position, @pool, @pair, @data, @created_at)`);
const pruneEvents = db.prepare('DELETE FROM events WHERE id <= (SELECT MAX(id) FROM events) - ?');

const toRecord = (r: EventRow): EventRecord => ({ ...r, data: JSON.parse(r.data) as PositionInfo });

/** Simpan event dan kembalikan record lengkap (dengan id). */
export const saveEvents = db.transaction((w: Wallet, kind: EventKind, positions: PositionInfo[], keep: number) => {
  const now = Math.floor(Date.now() / 1000);
  const out: EventRecord[] = [];
  for (const p of positions) {
    const row = {
      wallet: w.address,
      label: w.label,
      kind,
      protocol: p.protocol,
      position: p.position,
      pool: p.pool,
      pair: p.pair,
      data: JSON.stringify(p),
      created_at: now,
    };
    const res = insertEvent.run(row);
    out.push({ ...row, id: Number(res.lastInsertRowid), data: p });
  }
  pruneEvents.run(keep);
  return out;
});

export function listEvents(opts: { limit?: number; before?: number; wallet?: string; kind?: EventKind }) {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (opts.before) {
    where.push('id < ?');
    params.push(opts.before);
  }
  if (opts.wallet) {
    where.push('wallet = ?');
    params.push(opts.wallet);
  }
  if (opts.kind) {
    where.push('kind = ?');
    params.push(opts.kind);
  }
  const sql = `SELECT * FROM events ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`;
  params.push(Math.min(MAX_EVENTS_PAGE, Math.max(1, opts.limit ?? 50)));
  // Hanya ada 8 kombinasi filter; statement disimpan supaya tidak di-prepare ulang tiap permintaan.
  let stmt = eventQueries.get(sql);
  if (!stmt) eventQueries.set(sql, (stmt = db.prepare(sql)));
  return (stmt.all(...params) as EventRow[]).map(toRecord);
}

const MAX_EVENTS_PAGE = 500;
const eventQueries = new Map<string, Database.Statement>();

// ---------- Track Wallet ----------

db.exec(`
  CREATE TABLE IF NOT EXISTS track_wallets (
    contract TEXT NOT NULL,
    wallet   TEXT NOT NULL,
    PRIMARY KEY (contract, wallet)
  );
  CREATE TABLE IF NOT EXISTS track_runs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    contract    TEXT NOT NULL,
    mode        TEXT NOT NULL,
    criteria    TEXT NOT NULL,
    status      TEXT NOT NULL,
    pools       TEXT NOT NULL DEFAULT '[]',
    stats       TEXT NOT NULL DEFAULT '{}',
    matches     TEXT NOT NULL DEFAULT '[]',
    message     TEXT,
    created_at  INTEGER NOT NULL,
    finished_at INTEGER
  );
`);

const trackStmt = {
  // rowid menjaga urutan penambahan: wallet lama dulu, lalu yang baru .
  wallets: db.prepare<[string], { wallet: string }>('SELECT wallet FROM track_wallets WHERE contract = ? ORDER BY rowid'),
  countWallets: db.prepare<[string], { n: number }>('SELECT COUNT(*) AS n FROM track_wallets WHERE contract = ?'),
  addWallet: db.prepare('INSERT OR IGNORE INTO track_wallets (contract, wallet) VALUES (?, ?)'),
  createRun: db.prepare(
    'INSERT INTO track_runs (contract, mode, criteria, status, created_at) VALUES (@contract, @mode, @criteria, @status, @created_at)',
  ),
  updateRun: db.prepare(
    'UPDATE track_runs SET status = @status, pools = @pools, stats = @stats, matches = @matches, message = @message, finished_at = @finished_at WHERE id = @id',
  ),
  listRuns: db.prepare<[number], TrackRunRow>(
    `SELECT id, contract, mode, criteria, status, '[]' AS pools, stats, '[]' AS matches, message, created_at, finished_at,
       json_array_length(matches) AS match_count
     FROM track_runs ORDER BY id DESC LIMIT ?`,
  ),
  getRun: db.prepare<[number], TrackRunRow>('SELECT *, json_array_length(matches) AS match_count FROM track_runs WHERE id = ?'),
  pruneRuns: db.prepare('DELETE FROM track_runs WHERE id <= (SELECT MAX(id) FROM track_runs) - ?'),
};

interface TrackRunRow {
  id: number;
  contract: string;
  mode: string;
  criteria: string;
  status: string;
  pools: string;
  stats: string;
  matches: string;
  message: string | null;
  created_at: number;
  finished_at: number | null;
  match_count: number;
}

interface TrackRunRecord {
  id: number;
  contract: string;
  mode: string;
  criteria: unknown;
  status: string;
  pools: unknown[];
  stats: Record<string, number>;
  matches: unknown[];
  matchCount: number;
  message: string | null;
  createdAt: number;
  finishedAt: number | null;
}

const toRun = (r: TrackRunRow): TrackRunRecord => ({
  id: r.id,
  contract: r.contract,
  mode: r.mode,
  criteria: JSON.parse(r.criteria),
  status: r.status,
  pools: JSON.parse(r.pools),
  stats: JSON.parse(r.stats),
  matches: JSON.parse(r.matches),
  matchCount: r.match_count,
  message: r.message,
  createdAt: r.created_at,
  finishedAt: r.finished_at,
});

export const getTrackWallets = (contract: string) => trackStmt.wallets.all(contract).map((r) => r.wallet);
export const countTrackWallets = (contract: string) => trackStmt.countWallets.get(contract)?.n ?? 0;
export const addTrackWallets = db.transaction((contract: string, wallets: Iterable<string>) => {
  for (const w of wallets) trackStmt.addWallet.run(contract, w);
});

export function createTrackRun(contract: string, mode: string, criteria: unknown, status: string) {
  const res = trackStmt.createRun.run({
    contract,
    mode,
    criteria: JSON.stringify(criteria),
    status,
    created_at: Math.floor(Date.now() / 1000),
  });
  trackStmt.pruneRuns.run(200);
  return Number(res.lastInsertRowid);
}

export function updateTrackRun(
  id: number,
  data: { status: string; pools: unknown[]; stats: object; matches: unknown[]; message: string | null; finished: boolean },
) {
  trackStmt.updateRun.run({
    id,
    status: data.status,
    pools: JSON.stringify(data.pools),
    stats: JSON.stringify(data.stats),
    matches: JSON.stringify(data.matches),
    message: data.message,
    finished_at: data.finished ? Math.floor(Date.now() / 1000) : null,
  });
}

export const listTrackRuns = (limit = 50) => trackStmt.listRuns.all(limit).map(toRun);
export const getTrackRun = (id: number) => {
  const r = trackStmt.getRun.get(id);
  return r ? toRun(r) : undefined;
};

// ---------- strategi posisi DLMM (cache hasil decode transaksi add) ----------

db.exec(`
  CREATE TABLE IF NOT EXISTS position_strategies (
    position   TEXT PRIMARY KEY,
    label      TEXT,
    adds       TEXT NOT NULL,
    add_count  INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);

interface StoredStrategy {
  label: string | null;
  adds: unknown[];
  addCount: number;
  updatedAt: number;
}

const strategyStmt = {
  get: db.prepare<[string], { label: string | null; adds: string; add_count: number; updated_at: number }>(
    'SELECT label, adds, add_count, updated_at FROM position_strategies WHERE position = ?',
  ),
  set: db.prepare(
    `INSERT INTO position_strategies (position, label, adds, add_count, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (position) DO UPDATE SET label = excluded.label, adds = excluded.adds,
       add_count = excluded.add_count, updated_at = excluded.updated_at`,
  ),
};

export function getStrategy(position: string): StoredStrategy | undefined {
  const r = strategyStmt.get.get(position);
  return r ? { label: r.label, adds: JSON.parse(r.adds), addCount: r.add_count, updatedAt: r.updated_at } : undefined;
}

export const saveStrategy = (position: string, label: string | null, adds: unknown[], addCount: number) =>
  strategyStmt.set.run(position, label, JSON.stringify(adds), addCount, Math.floor(Date.now() / 1000));

// ---------- pengaturan: daftar RPC Solana & key-value (Telegram, dll.) ----------

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS rpc_endpoints (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    url        TEXT NOT NULL UNIQUE,
    label      TEXT NOT NULL DEFAULT '',
    priority   INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
`);

interface RpcEndpoint {
  id: number;
  url: string;
  label: string;
  /** Urutan pemakaian: kecil = dicoba lebih dulu. */
  priority: number;
  created_at: number;
}

const settingStmt = {
  get: db.prepare<[string], { value: string }>('SELECT value FROM settings WHERE key = ?'),
  set: db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value'),
};

/** Nilai pengaturan (JSON) atau `fallback` jika belum pernah disimpan / rusak. */
export function getSetting<T>(key: string, fallback: T): T {
  const row = settingStmt.get.get(key);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}

export const setSetting = (key: string, value: unknown) => settingStmt.set.run(key, JSON.stringify(value));

const rpcStmt = {
  list: db.prepare<[], RpcEndpoint>('SELECT * FROM rpc_endpoints ORDER BY priority, id'),
  get: db.prepare<[number], RpcEndpoint>('SELECT * FROM rpc_endpoints WHERE id = ?'),
  byUrl: db.prepare<[string], RpcEndpoint>('SELECT * FROM rpc_endpoints WHERE url = ?'),
  maxPriority: db.prepare<[], { p: number | null }>('SELECT MAX(priority) AS p FROM rpc_endpoints'),
  add: db.prepare('INSERT INTO rpc_endpoints (url, label, priority, created_at) VALUES (?, ?, ?, ?)'),
  remove: db.prepare('DELETE FROM rpc_endpoints WHERE id = ?'),
  setPriority: db.prepare('UPDATE rpc_endpoints SET priority = ? WHERE id = ?'),
};

export const listRpcEndpoints = () => rpcStmt.list.all();
export const getRpcEndpoint = (id: number) => rpcStmt.get.get(id);
export const rpcUrlExists = (url: string) => !!rpcStmt.byUrl.get(url);

export function addRpcEndpoint(url: string, label: string) {
  const next = (rpcStmt.maxPriority.get()?.p ?? 0) + 1;
  rpcStmt.add.run(url, label, next, Math.floor(Date.now() / 1000));
}

export const removeRpcEndpoint = (id: number) => rpcStmt.remove.run(id).changes > 0;

/** Tukar urutan RPC dengan tetangganya (dir -1 = naik, 1 = turun). false jika sudah di ujung. */
export const moveRpcEndpoint = db.transaction((id: number, dir: -1 | 1) => {
  const list = listRpcEndpoints();
  const i = list.findIndex((e) => e.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return false;
  rpcStmt.setPriority.run(list[j].priority, list[i].id);
  rpcStmt.setPriority.run(list[i].priority, list[j].id);
  return true;
});

/**
 * Isi awal daftar RPC dari .env (SOLANA_RPC_URL) — hanya sekali. Setelah itu daftar dikelola dari
 * halaman Pengaturan, jadi RPC yang sengaja dihapus tidak muncul lagi saat restart.
 */
export function seedRpcEndpoint(url: string) {
  if (getSetting('rpcSeeded', false)) return;
  if (!listRpcEndpoints().length) addRpcEndpoint(url, 'Dari .env');
  setSetting('rpcSeeded', true);
}

// ---------- sesi login ----------

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id         TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
  );
`);

const sessionStmt = {
  create: db.prepare('INSERT INTO sessions (id, expires_at) VALUES (?, ?)'),
  valid: db.prepare<[string, number], { id: string }>('SELECT id FROM sessions WHERE id = ? AND expires_at > ?'),
  remove: db.prepare('DELETE FROM sessions WHERE id = ?'),
  prune: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
};

/** `expiresAt` dalam milidetik unix. */
export const createSession = (id: string, expiresAt: number) => sessionStmt.create.run(id, expiresAt);
export const sessionValid = (id: string) => !!sessionStmt.valid.get(id, Date.now());
export const deleteSession = (id: string) => sessionStmt.remove.run(id);
export const pruneSessions = () => sessionStmt.prune.run(Date.now());

export const closeDb = () => db.close();
