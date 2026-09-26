/**
 * Distribusi likuiditas posisi DLMM per bin — data untuk grafik bin ala Meteora.
 *
 * Posisi OPEN dibaca langsung dari chain (sama seperti SDK/UI Meteora):
 *   PositionV2 (bytemuck): disc 8 · lb_pair 32 · owner 32 · liquidity_shares u128×70 ·
 *     reward_infos 48×70 · fee_infos 48×70 · lower_bin_id i32 · upper_bin_id i32 · … = 8120 byte.
 *     Posisi > 70 bin menyimpan bin tambahan setelah itu, 112 byte per bin (share u128 + reward 48 + fee 48).
 *   BinArray: disc 8 · index i64 · version+pad 8 · lb_pair 32 → header 56, lalu 70 Bin × 144 byte
 *     (amount_x u64 @0, amount_y u64 @8, liquidity_supply u128 @32). Indeks array = floor(binId / 70).
 *   Jumlah milik posisi di satu bin = amount_bin × share / liquidity_supply.
 * Diverifikasi: total X/Y hasil baca on-chain sama persis dengan unrealizedPnl API Meteora.
 *
 * Posisi CLOSED: akunnya sudah dihapus dari chain, jadi distribusinya DIPERKIRAKAN dari transaksi
 * add (lihat strategy.ts): by_strategy → sebaran linier per sisi sesuai strategi; rebalance →
 * base + delta × jarak dari active bin. Remove diabaikan, jadi ini gambaran saat posisi dibuka.
 */
import * as dlmmApi from '../api/dlmm.js';
import { base58Encode, getAccountInfo, getProgramAccounts } from '../api/solana.js';
import { TtlCache } from '../lib/cache.js';
import { mapLimit } from '../lib/concurrent.js';
import { detectStrategy, distribute, type StrategyAdd } from './strategy.js';

const DLMM_PROGRAM = dlmmApi.DLMM_PROGRAM_ID;
const BINS_PER_ARRAY = 70;
// Layout akun PositionV2 (lihat komentar di atas).
const POSITION_SHARES_OFFSET = 8 + 32 + 32;
const POSITION_RANGE_OFFSET = POSITION_SHARES_OFFSET + 16 * BINS_PER_ARRAY + 48 * BINS_PER_ARRAY * 2;
const POSITION_BASE_SIZE = 8120;
const POSITION_EXT_BIN_SIZE = 112;
const BIN_ARRAY_HEADER = 56;
const BIN_SIZE = 144;
const BIN_ARRAY_SIZE = BIN_ARRAY_HEADER + BINS_PER_ARRAY * BIN_SIZE;
/** getProgramAccounts termasuk metode RPC paling berat; bin array dibaca paralel terbatas. */
const BIN_ARRAY_CONCURRENCY = 3;

interface BinPoint {
  binId: number;
  /** Harga token X dalam token Y. */
  price: number;
  x: number;
  y: number;
  valueUsd: number;
}

interface PositionBins {
  source: 'onchain' | 'reconstructed';
  pool: string;
  symbolX: string;
  symbolY: string;
  priceXUsd: number;
  priceYUsd: number;
  binStep: number;
  activeBin: number;
  currentPrice: number;
  lowerBinId: number;
  upperBinId: number;
  bins: BinPoint[];
  totals: { x: number; y: number; usd: number };
  note?: string;
}

// ---------- cache ----------

const META_TTL_MS = 60_000;
/** Posisi open berubah terus — cache singkat. Posisi closed (rekonstruksi) tidak berubah — simpan lama. */
const OPEN_BINS_TTL_MS = 15_000;
const CLOSED_BINS_TTL_MS = 10 * 60_000;
const cache = new TtlCache(META_TTL_MS, 500);

// ---------- metadata pool ----------

