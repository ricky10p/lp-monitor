import * as dlmmApi from '../api/dlmm.js';
import * as dammApi from '../api/dammv2.js';
import { describeError } from '../api/http.js';
import { getBalances, getCalendar, getPerformance, type CalendarStats, type Performance } from '../api/portfolio.js';
import { getSolBalance, getUsdcBalance } from '../api/solana.js';
import type { Wallet } from '../db.js';
import { TtlCache } from '../lib/cache.js';
import { mapLimit } from '../lib/concurrent.js';
import { num } from '../lib/num.js';
import { fromOpen as dammFromOpen } from '../providers/dammv2.js';
import { fromPnl as dlmmFromPnl } from '../providers/dlmm.js';
import type { PositionInfo } from '../providers/types.js';

/** Angka API atau NaN (dibedakan dari 0 agar "gagal dibaca" tidak tampil sebagai $0). */
const n = (v: string | number | null | undefined) => num(v) ?? NaN;

// Cache singkat supaya pindah halaman / tombol tidak memanggil API berulang kali.
const cache = new TtlCache(20_000, 500);
const OVERVIEW_TTL_MS = 60_000;
const CALENDAR_TTL_MS = 120_000;
const SOL_PRICE_TTL_MS = 60_000;
/** Pool DLMM per wallet yang dibaca bersamaan di halaman portfolio. */
const POOL_CONCURRENCY = 4;
/** Maksimal halaman posisi open per pool (100 posisi / halaman). */
const OPEN_MAX_PAGES = 5;
/** Wallet yang diringkas bersamaan di dashboard (tiap wallet = 2 request). */
const SUMMARY_CONCURRENCY = 4;

/** Ubah promise gagal jadi Error berisi pesan yang aman ditampilkan (tidak melempar). */
async function settle<T>(p: Promise<T>): Promise<T | Error> {
  try {
    return await p;
  } catch (err) {
    return new Error(describeError(err));
  }
}

const valueOr = <T, F>(v: T | Error, fallback: F) => (v instanceof Error ? fallback : v);

// ---------- posisi open (per posisi) ----------

interface OpenPositions {
  positions: PositionInfo[];
  errors: string[];
  updatedAt: number;
}

async function fetchOpenDlmm(wallet: string): Promise<PositionInfo[]> {
  const { pools } = await dlmmApi.getAllOpenPools(wallet);
  const lists = await mapLimit(pools, POOL_CONCURRENCY, async (pool) => {
    const pair = `${pool.tokenX}-${pool.tokenY}`;
    const meta = { iconX: pool.tokenXIcon, iconY: pool.tokenYIcon };
    const list = await dlmmApi.allPoolPositions(pool.poolAddress, wallet, 'open', { maxPages: OPEN_MAX_PAGES });
    return list.map((p) => dlmmFromPnl(p, pool.poolAddress, pair, meta));
  });
  return lists.flatMap((l) => l ?? []);
}

async function fetchOpen(wallet: string): Promise<OpenPositions> {
  const [dlmm, damm] = await Promise.all([
    settle(fetchOpenDlmm(wallet)),
    settle(dammApi.getAllOpenPositions(wallet).then((list) => list.map(dammFromOpen))),
  ]);
  const errors: string[] = [];
  if (dlmm instanceof Error) errors.push(`DLMM: ${dlmm.message}`);
  if (damm instanceof Error) errors.push(`DAMM V2: ${damm.message}`);
  const positions = [...valueOr(dlmm, []), ...valueOr(damm, [])].sort((a, b) => (b.openedAt ?? 0) - (a.openedAt ?? 0));
  return { positions, errors, updatedAt: Date.now() };
}

export const loadOpen = (wallet: string, fresh = false) => cache.get(`open:${wallet}`, () => fetchOpen(wallet), { fresh });

// ---------- ringkasan portfolio ----------

/** Pool DLMM SOL-USDC Meteora (TVL besar) — sumber harga SOL untuk menilai saldo SOL/USDC wallet. */
const SOL_USDC_POOL = 'BGm1tav58oGcsQJehL9WXBFXF7D27vZsKefj4xJKD5Y';
const loadSolPrice = () =>
  cache.get('solPrice', () => dlmmApi.getPool(SOL_USDC_POOL).then((p) => n(p.current_price)), { ttlMs: SOL_PRICE_TTL_MS });

interface Overview {
  /** Nilai LP (DLMM + DAMM v2) + fee belum diklaim + saldo SOL & USDC di wallet. */
  netWorthUsd: number;
  netWorthSol: number;
  /** Nilai LP + fee belum diklaim saja (dari Meteora). */
  lpUsd: number;
  unclaimedFeeUsd: number;
  /** Saldo USDC di wallet (bukan di posisi LP); dinilai $1 per USDC. NaN jika RPC gagal. */
  usdcBalance: number;
  /** Saldo SOL native di wallet. NaN jika RPC gagal. */
  solBalance: number;
  solPrice: number;
  all: Performance | null;
  month: Performance | null;
  errors: string[];
}

