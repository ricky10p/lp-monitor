import * as damm from '../api/dammv2.js';
import { shareOf, type PositionInfo, type Provider, type TokenPair } from './types.js';

/** Posisi closed yang dicek saat mencari data close: 3 halaman × 200 = 600 posisi terbaru. */
const CLOSED_MAX_PAGES = 3;
const CLOSED_PAGE_SIZE = 200;

const pairOf = (p: { pool_name?: string; token_x: { symbol: string }; token_y: { symbol: string } }) =>
  p.pool_name || `${p.token_x.symbol}-${p.token_y.symbol}`;

function rangeOf(p: damm.DammOpenPosition | damm.DammClosedPosition) {
  const cfg = p.pool_config;
  if (!cfg?.concentrated_liquidity) return { fullRange: true };
  return { minPrice: cfg.min_price, maxPrice: cfg.max_price };
}

const pairAmt = (a?: damm.DammAmounts): TokenPair | undefined =>
  a ? { x: { amount: a.amount_x ?? 0, usd: a.amount_x_usd ?? 0 }, y: { amount: a.amount_y ?? 0, usd: a.amount_y_usd ?? 0 } } : undefined;

const tokenMeta = (p: damm.DammOpenPosition | damm.DammClosedPosition) => ({
  symbolX: p.token_x.symbol,
  symbolY: p.token_y.symbol,
  iconX: p.token_x.icon,
  iconY: p.token_y.icon,
});

/** Porsi token Y dari jumlah DAMM (nilai USD token X & Y). */
const shareOfAmounts = (a?: damm.DammAmounts) => shareOf(a?.amount_x_usd ?? 0, a?.amount_y_usd ?? 0);

export function fromOpen(p: damm.DammOpenPosition): PositionInfo {
  const { minPrice, maxPrice, fullRange } = rangeOf(p);
  const price = p.pool_price;
  return {
    protocol: 'dammv2',
    position: p.position_address,
    pool: p.pool_address,
    pair: pairOf(p),
    openedAt: p.created_at,
    depositUsd: damm.sumUsd(p.total_deposits),
    depositSol: damm.sumSol(p.total_deposits),
    valueUsd: damm.sumUsd(p.current_position?.current_deposits),
    feesUsd: damm.sumUsd(p.current_position?.unclaimed_fees) + damm.sumUsd(p.total_claimed_fees),
    unclaimedFeesUsd: damm.sumUsd(p.current_position?.unclaimed_fees),
    claimedFeesUsd: damm.sumUsd(p.total_claimed_fees),
    shareY: shareOfAmounts(p.current_position?.current_deposits),
    fullRange,
    ...tokenMeta(p),
    breakdown: {
      current: pairAmt(p.current_position?.current_deposits),
      unclaimed: pairAmt(p.current_position?.unclaimed_fees),
      claimed: pairAmt(p.total_claimed_fees),
      deposits: pairAmt(p.total_deposits),
      withdrawals: pairAmt(p.total_withdraws),
    },
    pnlUsd: p.unrealized_pnl,
    pnlSol: p.pnl_sol,
    pnlPct: p.unrealized_pnl_change_pct,
    minPrice,
    maxPrice,
    poolPrice: price,
    outOfRange:
      price !== undefined && minPrice !== undefined && maxPrice !== undefined
        ? price < minPrice || price > maxPrice
        : undefined,
  };
}

export function fromClosed(p: damm.DammClosedPosition): PositionInfo {
  return {
    protocol: 'dammv2',
    position: p.position_address,
    pool: p.pool_address,
    pair: pairOf(p),
    openedAt: p.created_at,
    closedAt: p.closed_at,
    depositUsd: damm.sumUsd(p.total_deposits),
    depositSol: damm.sumSol(p.total_deposits),
    withdrawUsd: damm.sumUsd(p.total_withdraws),
    feesUsd: damm.sumUsd(p.total_claimed_fees),
    claimedFeesUsd: damm.sumUsd(p.total_claimed_fees),
    ...tokenMeta(p),
    breakdown: {
      claimed: pairAmt(p.total_claimed_fees),
      deposits: pairAmt(p.total_deposits),
      withdrawals: pairAmt(p.total_withdraws),
    },
    pnlUsd: p.pnl,
    pnlSol: p.pnl_sol,
    pnlPct: p.pnl_change_pct,
    shareY: shareOfAmounts(p.total_withdraws),
    ...rangeOf(p),
  };
}

export const dammv2Provider: Provider = {
  id: 'dammv2',

  async getOpenPositions(wallet) {
    const positions = await damm.getAllOpenPositions(wallet);
    return positions.map(fromOpen);
  },

  // getOpenPositions sudah membawa detail lengkap.
  async enrichOpened(_wallet, positions) {
    return positions;
  },

  async findClosed(wallet, positions) {
    const wanted = new Set(positions.map((p) => p.position));
    const found = new Map<string, PositionInfo>();
    let cursor: string | undefined;
    // Diurutkan dari yang terbaru ditutup.
    for (let page = 0; page < CLOSED_MAX_PAGES && wanted.size > 0; page++) {
      const res = await damm.getClosedPositions(wallet, CLOSED_PAGE_SIZE, cursor);
      for (const p of res.data) {
        if (wanted.delete(p.position_address)) found.set(p.position_address, fromClosed(p));
      }
      cursor = res.next_cursor ?? undefined;
      if (!cursor) break;
    }
    return found;
  },
};