interface PoolMeta {
  /** Nama pair dari API, mis. "ETCH-SOL". */
  name: string;
  symbolX: string;
  symbolY: string;
  decX: number;
  decY: number;
  priceXUsd: number;
  priceYUsd: number;
  binStep: number;
  /** Base fee pool dalam % (mis. 1 = 1%). */
  baseFeePct: number;
  currentPrice: number;
  activeBin: number;
}

export const loadPoolMeta = (pool: string) =>
  cache.get(`meta:${pool}`, async (): Promise<PoolMeta> => {
    const p = await dlmmApi.getPool(pool);
    const binStep = p.pool_config.bin_step;
    const decX = p.token_x.decimals;
    const decY = p.token_y.decimals;
    // current_price = (1 + binStep/10000)^activeId × 10^(decX − decY)
    const activeBin = Math.round(Math.log(p.current_price / 10 ** (decX - decY)) / Math.log(1 + binStep / 10_000));
    return {
      name: p.name ?? `${p.token_x.symbol}-${p.token_y.symbol}`,
      symbolX: p.token_x.symbol,
      symbolY: p.token_y.symbol,
      decX,
      decY,
      priceXUsd: Number(p.token_x.price) || 0,
      priceYUsd: Number(p.token_y.price) || 0,
      binStep,
      baseFeePct: Number(p.pool_config.base_fee_pct) || 0,
      currentPrice: p.current_price,
      activeBin,
    };
  });

const binPrice = (binId: number, m: PoolMeta) => (1 + m.binStep / 10_000) ** binId * 10 ** (m.decX - m.decY);

function toResult(
  source: PositionBins['source'],
  pool: string,
  m: PoolMeta,
  lower: number,
  upper: number,
  amounts: Map<number, { x: number; y: number }>,
  note?: string,
): PositionBins {
  const bins: BinPoint[] = [];
  let tx = 0;
  let ty = 0;
  for (let b = lower; b <= upper; b++) {
    const a = amounts.get(b) ?? { x: 0, y: 0 };
    tx += a.x;
    ty += a.y;
    bins.push({ binId: b, price: binPrice(b, m), x: a.x, y: a.y, valueUsd: a.x * m.priceXUsd + a.y * m.priceYUsd });
  }
  return {
    source,
    pool,
    symbolX: m.symbolX,
    symbolY: m.symbolY,
    priceXUsd: m.priceXUsd,
    priceYUsd: m.priceYUsd,
    binStep: m.binStep,
    activeBin: m.activeBin,
    currentPrice: m.currentPrice,
    lowerBinId: lower,
    upperBinId: upper,
    bins,
    totals: { x: tx, y: ty, usd: tx * m.priceXUsd + ty * m.priceYUsd },
    note,
  };
}

// ---------- posisi open (on-chain) ----------

const readU128 = (buf: Buffer, offset: number) => buf.readBigUInt64LE(offset) + (buf.readBigUInt64LE(offset + 8) << 64n);

/** Jumlah token (unit terkecil) dibagi 10^decimals tanpa kehilangan presisi di angka besar. */
const units = (raw: bigint, decimals: number) => Number(raw) / 10 ** decimals;

async function fetchBinArray(lbPair: string, index: number) {
  const idx = Buffer.alloc(8);
  idx.writeBigInt64LE(BigInt(index));
  const res = await getProgramAccounts(DLMM_PROGRAM, [
    { dataSize: BIN_ARRAY_SIZE },
    { memcmp: { offset: 8, bytes: base58Encode(idx) } },
    { memcmp: { offset: 24, bytes: lbPair } },
  ]);
  return res[0]?.data;
}

