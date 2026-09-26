import type { Num } from '../lib/num.js';
import { getJson } from './http.js';

const BASE = 'https://portfolio.datapi.meteora.ag';

type TimeRange = '1d' | '7d' | '30d' | '1y' | 'ytd' | 'all';


export interface Performance {
  pnl_usd: Num;
  pnl_sol: Num;
  pnl_pct_change: Num;
  pnl_sol_pct_change: Num;
  realized_pnl_usd: Num;
  unrealized_pnl_usd: Num;
  realized_fee_earned_usd: Num;
  unrealized_fee_earned_usd: Num;
  total_deposit_usd: Num;
  win_rate_usd: Num;
  win_count_usd: number;
  loss_count_usd: number;
  open_count: number;
  closed_count: number;
  avg_invested_usd: Num;
  biggest_pnl_usd: Num;
  biggest_pnl_usd_pool?: string;
  biggest_pnl_usd_protocol?: string;
}

export const getPerformance = (wallet: string, range: TimeRange) =>
  getJson<Performance>(`${BASE}/performances/${wallet}`, { time_range: range });

/** Nilai posisi LP wallet + fee belum diklaim (semua protokol Meteora). */
export interface Balances {
  balance_usd: string;
  unclaimed_fee_usd: string;
  balance_sol: string;
  unclaimed_fee_sol?: string;
}

export const getBalances = (wallet: string) => getJson<Balances>(`${BASE}/balances/${wallet}`, { wallet });

export interface CalendarStats {
  pnl_usd: string;
  closed_position_count: number;
  win_count_usd: number;
  loss_count_usd: number;
  fees_earned_usd: string;
}

interface CalendarPoint extends CalendarStats {
  timestamp: number;
  dlmm?: CalendarStats;
  damm_v2?: CalendarStats;
}

/** PnL harian satu bulan (`month` = "YYYY-MM"). */
export const getCalendar = (wallet: string, month: string) =>
  getJson<{ data_points: CalendarPoint[] }>(`${BASE}/chart/calendar/${wallet}`, { month });
