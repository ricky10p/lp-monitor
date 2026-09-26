/**
 * Track Wallet — satu alur dari awal sampai akhir, dijalankan sebagai job di server:
 *
 *   1. Daftar wallet yang REMOVE LIQUIDITY sebuah token (GMGN, atau ditempel manual)
 *   2. Cari pool Meteora yang memuat token itu di portfolio tiap wallet
 *   3. User memilih pool di halaman web
 *   4. Ambil posisi + PnL-nya, cocokkan dengan kriteria
 *
 * Hanya satu job aktif sekaligus. Progress dikirim ke browser lewat listener (SSE),
 * hasil disimpan ke tabel track_runs setiap ada temuan baru dan saat selesai.
 */
import * as store from '../db.js';
import { describeError } from '../api/http.js';
import { mapLimit } from '../lib/concurrent.js';
import {
  daysBackFor,
  describeCriteria,
  describeDateRange,
  describePoolCriteria,
  matchesDate,
  matchesFees,
  matchesPool,
  matchesPoolTotals,
  matchesProfit,
  MODE_FEES,
  MODE_NAMES,
  MODE_POOL,
  type Criteria,
  type Mode,
} from './criteria.js';
import { scanRemovers } from './gmgn.js';
import { fetchPositions, findPools, STATUS_ALL, STATUS_CLOSED, type FoundPool, type PoolTotals, type TrackPosition } from './meteora.js';

type JobStatus = 'scanning' | 'pools' | 'awaiting_selection' | 'matching' | 'done' | 'cancelled' | 'error';
const ACTIVE: JobStatus[] = ['scanning', 'pools', 'awaiting_selection', 'matching'];
const LOG_MAX = 300;
/** Progress dikirim ke browser paling sering tiap EMIT_MS. */
const EMIT_MS = 300;
/**
 * Hasil sementara disimpan ke database paling sering tiap PERSIST_MS (bukan setiap temuan): tiap simpan
 * menulis ulang seluruh daftar hasil, jadi menyimpan per temuan membuat tulisan tumbuh kuadratik.
 */
const PERSIST_MS = 5000;

/** Error job yang membawa kode HTTP untuk route (404 job tidak ada, 409 status tidak sesuai). */
export class TrackError extends Error {
  constructor(
    message: string,
    public status: 404 | 409,
  ) {
    super(message);
  }
}

interface PoolSummary {
  poolAddress: string;
  binStep: string | number;
  baseFee: string | number;
  tokenX: string;
  tokenY: string;
  walletCount: number;
}

type Match =
  | { wallet: string; pool: string; pair: string; position: string; pnlUsd: number; pnlSol: number; pnlPct: number; closedAt: number | null }
  | { wallet: string; pool: string; pair: string; feesUsd: number; pnlUsd: number; pnlSol: number; positions: number }
  | ({ wallet: string; pool: string; pair: string; lastClosedAt: number } & PoolTotals);

interface StartOptions {
  contract: string;
  mode: Mode;
  criteria: Criteria;
  /** Pakai wallet yang tersimpan untuk contract ini (tidak scan GMGN). */
  reuseWallets: boolean;
  /** Daftar wallet tempelan manual — kalau diisi, scan GMGN dilewati. */
  pastedWallets: string[];
}

interface Job {
  id: number;
  contract: string;
  mode: Mode;
  criteria: Criteria;
  status: JobStatus;
  message: string | null;
  progress: { done: number; total: number };
  gmgn: { pages: number; wallets: number } | null;
  walletSource: 'gmgn' | 'saved' | 'pasted' | null;
  targets: string[];
  poolMap: Map<string, FoundPool & { wallets: Set<string> }>;
  /** Mode PNL PER POOL: total tiap wallet di tiap pool (key "pool|wallet"), sudah didapat di tahap 2. */
  poolTotals: Map<string, FoundPool>;
  selectedPools: string[];
  matches: Match[];
  stats: { wallets: number; checked: number; noData: number; outOfRange: number; failed: number };
  failed: Set<string>;
  log: { t: number; msg: string; level: 'info' | 'warn' | 'match' | 'error' }[];
  startedAt: number;
  finishedAt: number | null;
  aborted: boolean;
}

let current: Job | null = null;
let listener: ((data: unknown) => void) | null = null;
let emitTimer: NodeJS.Timeout | null = null;
let persistTimer: NodeJS.Timeout | null = null;

const shorten = (a: string, head = 6, tail = 4) => (a.length <= head + tail + 1 ? a : `${a.slice(0, head)}…${a.slice(-tail)}`);