async function onchainBins(data: Buffer, pool: string): Promise<PositionBins> {
  const lbPair = base58Encode(data.subarray(8, 40));
  const m = await loadPoolMeta(lbPair);
  const lower = data.readInt32LE(POSITION_RANGE_OFFSET);
  const upper = data.readInt32LE(POSITION_RANGE_OFFSET + 4);
  const share = (k: number) =>
    k < BINS_PER_ARRAY
      ? readU128(data, POSITION_SHARES_OFFSET + 16 * k)
      : readU128(data, POSITION_BASE_SIZE + (k - BINS_PER_ARRAY) * POSITION_EXT_BIN_SIZE);

  const indexes = [...new Set(Array.from({ length: upper - lower + 1 }, (_, k) => Math.floor((lower + k) / BINS_PER_ARRAY)))];
  const arrays = await mapLimit(indexes, BIN_ARRAY_CONCURRENCY, async (i) => [i, await fetchBinArray(lbPair, i)] as const);

  const amounts = new Map<number, { x: number; y: number }>();
  for (const entry of arrays) {
    if (!entry?.[1]) continue;
    const [index, arr] = entry;
    for (let j = 0; j < BINS_PER_ARRAY; j++) {
      const binId = index * BINS_PER_ARRAY + j;
      if (binId < lower || binId > upper) continue;
      const s = share(binId - lower);
      if (s === 0n) continue;
      const o = BIN_ARRAY_HEADER + j * BIN_SIZE;
      const supply = readU128(arr, o + 32);
      if (supply === 0n) continue;
      amounts.set(binId, {
        x: units((arr.readBigUInt64LE(o) * s) / supply, m.decX),
        y: units((arr.readBigUInt64LE(o + 8) * s) / supply, m.decY),
      });
    }
  }
  return toResult('onchain', pool || lbPair, m, lower, upper, amounts);
}

// ---------- posisi closed (rekonstruksi dari transaksi add) ----------

/** Jumlahkan distribusi semua bagian add (lihat distribute() di strategy.ts), dalam satuan token. */
function reconstruct(adds: StrategyAdd[], m: PoolMeta) {
  const amounts = new Map<number, { x: number; y: number }>();
  for (const a of adds) {
    for (const d of distribute(a)) {
      const cur = amounts.get(d.bin) ?? { x: 0, y: 0 };
      cur.x += d.x / 10 ** m.decX;
      cur.y += d.y / 10 ** m.decY;
      amounts.set(d.bin, cur);
    }
  }
  return amounts;
}

async function reconstructedBins(position: string, pool: string): Promise<PositionBins> {
  const [m, strategy] = await Promise.all([loadPoolMeta(pool), detectStrategy(position)]);
  const adds = strategy.adds.filter((a) => a.minBinId !== undefined && a.maxBinId !== undefined);
  if (!adds.length) {
    return { ...toResult('reconstructed', pool, m, m.activeBin, m.activeBin, new Map()), bins: [], note: 'Transaksi add posisi ini tidak bisa dibaca.' };
  }
  const lower = Math.min(...adds.map((a) => a.minBinId!));
  const upper = Math.max(...adds.map((a) => a.maxBinId!));
  const custom = strategy.adds.some((a) => a.method === 'custom');
  return toResult(
    'reconstructed',
    pool,
    m,
    lower,
    upper,
    reconstruct(adds, m),
    custom ? 'Sebagian add memakai distribusi custom yang tidak bisa direkonstruksi.' : undefined,
  );
}

// ---------- entry point ----------

/** Distribusi per bin posisi DLMM: akurat dari chain jika masih open, perkiraan jika sudah ditutup. */
export function loadPositionBins(position: string, pool: string): Promise<PositionBins> {
  const key = `bins:${position}`;
  return cache.get(
    key,
    async () => {
      const account = await getAccountInfo(position);
      if (account && account.owner === DLMM_PROGRAM && account.data.length >= POSITION_BASE_SIZE) {
        return onchainBins(account.data, pool);
      }
      // Posisi sudah ditutup — hasil rekonstruksi tidak berubah, simpan lebih lama.
      const result = await reconstructedBins(position, pool);
      cache.set(key, Promise.resolve(result), CLOSED_BINS_TTL_MS);
      return result;
    },
    { ttlMs: OPEN_BINS_TTL_MS },
  );
}
