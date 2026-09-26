import type { Num } from '../lib/num.js';
import { getJson, type GetOptions } from './http.js';

const BASE = 'https://dlmm.datapi.meteora.ag';

/** Program DLMM Meteora di Solana (pemilik akun posisi & bin array). */
export const DLMM_PROGRAM_ID = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';

interface DlmmOpenPool {
  poolAddress: string;
  binStep: Num;
  baseFee: Num;
  tokenX: string;
  tokenY: string;
  tokenXMint: string;
  tokenYMint: string;
  tokenXIcon?: string;
  tokenYIcon?: string;
  balances: Num;
  balancesSol: Num;
  unclaimedFees: Num;
  unclaimedFeesSol: Num;
  pnl: Num;
  pnlSol: Num;
  pnlPctChange: Num;
  totalDeposit: Num;
  totalDepositSol: Num;
  openPositionCount: number;
  listPositions: string[];
  outOfRange: boolean;
  positionsOutOfRange: string[];
  poolPrice: number;
}

interface DlmmOpenTotal {
  totalPositions: number;
  balances: Num;
  balancesSol: Num;
  unclaimedFees: Num;
  unclaimedFeesSol: Num;
  pnl: Num;
  pnlSol: Num;
  pnlPctChange: Num;
  pnlSolPctChange: Num;
}

interface DlmmOpenResponse {
  page: number;
  pageSize: number;
  hasNext: boolean;
  totalCount: number;
  totalPositions: number;
  total?: DlmmOpenTotal;
  solPrice?: Num;
  pools: DlmmOpenPool[];
}

interface UsdSol {
  usd: Num;
  sol: Num;
}

interface TokenAmount {
  amount: Num;
  usd: Num;
  amountSol: Num;
}

interface Breakdown {
  tokenX: TokenAmount;
  tokenY: TokenAmount;
  total: UsdSol;
}

export interface DlmmPositionPnl {
  positionAddress: string;
  minPrice: Num;
  maxPrice: Num;
  lowerBinId: number;
  upperBinId: number;
  poolActiveBinId: number;
  poolActivePrice: Num;
  isOutOfRange: boolean;
  isClosed: boolean;
  createdAt: number;
  closedAt: number | null;
  pnlUsd: Num;
  pnlSol: Num;
  pnlPctChange: Num;
  pnlSolPctChange: Num;
  allTimeDeposits: Breakdown;
  allTimeWithdrawals: Breakdown;
  allTimeFees: Breakdown;
  unrealizedPnl?: {
    balances: Num;
    balancesSol: Num;
    balanceTokenX?: TokenAmount;
    balanceTokenY?: TokenAmount;
    unclaimedFeeTokenX?: TokenAmount;
    unclaimedFeeTokenY?: TokenAmount;
  };
}

interface DlmmPoolPositionsResponse {
  tokenX: string;
  tokenY: string;
  totalCount: number;
  page: number;
  pageSize: number;
  hasNext: boolean;
  positions: DlmmPositionPnl[];
}

interface DlmmPoolInfo {
  address: string;
  name: string;
  token_x: { symbol: string; address: string; decimals: number; price: number };
  token_y: { symbol: string; address: string; decimals: number; price: number };
  current_price: number;
  tvl: number;
  pool_config: { bin_step: number; base_fee_pct: number };
}

export const getOpenPortfolio = (wallet: string, page = 1, pageSize = 100) =>
  getJson<DlmmOpenResponse>(`${BASE}/portfolio/open`, { user: wallet, page, page_size: pageSize });

/** Semua pool DLMM yang masih punya posisi open (mengikuti pagination). */
export async function getAllOpenPools(wallet: string) {
  const pools: DlmmOpenPool[] = [];
  let total: DlmmOpenTotal | undefined;
  for (let page = 1; ; page++) {
    const res = await getOpenPortfolio(wallet, page, 100);
    total ??= res.total;
    pools.push(...res.pools);
    if (!res.hasNext || res.pools.length === 0) break;
  }
  return { pools, total };
}