/** Dipasang oleh index.ts: meneruskan state job ke browser (SSE). */
export function onTrackUpdate(fn: (data: unknown) => void) {
  listener = fn;
}

function poolSummaries(job: Job): PoolSummary[] {
  return [...job.poolMap.values()].map((p) => ({
    poolAddress: p.poolAddress,
    binStep: p.binStep,
    baseFee: p.baseFee,
    tokenX: p.tokenX,
    tokenY: p.tokenY,
    walletCount: p.wallets.size,
  }));
}

export function jobJson(job: Job | null = current) {
  if (!job) return null;
  return {
    id: job.id,
    contract: job.contract,
    mode: job.mode,
    criteria: job.criteria,
    criteriaText: describeCriteria(job.criteria, job.mode),
    poolText: describePoolCriteria(job.criteria),
    dateText: describeDateRange(job.criteria),
    status: job.status,
    active: ACTIVE.includes(job.status),
    message: job.message,
    progress: job.progress,
    gmgn: job.gmgn,
    walletSource: job.walletSource,
    walletCount: job.targets.length,
    pools: poolSummaries(job),
    selectedPools: job.selectedPools,
    matches: job.matches,
    // Hanya jumlah wallet gagal yang dikirim: daftarnya bisa ribuan alamat dan progress dikirim tiap 300 ms.
    stats: { ...job.stats, failed: job.failed.size },
    log: job.log,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
  };
}

/** Kirim state ke browser; `now` = langsung (pergantian tahap), selain itu di-throttle. */
function emit(job: Job, now = false) {
  if (job !== current || !listener) return;
  if (now) {
    if (emitTimer) clearTimeout(emitTimer);
    emitTimer = null;
    listener(jobJson(job));
    return;
  }
  emitTimer ??= setTimeout(() => {
    emitTimer = null;
    if (job === current) listener?.(jobJson(job));
  }, EMIT_MS);
}

function log(job: Job, msg: string, level: Job['log'][number]['level'] = 'info') {
  job.log.push({ t: Date.now(), msg, level });
  if (job.log.length > LOG_MAX) job.log.splice(0, job.log.length - LOG_MAX);
  emit(job);
}

function persist(job: Job) {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = null;
  const finished = !ACTIVE.includes(job.status);
  store.updateTrackRun(job.id, {
    status: job.status,
    pools: poolSummaries(job).filter((p) => !job.selectedPools.length || job.selectedPools.includes(p.poolAddress)),
    stats: { ...job.stats, failed: job.failed.size },
    matches: job.matches,
    message: job.message,
    finished,
  });
}

/** Simpan hasil sementara, di-throttle (lihat PERSIST_MS). Status akhir selalu disimpan lewat setStatus. */
function persistSoon(job: Job) {
  persistTimer ??= setTimeout(() => {
    persistTimer = null;
    if (ACTIVE.includes(job.status)) persist(job);
  }, PERSIST_MS);
}

function setStatus(job: Job, status: JobStatus, message: string | null = job.message) {
  job.status = status;
  job.message = message;
  if (!ACTIVE.includes(status)) job.finishedAt = Date.now();
  persist(job);
  emit(job, true);
}

function finish(job: Job, status: 'done' | 'cancelled' | 'error', message: string | null = null) {
  if (!ACTIVE.includes(job.status)) return;
  if (message) log(job, message, status === 'error' ? 'error' : 'info');
  setStatus(job, status, message);
}

const onRetry = (job: Job) => (message: string, attempt: number, delayMs: number) =>
  log(job, `gagal (${message}), coba lagi ${attempt} dalam ${delayMs / 1000}s…`, 'warn');

const isBusy = () => !!current && ACTIVE.includes(current.status);

/** Job yang sedang dipegang server dengan id itu, atau TrackError 404. */
function activeJob(id: number) {
  if (!current || current.id !== id) throw new TrackError('Job tidak ditemukan.', 404);
  return current;
}

/** Mulai job baru. Throw jika masih ada job aktif. */
export function startJob(opts: StartOptions) {
  if (isBusy()) throw new TrackError('Masih ada Track Wallet yang berjalan. Hentikan dulu atau tunggu selesai.', 409);

  const id = store.createTrackRun(opts.contract, opts.mode, opts.criteria, 'scanning');
  const job: Job = {
    id,
    contract: opts.contract,
    mode: opts.mode,
    criteria: opts.criteria,
    status: 'scanning',
    message: null,
    progress: { done: 0, total: 0 },
    gmgn: null,
    walletSource: null,
    targets: [],
    poolMap: new Map(),
    poolTotals: new Map(),
    selectedPools: [],
    matches: [],
    stats: { wallets: 0, checked: 0, noData: 0, outOfRange: 0, failed: 0 },
    failed: new Set(),
    log: [],
    startedAt: Date.now(),
    finishedAt: null,
    aborted: false,
  };
  current = job;
  log(job, `Mulai · mode ${MODE_NAMES[opts.mode]}`);
  log(job, `Kriteria: ${describeCriteria(opts.criteria, opts.mode)} · ${describePoolCriteria(opts.criteria)} · ${describeDateRange(opts.criteria)}`);
  emit(job, true);

  void runDiscovery(job, opts).catch((err) => finish(job, 'error', `Gagal: ${describeError(err)}`));
  return job;
}