async function fetchOverview(wallet: string): Promise<Overview> {
  const [bal, all, month, usdc, solBal, price] = await Promise.all([
    settle(getBalances(wallet)),
    settle(getPerformance(wallet, 'all')),
    settle(getPerformance(wallet, '30d')),
    settle(getUsdcBalance(wallet)),
    settle(getSolBalance(wallet)),
    settle(loadSolPrice()),
  ]);
  const errors = [bal, all, month].filter((r): r is Error => r instanceof Error).map((e) => e.message);
  if (usdc instanceof Error) errors.push(`Saldo USDC: ${usdc.message}`);
  if (solBal instanceof Error) errors.push(`Saldo SOL: ${solBal.message}`);
  if (price instanceof Error) errors.push(`Harga SOL: ${price.message}`);

  // Balances Meteora hanya menghitung posisi LP (0 jika tidak ada posisi aktif), jadi saldo
  // SOL & USDC yang diam di wallet dibaca terpisah lewat RPC lalu dijumlahkan.
  const b = valueOr(bal, undefined);
  const unclaimed = b ? n(b.unclaimed_fee_usd) : 0;
  const lpUsd = b ? n(b.balance_usd) + unclaimed : NaN;
  const lpSol = b ? n(b.balance_sol) + (n(b.unclaimed_fee_sol) || 0) : NaN;
  const usdcBalance = valueOr(usdc, NaN);
  const solBalance = valueOr(solBal, NaN);
  const p = valueOr(price, NaN);
  const solPrice = p > 0 ? p : NaN;
  const fin = (v: number) => (Number.isFinite(v) ? v : 0);

  return {
    netWorthUsd: fin(lpUsd) + fin(usdcBalance) + (Number.isFinite(solPrice) ? fin(solBalance) * solPrice : 0),
    netWorthSol: fin(lpSol) + fin(solBalance) + (Number.isFinite(solPrice) ? fin(usdcBalance) / solPrice : 0),
    lpUsd,
    unclaimedFeeUsd: unclaimed,
    usdcBalance,
    solBalance,
    solPrice,
    all: valueOr(all, null),
    month: valueOr(month, null),
    errors,
  };
}

export const loadOverview = (wallet: string, fresh = false) =>
  cache.get(`ov:${wallet}`, () => fetchOverview(wallet), { fresh, ttlMs: OVERVIEW_TTL_MS });

// ---------- kalender profit ----------

type DayStat = { pnl: number; closed: number; wins: number; losses: number; fees: number };

interface CalendarDay {
  date: string;
  all: DayStat;
  dlmm: DayStat;
  dammv2: DayStat;
}

const statOf = (s?: CalendarStats): DayStat => ({
  pnl: s ? n(s.pnl_usd) || 0 : 0,
  closed: s?.closed_position_count ?? 0,
  wins: s?.win_count_usd ?? 0,
  losses: s?.loss_count_usd ?? 0,
  fees: s ? n(s.fees_earned_usd) || 0 : 0,
});

async function fetchCalendar(wallet: string, month: string): Promise<CalendarDay[]> {
  const res = await getCalendar(wallet, month);
  return res.data_points.map((p) => ({
    date: new Date(p.timestamp * 1000).toISOString().slice(0, 10),
    all: statOf(p),
    dlmm: statOf(p.dlmm),
    dammv2: statOf(p.damm_v2),
  }));
}

export const loadCalendar = (wallet: string, month: string, fresh = false) =>
  cache.get(`cal:${wallet}:${month}`, () => fetchCalendar(wallet, month), { fresh, ttlMs: CALENDAR_TTL_MS });

// ---------- ringkasan semua wallet (dashboard) ----------

interface ProtocolSummary {
  count: number;
  valueUsd: number;
  pnlUsd: number;
  pnlPct?: number;
}

interface WalletSummary {
  wallet: Wallet;
  dlmm: ProtocolSummary | Error;
  damm: ProtocolSummary | Error;
}

type DlmmOpen = Awaited<ReturnType<typeof dlmmApi.getOpenPortfolio>>;
type DammOpenTotal = Awaited<ReturnType<typeof dammApi.getOpenTotal>>;

const dlmmSummary = (d: DlmmOpen): ProtocolSummary => ({
  count: d.totalPositions ?? 0,
  valueUsd: d.total ? n(d.total.balances) : 0,
  pnlUsd: d.total ? n(d.total.pnl) : 0,
  pnlPct: d.total ? n(d.total.pnlPctChange) : undefined,
});

const dammSummary = (m: DammOpenTotal): ProtocolSummary => ({
  count: m.aggregated_positions ?? m.total_positions ?? 0,
  valueUsd: m.total?.balances ?? 0,
  pnlUsd: m.total?.pnl ?? 0,
  pnlPct: m.total?.pnl_pct_change,
});

async function fetchSummary(w: Wallet): Promise<WalletSummary> {
  const [d, m] = await Promise.all([settle(dlmmApi.getOpenPortfolio(w.address, 1, 1)), settle(dammApi.getOpenTotal(w.address))]);
  return { wallet: w, dlmm: d instanceof Error ? d : dlmmSummary(d), damm: m instanceof Error ? m : dammSummary(m) };
}

/** Ringkasan semua wallet, paralel terbatas agar wallet banyak tidak membanjiri API sekaligus. */
export async function loadSummary(wallets: Wallet[], fresh = false) {
  const list = await mapLimit(wallets, SUMMARY_CONCURRENCY, (w) => cache.get(`sum:${w.address}`, () => fetchSummary(w), { fresh }));
  return list.filter((s): s is WalletSummary => !!s);
}
