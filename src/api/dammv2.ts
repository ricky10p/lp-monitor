import { getJson } from './http.js';

const BASE = 'https://damm-v2.datapi.meteora.ag';

export interface DammAmounts {
  amount_x: number;
  amount_y: number;
  amount_x_usd: number;
  amount_y_usd: number;
  amount_x_sol: number;
  amount_y_sol: number;
}

interface DammToken {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  icon?: string;
}

interface DammPositionBase {
  position_address: string;
  pool_address: string;
  pool_name?: string;
  token_x: DammToken;
  token_y: DammToken;
  pool_config?: { concentrated_liquidity?: boolean; min_price?: number; max_price?: number; base_fee_pct?: number };
  created_at: number;
  total_deposits: DammAmounts;
  total_withdraws: DammAmounts;
  total_claimed_fees: DammAmounts;
  pnl_sol?: number;
  pnl_sol_pct_change?: number;
}

export interface DammOpenPosition extends DammPositionBase {
  pool_price?: number;
  current_position?: {
    current_deposits: DammAmounts;
    unclaimed_fees: DammAmounts;
  };
  unrealized_pnl?: number;
  unrealized_pnl_change_pct?: number;
}

export interface DammClosedPosition extends DammPositionBase {
  is_closed: boolean;
  closed_at: number;
  pnl?: number;
  pnl_change_pct?: number;
}

interface DammTotal {
  balances: number;
  unclaimed_fees: number;
  unclaimed_rewards: number;
  total_deposits: number;
  pnl: number;
  pnl_pct_change: number;
  balances_sol: number;
  pnl_sol?: number;
}

interface Paged<T> {
  data: T[];
  limit: number;
  next_cursor: string | null;
}

interface DammOpenResponse extends Paged<DammOpenPosition> {
  total_positions: number;
  total: DammTotal;
  sol_price: number;
}

export const getOpenPositions = (wallet: string, limit = 500, cursor?: string) =>
  getJson<DammOpenResponse>(`${BASE}/wallets/${wallet}/open_positions`, { limit, next_cursor: cursor });

/** Semua posisi DAMM v2 yang masih open (mengikuti cursor). */
export async function getAllOpenPositions(wallet: string) {
  const positions: DammOpenPosition[] = [];
  let cursor: string | undefined;
  do {
    const res = await getOpenPositions(wallet, 500, cursor);
    positions.push(...res.data);
    cursor = res.next_cursor ?? undefined;
  } while (cursor);
  return positions;
}

interface DammOpenTotalResponse {
  total_positions: number;
  /** Jumlah posisi yang muncul di daftar open_positions. */
  aggregated_positions: number;
  total: DammTotal;
  sol_price: number;
}

/** Total seluruh posisi open (field `total` di open_positions hanya untuk halaman itu). */
export const getOpenTotal = (wallet: string) =>
  getJson<DammOpenTotalResponse>(`${BASE}/wallets/${wallet}/open_positions/total`);

export const getClosedPositions = (wallet: string, limit = 100, cursor?: string) =>
  getJson<Paged<DammClosedPosition>>(`${BASE}/wallets/${wallet}/closed_positions`, {
    limit,
    next_cursor: cursor,
  });

export const sumUsd = (a?: DammAmounts) => (a ? (a.amount_x_usd ?? 0) + (a.amount_y_usd ?? 0) : 0);
export const sumSol = (a?: DammAmounts) => (a ? (a.amount_x_sol ?? 0) + (a.amount_y_sol ?? 0) : 0);

/** Ringkasan wallet, dipakai untuk jumlah total posisi closed. */
export const getWalletTotals = (wallet: string) => getJson<{ total_closed_positions?: number }>(`${BASE}/wallets/${wallet}/total`);