// ---------- tahap 1 & 2 ----------

async function collectWallets(job: Job, opts: StartOptions) {
  if (opts.pastedWallets.length) {
    job.walletSource = 'pasted';
    store.addTrackWallets(job.contract, opts.pastedWallets);
    log(job, `Tahap 1 — memakai ${opts.pastedWallets.length} wallet yang ditempel (scan GMGN dilewati).`);
    return opts.pastedWallets;
  }

  const existing = store.getTrackWallets(job.contract);
  if (opts.reuseWallets && existing.length) {
    job.walletSource = 'saved';
    log(job, `Tahap 1 — memakai ${existing.length} wallet tersimpan untuk token ini.`);
    return existing;
  }

  job.walletSource = 'gmgn';
  job.gmgn = { pages: 0, wallets: 0 };
  log(job, `Tahap 1 — scan wallet remove liquidity di GMGN…`);
  const scanned = new Set<string>();
  let scanError: string | null = null;
  try {
    await scanRemovers(job.contract, scanned, {
      onRetry: onRetry(job),
      shouldStop: () => job.aborted,
      onPage: ({ page, trades, added, total }) => {
        job.gmgn = { pages: page, wallets: total };
        log(job, `GMGN halaman ${page} · ${trades} tx · +${added} baru · total ${total}`);
      },
    });
  } catch (err) {
    scanError = describeError(err);
    log(job, `Scan GMGN berhenti: ${scanError} — lanjut dengan ${scanned.size} wallet yang sudah didapat.`, 'warn');
  }

  store.addTrackWallets(job.contract, scanned);
  const all = store.getTrackWallets(job.contract);
  if (!all.length && scanError) {
    throw new Error(
      `Scan GMGN gagal (${scanError}). Di VPS Linux, curl bawaan diblokir Cloudflare GMGN — pasang curl-impersonate ` +
        'dan isi GMGN_CURL di .env (lihat DEPLOY.md); bisa juga CLIENT_ID/APP_VER kedaluwarsa. ' +
        'Sementara itu, tempel daftar wallet secara manual di form.',
    );
  }
  log(job, `${scanned.size} wallet dari scan, ${all.length} total tersimpan untuk token ini.`);
  return all;
}

async function runDiscovery(job: Job, opts: StartOptions) {
  const wallets = await collectWallets(job, opts);
  if (job.aborted) return finish(job, 'cancelled', 'Dihentikan.');
  if (!wallets.length) return finish(job, 'done', 'Tidak ada wallet untuk diproses.');

  job.targets = wallets;
  job.stats.wallets = job.targets.length;

  const c = job.criteria;
  const daysBack = daysBackFor(c);
  job.progress = { done: 0, total: job.targets.length };
  setStatus(job, 'pools');
  log(
    job,
    `Tahap 2 — cari pool ${shorten(job.contract)} (${describePoolCriteria(c)}) di ${job.targets.length} wallet ` +
      `[${c.concurrency} paralel${daysBack ? `, days_back=${daysBack}` : ''}]…`,
  );

  const perWallet = await mapLimit(
    job.targets,
    c.concurrency,
    async (wallet) => {
      try {
        const pools = await findPools(wallet, job.contract, {
          onRetry: onRetry(job),
          accept: (p) => matchesPool(p, c),
          daysBack,
          minClosedAt: c.rangeStart,
          shouldStop: () => job.aborted,
        });
        if (pools.length) log(job, `${shorten(wallet)} · ${pools.length} pool cocok`);
        return pools;
      } catch (err) {
        job.failed.add(wallet);
        log(job, `${shorten(wallet)} · GAGAL: ${describeError(err)}`, 'warn');
        return [];
      } finally {
        job.progress.done++;
        emit(job);
      }
    },
    () => job.aborted,
  );
  if (job.aborted) return finish(job, 'cancelled', 'Dihentikan.');

  // Digabung dalam urutan wallet asli supaya urutan pool sama tiap kali dijalankan.
  job.targets.forEach((wallet, i) => {
    for (const pool of perWallet[i] ?? []) {
      if (!job.poolMap.has(pool.poolAddress)) job.poolMap.set(pool.poolAddress, { ...pool, wallets: new Set() });
      job.poolMap.get(pool.poolAddress)!.wallets.add(wallet);
      if (job.mode === MODE_POOL) job.poolTotals.set(`${pool.poolAddress}|${wallet}`, pool);
    }
  });

  if (!job.poolMap.size) {
    const filtered = c.binStep !== null || c.baseFee !== null || c.rangeStart !== null || c.rangeEnd !== null;
    return finish(
      job,
      'done',
      `Tidak ada pool yang memuat token ini di wallet-wallet tersebut.${filtered ? ' Coba longgarkan saringan pool / tanggal.' : ''}`,
    );
  }

  log(job, `${job.poolMap.size} pool ditemukan — pilih pool yang ingin dicek.`);
  setStatus(job, 'awaiting_selection');
}

