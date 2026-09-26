import * as dlmm from '../api/dlmm.js';
import { mapLimit } from '../lib/concurrent.js';
import { groupBy, num } from '../lib/num.js';
import { loadPoolMeta } from '../services/bins.js';
import { detectStrategyWithin } from '../services/strategy.js';
import { shareOf, type PositionInfo, type Provider, type TokenPair } from './types.js';

const STRATEGY_TIMEOUT_MS = 6000;
/** Posisi baru dibaca strateginya paralel terbatas (tiap posisi = beberapa request RPC). */
const STRATEGY_CONCURRENCY = 3;
/** Detail posisi open: maksimal halaman per pool (100 posisi / halaman). */
const OPEN_MAX_PAGES = 5;
/** API mengurutkan posisi closed dari yang terbaru; 2 halaman cukup untuk menemukan yang baru ditutup. */
const CLOSED_MAX_PAGES = 2;

type Amt = { amount: string | number; usd: string | number } | undefined;
const tok = (a: Amt) => ({ amount: num(a?.amount) ?? 0, usd: num(a?.usd) ?? 0 });
const pairOf = (x: Amt, y: Amt): TokenPair | undefined => (x || y ? { x: tok(x), y: tok(y) } : undefined);

export interface PoolMeta {
  iconX?: string;
  iconY?: string;
}

export function fromPnl(p: dlmm.DlmmPositionPnl, pool: string, pair: string, meta: PoolMeta = {}): PositionInfo {
  const u = p.unrealizedPnl;
  const fees = (num(u?.unclaimedFeeTokenX?.usd) ?? 0) + (num(u?.unclaimedFeeTokenY?.usd) ?? 0);
  const [symbolX, symbolY] = pair.split('-');
  return {
    symbolX,
    symbolY,
    iconX: meta.iconX,
    iconY: meta.iconY,
    claimedFeesUsd: num(p.allTimeFees?.total?.usd),
    breakdown: {
      current: u ? pairOf(u.balanceTokenX, u.balanceTokenY) : undefined,
      unclaimed: u ? pairOf(u.unclaimedFeeTokenX, u.unclaimedFeeTokenY) : undefined,
      claimed: pairOf(p.allTimeFees?.tokenX, p.allTimeFees?.tokenY),
      deposits: pairOf(p.allTimeDeposits?.tokenX, p.allTimeDeposits?.tokenY),
      withdrawals: pairOf(p.allTimeWithdrawals?.tokenX, p.allTimeWithdrawals?.tokenY),
    },
    protocol: 'dlmm',
    position: p.positionAddress,
    pool,
    pair,
    openedAt: p.createdAt,
    closedAt: p.closedAt ?? undefined,
    depositUsd: num(p.allTimeDeposits?.total?.usd),
    depositSol: num(p.allTimeDeposits?.total?.sol),
    withdrawUsd: num(p.allTimeWithdrawals?.total?.usd),
    feesUsd: num(p.allTimeFees?.total?.usd),
    valueUsd: num(p.unrealizedPnl?.balances),
    pnlUsd: num(p.pnlUsd),
    pnlSol: num(p.pnlSol),
    pnlPct: num(p.pnlPctChange),
    minPrice: num(p.minPrice),
    maxPrice: num(p.maxPrice),
    poolPrice: num(p.poolActivePrice),
    outOfRange: p.isOutOfRange,
    bins: p.upperBinId - p.lowerBinId + 1,
    unclaimedFeesUsd: u ? fees : undefined,
    shareY: p.isClosed
      ? shareOf(num(p.allTimeWithdrawals?.tokenX?.usd), num(p.allTimeWithdrawals?.tokenY?.usd))
      : shareOf(num(u?.balanceTokenX?.usd), num(u?.balanceTokenY?.usd)),
  };
}

const byPool = <T extends { pool: string }>(items: T[]) => groupBy(items, (it) => it.pool);

/** Isi strategi (Spot/Curve/BidAsk + porsi %), sisi deposit, dan range saat open; dibatasi waktunya. */
async function attachStrategy(p: PositionInfo) {
  const binStep = await loadPoolMeta(p.pool).then((m) => m.binStep).catch(() => undefined);
  const s = await detectStrategyWithin(p.position, STRATEGY_TIMEOUT_MS, binStep);
  p.strategy = s?.label;
  p.openSide = s?.openSide;
  if (s?.openRange) {
    const r = s.openRange;
    p.openRange = { bins: r.bins, minPct: r.minPct, maxPct: r.maxPct, binStep: r.binStep };
  }
}

export const dlmmProvider: Provider = {
  id: 'dlmm',

  async getOpenPositions(wallet) {
    const { pools } = await dlmm.getAllOpenPools(wallet);
    return pools.flatMap((pool) =>
      pool.listPositions.map<PositionInfo>((position) => ({
        protocol: 'dlmm',
        position,
        pool: pool.poolAddress,
        pair: `${pool.tokenX}-${pool.tokenY}`,
        symbolX: pool.tokenX,
        symbolY: pool.tokenY,
        iconX: pool.tokenXIcon,
        iconY: pool.tokenYIcon,
        poolPrice: pool.poolPrice,
        outOfRange: pool.positionsOutOfRange?.includes(position) ?? false,
      })),
    );
  },

  async enrichOpened(wallet, positions) {
    const result: PositionInfo[] = [];
    for (const [pool, items] of byPool(positions)) {
      const details = new Map<string, dlmm.DlmmPositionPnl>();
      try {
        const list = await dlmm.allPoolPositions(pool, wallet, 'open', { maxPages: OPEN_MAX_PAGES });
        for (const p of list) details.set(p.positionAddress, p);
      } catch {
        // detail opsional; alert tetap dikirim dengan data dasar
      }
      for (const it of items) {
        const d = details.get(it.position);
        result.push(d ? fromPnl(d, pool, it.pair, { iconX: it.iconX, iconY: it.iconY }) : it);
      }
    }
    // Dibatasi waktu (per posisi) dan jumlah paralel supaya alert tidak tertahan dan RPC tidak dibanjiri.
    await mapLimit(result, STRATEGY_CONCURRENCY, attachStrategy);
    return result;
  },

  async findClosed(wallet, positions) {
    const found = new Map<string, PositionInfo>();
    for (const [pool, items] of byPool(positions)) {
      const wanted = new Set(items.map((i) => i.position));
      let pair: string | undefined;
      for await (const batch of dlmm.poolPositionPages(pool, wallet, 'closed', { maxPages: CLOSED_MAX_PAGES })) {
        for (const p of batch) {
          if (!wanted.delete(p.positionAddress)) continue;
          // Nama pair dari metadata pool (di-cache); gagal → tracker memakai pair yang tersimpan.
          pair ??= await loadPoolMeta(pool).then((m) => m.name, () => '');
          found.set(p.positionAddress, fromPnl(p, pool, pair));
        }
        if (!wanted.size) break;
      }
    }
    return found;
  },
};