/** 'all' = open + closed (dipakai mode Fee di Track Wallet). */
type PositionStatus = 'open' | 'closed' | 'all';
const POSITIONS_PAGE_SIZE = 100;

const getPoolPositions = (pool: string, wallet: string, status: PositionStatus, page = 1, pageSize = POSITIONS_PAGE_SIZE, opts?: GetOptions) =>
  getJson<DlmmPoolPositionsResponse>(`${BASE}/positions/${pool}/pnl`, { user: wallet, status, page, page_size: pageSize }, opts);

/**
 * Posisi satu wallet di satu pool, per halaman (100 posisi), sampai habis / `maxPages` / `shouldStop`.
 * Dipakai bersama oleh tracker, halaman portfolio, riwayat, dan Track Wallet — konsumen bisa berhenti
 * lebih awal (mis. begitu posisi yang dicari sudah ketemu) cukup dengan `break`.
 */
export async function* poolPositionPages(
  pool: string,
  wallet: string,
  status: PositionStatus,
  { maxPages = Infinity, shouldStop, ...opts }: GetOptions & { maxPages?: number; shouldStop?: () => boolean } = {},
) {
  for (let page = 1; page <= maxPages && !shouldStop?.(); page++) {
    const res = await getPoolPositions(pool, wallet, status, page, POSITIONS_PAGE_SIZE, opts);
    const batch = Array.isArray(res.positions) ? res.positions : [];
    yield batch;
    if (!res.hasNext || !batch.length) return;
  }
}

/** Semua posisi dari poolPositionPages dalam satu array. */
export async function allPoolPositions(...args: Parameters<typeof poolPositionPages>) {
  const out: DlmmPositionPnl[] = [];
  for await (const batch of poolPositionPages(...args)) out.push(...batch);
  return out;
}

/** Pool di /portfolio (pool yang pernah punya posisi closed), terurut dari yang terakhir ditutup. */
export interface DlmmPortfolioPool {
  poolAddress: string;
  tokenX: string;
  tokenY: string;
  tokenXMint: string;
  tokenYMint: string;
  binStep: Num;
  baseFee: Num;
  tokenXIcon?: string;
  tokenYIcon?: string;
  lastClosedAt: number;
  // Total seluruh posisi wallet di pool ini (= jumlah semua posisi di /positions/{pool}/pnl).
  totalDeposit?: Num;
  totalDepositSol?: Num;
  totalWithdrawal?: Num;
  totalWithdrawalSol?: Num;
  totalFee?: Num;
  totalFeeSol?: Num;
  pnlUsd?: Num;
  pnlSol?: Num;
  pnlPctChange?: Num;
}

interface DlmmPortfolio {
  page: number;
  hasNext: boolean;
  totalCount: number;
  totalPositions: number;
  pools: DlmmPortfolioPool[];
}

/** Pool yang punya posisi closed. `daysBack` disaring di sisi server. */
export const getPortfolio = (wallet: string, page = 1, pageSize = 10, { daysBack, ...opts }: GetOptions & { daysBack?: number | null } = {}) =>
  getJson<DlmmPortfolio>(`${BASE}/portfolio`, { user: wallet, page, page_size: pageSize, days_back: daysBack ?? undefined }, opts);

export const getPool = (pool: string) => getJson<DlmmPoolInfo>(`${BASE}/pools/${pool}`);

export interface DlmmPositionEvent {
  signature: string;
  eventType: 'add' | 'remove' | 'claim_fee' | 'claim_reward' | string;
  blockTime: number;
  amountX: string;
  amountY: string;
  amountXUsd: string;
  amountYUsd: string;
  totalUsd: string;
}

/** Riwayat event satu posisi (add / remove / claim), terbaru dulu. */
export const getPositionHistory = (position: string) =>
  getJson<{ events: DlmmPositionEvent[] }>(`${BASE}/positions/${position}/historical`);