// ---------- tahap 3 ----------

/** Mode PnL: tiap posisi dinilai sendiri-sendiri. */
function matchPnl(job: Job, wallet: string, pool: string, pair: string, positions: TrackPosition[]) {
  const found: Match[] = [];
  for (const p of positions) {
    // Posisi tanpa riwayat dilaporkan pnl 0 / deposit 0 — jangan ikut dicocokkan.
    if (p.depositsUsd <= 0) {
      job.stats.noData++;
      continue;
    }
    if (!matchesProfit(p, job.criteria)) continue;
    found.push({ wallet, pool, pair, position: p.positionAddress, pnlUsd: p.pnlUsd, pnlSol: p.pnlSol, pnlPct: p.pnlPct, closedAt: p.closedAt });
    log(
      job,
      `COCOK ${shorten(wallet)} · posisi ${shorten(p.positionAddress)} · $${p.pnlUsd.toFixed(2)} · ${p.pnlSol.toFixed(4)} SOL · ${p.pnlPct.toFixed(2)}%`,
      'match',
    );
  }
  return found;
}

/** Mode fees: fee & PnL seluruh posisi wallet di pool dijumlahkan, lalu totalnya yang dicocokkan. */
function matchFees(job: Job, wallet: string, pool: string, pair: string, positions: TrackPosition[]) {
  if (!positions.length) {
    job.stats.noData++;
    return [];
  }
  const total = positions.reduce(
    (acc, p) => ({ feesUsd: acc.feesUsd + p.feesUsd, pnlUsd: acc.pnlUsd + p.pnlUsd, pnlSol: acc.pnlSol + p.pnlSol }),
    { feesUsd: 0, pnlUsd: 0, pnlSol: 0 },
  );
  if (!matchesFees(total, job.criteria)) return [];
  log(job, `COCOK ${shorten(wallet)} @ ${shorten(pool)} · fee $${total.feesUsd.toFixed(2)} · pnl $${total.pnlUsd.toFixed(2)} · ${total.pnlSol.toFixed(4)} SOL · ${positions.length} posisi`, 'match');
  return [{ wallet, pool, pair, ...total, positions: positions.length }] as Match[];
}

/** User memilih pool (atau 'all') — jalankan tahap 3. */
export function selectPools(id: number, pools: string[] | 'all') {
  const job = activeJob(id);
  if (job.status !== 'awaiting_selection') throw new TrackError('Job tidak sedang menunggu pilihan pool.', 409);
  const selected = pools === 'all' ? [...job.poolMap.keys()] : [...new Set(pools)].filter((p) => job.poolMap.has(p));
  if (!selected.length) throw new TrackError('Pilih minimal satu pool.', 409);
  job.selectedPools = selected;
  void runMatching(job).catch((err) => finish(job, 'error', `Gagal: ${describeError(err)}`));
  return job;
}

/** Semua kombinasi wallet + pool dari pool yang dipilih user. */
const walletPoolPairs = (job: Job) =>
  job.selectedPools.flatMap((pool) => [...(job.poolMap.get(pool)?.wallets ?? [])].map((wallet) => ({ pool, wallet })));

/**
 * Mode PNL PER POOL: total per wallet+pool sudah ada dari /portfolio (tahap 2), jadi tidak ada
 * request tambahan. Rentang tanggal disaring lewat lastClosedAt pool.
 */
