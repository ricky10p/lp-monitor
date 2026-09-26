// Riwayat posisi closed yang dimuat per halaman (lazy).
// Halaman berikutnya baru diambil dari API saat diminta (user klik Next).
//
// DAMM v2 punya endpoint ber-cursor, DLMM hanya per pool. Kedua sumber digabung
// berurutan dari yang terakhir ditutup: sebuah posisi baru "dikeluarkan" ke halaman
// jika dijamin tidak ada posisi lebih baru yang belum diambil dari sumber mana pun.
import * as dlmmApi from '../api/dlmm.js';
import * as dammApi from '../api/dammv2.js';
import { describeError } from '../api/http.js';
import { TtlCache } from '../lib/cache.js';
import { fromClosed as dammFromClosed } from '../providers/dammv2.js';
import { fromPnl as dlmmFromPnl } from '../providers/dlmm.js';
import { PROTOCOLS, type PositionInfo, type ProtocolId } from '../providers/types.js';

const PAGE_SIZE = 100;
const DLMM_POOLS_PER_FETCH = 5;
/** Pool yang diambil per request /portfolio saat mengisi antrean. */
const DLMM_POOLS_PER_PAGE = 50;
/** Batas halaman posisi closed per pool (100 posisi / halaman). */
const DLMM_MAX_PAGES_PER_POOL = 50;
/** Batas pengambilan per permintaan halaman, pengaman dari loop tak berujung. */
const MAX_FETCHES_PER_PAGE = 500;
const PAGER_TTL_MS = 10 * 60_000;
/** Pager menyimpan semua posisi yang sudah dimuat; batasi jumlahnya agar memori tidak tumbuh terus. */
const MAX_PAGERS = 50;
const TOTALS_TTL_MS = 60_000;

const byClosedDesc = (a: PositionInfo, b: PositionInfo) => (b.closedAt ?? 0) - (a.closedAt ?? 0);

interface Stream {
  /** Batas atas closedAt untuk posisi yang BELUM diambil (-Infinity jika habis). */
  frontier(): number;
  exhausted(): boolean;
  /** Ambil batch berikutnya ke buffer. */
  fetchMore(): Promise<void>;
  /** Keluarkan posisi di buffer dengan closedAt >= bound. */
  take(bound: number): PositionInfo[];
}

function takeFrom(buffer: PositionInfo[], bound: number) {
  const out: PositionInfo[] = [];
  for (let i = buffer.length - 1; i >= 0; i--) {
    if ((buffer[i].closedAt ?? 0) >= bound) out.push(...buffer.splice(i, 1));
  }
  return out;
}

class DammStream implements Stream {
  private buffer: PositionInfo[] = [];
  private cursor: string | undefined;
  private started = false;
  private done = false;
  private oldest = Infinity;
  constructor(private wallet: string) {}

  frontier() {
    if (this.done) return -Infinity;
    return this.started ? this.oldest : Infinity;
  }
  exhausted() {
    return this.done;
  }
  async fetchMore() {
    const res = await dammApi.getClosedPositions(this.wallet, PAGE_SIZE, this.cursor);
    this.started = true;
    const list = res.data.map(dammFromClosed);
    this.buffer.push(...list);
    for (const p of list) this.oldest = Math.min(this.oldest, p.closedAt ?? 0);
    this.cursor = res.next_cursor ?? undefined;
    if (!this.cursor || !list.length) this.done = true;
  }
  take(bound: number) {
    return takeFrom(this.buffer, bound);
  }
}

class DlmmStream implements Stream {
  private buffer: PositionInfo[] = [];
  private queue: dlmmApi.DlmmPortfolioPool[] = [];
  private poolPage = 0;
  private morePools = true;
  private started = false;
  constructor(private wallet: string) {}

  private async refillQueue() {
    if (!this.morePools || this.queue.length) return;
    const res = await dlmmApi.getPortfolio(this.wallet, ++this.poolPage, DLMM_POOLS_PER_PAGE);
    this.queue.push(...res.pools);
    this.morePools = res.hasNext && res.pools.length > 0;
  }
  frontier() {
    if (!this.started) return Infinity;
    if (this.queue.length) return this.queue[0].lastClosedAt;
    return this.morePools ? Infinity : -Infinity;
  }
  exhausted() {
    return this.started && !this.queue.length && !this.morePools;
  }
  async fetchMore() {
    await this.refillQueue();
    this.started = true;
    const pools = this.queue.splice(0, DLMM_POOLS_PER_FETCH);
    const lists = await Promise.all(pools.map((pool) => this.poolClosed(pool)));
    this.buffer.push(...lists.flat());
    await this.refillQueue();
  }
  private async poolClosed(pool: dlmmApi.DlmmPortfolioPool) {
    const pair = `${pool.tokenX}-${pool.tokenY}`;
    const meta = { iconX: pool.tokenXIcon, iconY: pool.tokenYIcon };
    const list = await dlmmApi.allPoolPositions(pool.poolAddress, this.wallet, 'closed', { maxPages: DLMM_MAX_PAGES_PER_POOL });
    return list.map((p) => dlmmFromPnl(p, pool.poolAddress, pair, meta));
  }
  take(bound: number) {
    return takeFrom(this.buffer, bound);
  }
}

