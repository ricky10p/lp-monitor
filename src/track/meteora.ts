/**
 * Meteora DLMM untuk Track Wallet — cari pool yang memuat token tertentu, lalu ambil posisi + PnL-nya.
 * Semua request lewat api/dlmm.ts (retry, format, dan pagination yang sama dengan bagian lain).
 *
 * Soal angka PnL: metlex.io/pnl-cards menghitung sendiri dari /positions/{position}/historical
 *   pnl = Σ totalUsd(remove) − Σ totalUsd(add) + Σ totalUsd(claim_fee|claim_reward)
 * Hasilnya sudah dibandingkan pada 14 posisi dan IDENTIK dengan field `pnlUsd` / `pnlPctChange`
 * dari endpoint /positions/{pool}/pnl, jadi angkanya diambil langsung dari sini.
 */
import { getPortfolio, poolPositionPages, type DlmmPortfolioPool } from '../api/dlmm.js';
import { num, num0, type Num } from '../lib/num.js';
import type { OnRetry } from '../lib/retry.js';

// Endpoint /portfolio tidak membatasi page_size (diuji sampai 5000; wallet 1855 pool ~720 KB dalam 1 request).
// 1000 = sedikit request, respons tetap wajar; pagination tetap dijalankan sebagai pengaman.
const PORTFOLIO_PAGE_SIZE = 1000;
/** Track Wallet menjalankan banyak request paralel; retry lebih banyak dari default. */
const RETRIES = 2;

// Mode PnL memakai 'closed'; mode fees memakai 'all' supaya fee posisi yang masih terbuka ikut terhitung.
export const STATUS_CLOSED = 'closed';
export const STATUS_ALL = 'all';
type TrackStatus = typeof STATUS_CLOSED | typeof STATUS_ALL;

export interface FoundPool {
  poolAddress: string;
  binStep: Num;
  baseFee: Num;
  tokenX: string;
  tokenY: string;
  lastClosedAt: number;
  /** Total seluruh posisi wallet di pool ini (= jumlah semua posisi di /positions/{pool}/pnl). */
  totals: PoolTotals;
}

export interface PoolTotals {
  depositUsd: number;
  depositSol: number;
  withdrawUsd: number;
  withdrawSol: number;
  feeUsd: number;
  feeSol: number;
  pnlUsd: number;
  pnlSol: number;
  pnlPct: number;
}

export interface TrackPosition {
  positionAddress: string;
  pnlUsd: number;
  pnlSol: number;
  pnlPct: number;
  depositsUsd: number;
  feesUsd: number;
  isClosed: boolean;
  createdAt: number | null;
  closedAt: number | null;
}

const toFoundPool = (pool: DlmmPortfolioPool): FoundPool => ({
  poolAddress: pool.poolAddress,
  binStep: pool.binStep,
  baseFee: pool.baseFee,
  tokenX: pool.tokenX,
  tokenY: pool.tokenY,
  lastClosedAt: pool.lastClosedAt,
  totals: {
    depositUsd: num0(pool.totalDeposit),
    depositSol: num0(pool.totalDepositSol),
    withdrawUsd: num0(pool.totalWithdrawal),
    withdrawSol: num0(pool.totalWithdrawalSol),
    feeUsd: num0(pool.totalFee),
    feeSol: num0(pool.totalFeeSol),
    pnlUsd: num0(pool.pnlUsd),
    pnlSol: num0(pool.pnlSol),
    pnlPct: num0(pool.pnlPctChange),
  },
});

/**
 * Semua pool di portfolio wallet yang salah satu sisinya token `mint`.
 * `daysBack` disaring di sisi server; `minClosedAt` menghentikan paging begitu pool lebih tua
 * (pool terurut menurun berdasarkan lastClosedAt).
 */
export async function findPools(
  wallet: string,
  mint: string,
  {
    onRetry,
    accept,
    daysBack,
    minClosedAt,
    shouldStop,
  }: {
    onRetry?: OnRetry;
    accept?: (p: FoundPool) => boolean;
    daysBack?: number | null;
    minClosedAt?: number | null;
    /** Dicek sebelum tiap halaman — untuk membatalkan job. */
    shouldStop?: () => boolean;
  } = {},
) {
  const found: FoundPool[] = [];
  for (let page = 1; !shouldStop?.(); page++) {
    const res = await getPortfolio(wallet, page, PORTFOLIO_PAGE_SIZE, { daysBack, onRetry, retries: RETRIES });
    const pools = Array.isArray(res.pools) ? res.pools : [];
    for (const pool of pools) {
      if (minClosedAt && pool.lastClosedAt < minClosedAt) return found;
      if (pool.tokenXMint !== mint && pool.tokenYMint !== mint) continue;
      const entry = toFoundPool(pool);
      if (!accept || accept(entry)) found.push(entry);
    }
    if (!res.hasNext || pools.length === 0) break;
  }
  return found;
}

/**
 * Semua posisi satu wallet di satu pool, lengkap dengan PnL.
 * `depositsUsd` dipakai mendeteksi posisi tanpa data (pnl 0 / deposit 0).
 * Jumlah `feesUsd` seluruh posisi = `total_claims_usd` di metlex.io/fees (diverifikasi pada 7 pasangan).
 * Posisi yang ditolak `acceptPosition` tidak dikembalikan, tapi dihitung di `skipped`.
 */
export async function fetchPositions(
  pool: string,
  wallet: string,
  {
    onRetry,
    acceptPosition,
    status = STATUS_CLOSED,
    shouldStop,
  }: {
    onRetry?: OnRetry;
    acceptPosition?: (p: TrackPosition) => boolean;
    status?: TrackStatus;
    shouldStop?: () => boolean;
  } = {},
) {
  const positions: TrackPosition[] = [];
  let skipped = 0;
  for await (const batch of poolPositionPages(pool, wallet, status, { onRetry, shouldStop, retries: RETRIES })) {
    for (const pos of batch) {
      if (!pos?.positionAddress) continue;
      const position: TrackPosition = {
        positionAddress: pos.positionAddress,
        pnlUsd: num0(pos.pnlUsd),
        pnlSol: num0(pos.pnlSol),
        pnlPct: num0(pos.pnlPctChange),
        depositsUsd: num0(pos.allTimeDeposits?.total?.usd),
        feesUsd: num0(pos.allTimeFees?.total?.usd),
        isClosed: Boolean(pos.isClosed),
        createdAt: num(pos.createdAt) || null,
        closedAt: num(pos.closedAt) || null,
      };
      if (acceptPosition && !acceptPosition(position)) {
        skipped += 1;
        continue;
      }
      positions.push(position);
    }
  }
  return { positions, skipped };
}