function runPoolMatching(job: Job) {
  const c = job.criteria;
  const pairs = walletPoolPairs(job);
  job.progress = { done: 0, total: pairs.length };
  setStatus(job, 'matching');
  log(job, `Tahap 3 — cocokkan total ${pairs.length} kombinasi wallet+pool (data dari portfolio, tanpa request tambahan)…`);

  for (const { pool, wallet } of pairs) {
    job.progress.done++;
    const entry = job.poolTotals.get(`${pool}|${wallet}`);
    if (!entry) continue;
    if (!matchesDate(entry.lastClosedAt, c)) {
      job.stats.outOfRange++;
      continue;
    }
    const t = entry.totals;
    // Tanpa deposit sama sekali = tidak ada data; jangan ikut cocok ke target yang dekat 0.
    if (t.depositUsd <= 0 && t.depositSol <= 0) {
      job.stats.noData++;
      continue;
    }
    job.stats.checked++;
    if (!matchesPoolTotals(t, c)) continue;
    const pair = `${entry.tokenX}/${entry.tokenY}`;
    job.matches.push({ wallet, pool, pair, lastClosedAt: entry.lastClosedAt, ...t });
    log(
      job,
      `COCOK ${shorten(wallet)} @ ${shorten(pool)} · deposit $${t.depositUsd.toFixed(2)} · withdraw $${t.withdrawUsd.toFixed(2)} · ` +
        `fee $${t.feeUsd.toFixed(2)} · pnl $${t.pnlUsd.toFixed(2)} (${t.pnlSol.toFixed(4)} SOL, ${t.pnlPct.toFixed(2)}%)`,
      'match',
    );
  }

  const wallets = new Set(job.matches.map((m) => m.wallet)).size;
  finish(job, 'done', `Selesai · ${job.matches.length} kombinasi wallet+pool cocok dari ${wallets} wallet.`);
}

async function runMatching(job: Job) {
  if (job.mode === MODE_POOL) return runPoolMatching(job);
  const c = job.criteria;
  const status = job.mode === MODE_FEES ? STATUS_ALL : STATUS_CLOSED;
  const pairs = walletPoolPairs(job);
  job.progress = { done: 0, total: pairs.length };
  setStatus(job, 'matching');
  log(job, `Tahap 3 — ambil posisi (status=${status}) dari ${pairs.length} kombinasi wallet+pool [${c.concurrency} paralel]…`);

  if (job.mode === MODE_FEES && (c.rangeStart !== null || c.rangeEnd !== null)) {
    log(job, 'Catatan: di mode fees rentang tanggal disaring lewat closedAt, jadi fee posisi yang masih terbuka tidak dihitung.', 'warn');
  }

  await mapLimit(
    pairs,
    c.concurrency,
    async ({ pool, wallet }) => {
      const info = job.poolMap.get(pool)!;
      const pair = `${info.tokenX}/${info.tokenY}`;
      try {
        const { positions, skipped } = await fetchPositions(pool, wallet, {
          onRetry: onRetry(job),
          status,
          acceptPosition: (p) => matchesDate(p.closedAt, c),
          shouldStop: () => job.aborted,
        });
        job.stats.outOfRange += skipped;
        job.stats.checked += positions.length;
        const found = job.mode === MODE_FEES ? matchFees(job, wallet, pool, pair, positions) : matchPnl(job, wallet, pool, pair, positions);
        if (found.length) {
          job.matches.push(...found);
          // Disimpan berkala supaya hasil tidak hilang kalau proses mati di tengah jalan.
          persistSoon(job);
        }
      } catch (err) {
        job.failed.add(wallet);
        log(job, `${shorten(wallet)} @ ${shorten(pool)} · GAGAL: ${describeError(err)}`, 'warn');
      } finally {
        job.progress.done++;
        emit(job);
      }
    },
    () => job.aborted,
  );

  if (job.aborted) return finish(job, 'cancelled', 'Dihentikan — hasil sementara tetap disimpan.');
  const wallets = new Set(job.matches.map((m) => m.wallet)).size;
  finish(job, 'done', `Selesai · ${job.matches.length} ${job.mode === MODE_FEES ? 'kombinasi' : 'posisi'} cocok dari ${wallets} wallet.`);
}

/** Hentikan job aktif. Hasil parsial tetap disimpan. */
export function cancelJob(id: number) {
  const job = activeJob(id);
  if (!ACTIVE.includes(job.status)) return job;
  job.aborted = true;
  // Saat menunggu pilihan pool tidak ada pekerja yang berjalan — langsung selesai.
  if (job.status === 'awaiting_selection') finish(job, 'cancelled', 'Dibatalkan.');
  else log(job, 'Menghentikan… menunggu request yang sedang berjalan selesai.', 'warn');
  return job;
}