class Pager {
  /** Semua posisi yang sudah dikeluarkan, urut dari yang terakhir ditutup. */
  emitted: PositionInfo[] = [];
  errors: string[] = [];
  lastAccess = Date.now();
  private lock: Promise<unknown> = Promise.resolve();
  constructor(private streams: Stream[]) {}

  get exhausted() {
    return this.streams.every((s) => s.exhausted());
  }

  private flush() {
    const bound = Math.max(...this.streams.map((s) => s.frontier()));
    const ready = this.streams.flatMap((s) => s.take(bound)).sort(byClosedDesc);
    this.emitted.push(...ready);
  }

  /** Pastikan minimal `count` posisi sudah tersedia (atau sumber habis). */
  ensure(count: number) {
    const run = this.lock.then(async () => {
      this.flush();
      let guard = 0;
      while (this.emitted.length < count && !this.exhausted && guard++ < MAX_FETCHES_PER_PAGE) {
        // Ambil dari sumber yang paling "menahan" (frontier tertinggi).
        const next = this.streams
          .filter((s) => !s.exhausted())
          .sort((a, b) => b.frontier() - a.frontier())[0];
        try {
          await next.fetchMore();
        } catch (err) {
          this.errors.push(describeError(err));
          break;
        }
        this.flush();
      }
    });
    this.lock = run.catch(() => undefined);
    return run;
  }
}

export type HistoryFilter = ProtocolId | 'all';
const pagers = new Map<string, Pager>();

function getPager(wallet: string, filter: HistoryFilter, fresh: boolean) {
  const now = Date.now();
  for (const [k, p] of pagers) if (now - p.lastAccess > PAGER_TTL_MS) pagers.delete(k);
  const key = `${wallet}:${filter}`;
  if (fresh) for (const f of ['all', ...PROTOCOLS]) pagers.delete(`${wallet}:${f}`);
  let pager = pagers.get(key);
  if (!pager) {
    const streams: Stream[] = [];
    if (filter !== 'dammv2') streams.push(new DlmmStream(wallet));
    if (filter !== 'dlmm') streams.push(new DammStream(wallet));
    pager = new Pager(streams);
  }
  // Dipindah ke belakang Map (paling baru dipakai); yang paling lama dibuang jika melebihi batas.
  pagers.delete(key);
  pagers.set(key, pager);
  while (pagers.size > MAX_PAGERS) pagers.delete(pagers.keys().next().value!);
  pager.lastAccess = now;
  return pager;
}

// Total posisi closed (untuk "x dari N"), di-cache sebentar. Gagal dibaca → dianggap 0 (hanya info).
const totals = new TtlCache(TOTALS_TTL_MS, 200);
const closedTotals = (wallet: string) =>
  totals.get(wallet, async () => {
    const [dlmm, dammv2] = await Promise.all([
      dlmmApi.getPortfolio(wallet, 1, 1).then((r) => r.totalPositions ?? 0, () => 0),
      dammApi.getWalletTotals(wallet).then((r) => r.total_closed_positions ?? 0, () => 0),
    ]);
    return { dlmm, dammv2 };
  });

/** Satu halaman riwayat (100 posisi). Halaman berikutnya diambil dari API hanya jika belum pernah dimuat. */
export async function historyPage(wallet: string, filter: HistoryFilter, page: number, fresh = false) {
  const pager = getPager(wallet, filter, fresh);
  const start = Math.max(0, page) * PAGE_SIZE;
  const [count] = await Promise.all([closedTotals(wallet), pager.ensure(start + PAGE_SIZE)]);
  const total = filter === 'all' ? count.dlmm + count.dammv2 : count[filter];
  const items = pager.emitted.slice(start, start + PAGE_SIZE);
  return {
    page,
    pageSize: PAGE_SIZE,
    items,
    hasNext: pager.emitted.length > start + PAGE_SIZE || !pager.exhausted,
    total,
    loaded: pager.emitted.length,
    errors: pager.errors.slice(-3),
  };
}
