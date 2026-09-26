/**
 * Strategi likuiditas posisi DLMM (Spot / Curve / BidAsk, atau gabungannya), porsi % tiap strategi,
 * dan sisi deposit saat posisi dibuka (single side token X / Y, atau double side).
 *
 * API Meteora tidak menyimpan strategi. Strategi hanya ada di data instruksi transaksi
 * add-liquidity on-chain, jadi transaksi add posisi diambil lewat RPC lalu di-decode:
 *
 *  - add_liquidity_by_strategy / add_liquidity_by_strategy2 / add_liquidity_by_strategy_one_side:
 *    field `strategyType` (enum IDL: SpotOneSide, CurveOneSide, BidAskOneSide, SpotBalanced,
 *    CurveBalanced, BidAskBalanced, SpotImBalanced, CurveImBalanced, BidAskImBalanced),
 *    jadi `strategyType % 3` → 0 Spot, 1 Curve, 2 BidAsk.
 *  - rebalance_liquidity (fitur rebalance UI Meteora / bot): tiap `adds[]` membawa x0/y0 (basis) dan
 *    delta_x/delta_y (kemiringan per bin, tanda negatif di bit_flag). Dari builder SDK:
 *    delta 0 → Spot, delta negatif → Curve (makin jauh makin kecil), delta positif → BidAsk.
 *    Sisi X dan Y bisa berbeda bentuk, jadi dipecah per sisi.
 *  - add_liquidity / by_weight / one_side(_precise): distribusi custom → "Custom".
 *
 * Porsi % = bagian nilai USD yang di-deposit lewat tiap strategi (nilai per transaksi dari event
 * add API Meteora, dibagi ke tiap bagian sesuai jumlah token mentahnya).
 *
 * Diverifikasi dengan SDK @meteora-ag/dlmm 1.9.14 dan posisi nyata. Hasil decode disimpan di SQLite;
 * dibaca ulang hanya jika jumlah transaksi add posisi berubah.
 */
import { createHash } from 'node:crypto';
import * as dlmmApi from '../api/dlmm.js';
import { describeError } from '../api/http.js';
import { base58Decode, getSignaturesForAddress, getTransaction, type RpcInstruction, type RpcTransaction } from '../api/solana.js';
import * as store from '../db.js';
import { mapLimit } from '../lib/concurrent.js';
import { groupBy } from '../lib/num.js';

const DLMM_PROGRAM = dlmmApi.DLMM_PROGRAM_ID;
const STRATEGIES = ['Spot', 'Curve', 'BidAsk'] as const;
type StrategyName = (typeof STRATEGIES)[number] | 'Custom';
type DepositSide = 'x' | 'y' | 'both';

/** Maksimal transaksi add yang dibaca per posisi (bot rebalance bisa punya puluhan). */
const MAX_TX = 20;
const TX_CONCURRENCY = 3;

/** Naikkan jika isi StrategyAdd berubah — cache lama otomatis dibaca ulang. */
const DECODE_VERSION = 3;

/** Bentuk satu sisi distribusi rebalance: jumlah di bin = base ± delta × jarak dari active bin. */
interface SideShape {
  side: 'x' | 'y';
  base: string;
  delta: string;
  negative: boolean;
  /** Active bin diisi sisi X (favor_x_in_active_id) atau Y. */
  favorX: boolean;
}

export interface StrategyAdd {
  v: number;
  signature: string;
  /** Unix detik. */
  time: number | null;
  method: 'strategy' | 'rebalance' | 'custom';
  instruction: string;
  strategy: StrategyName;
  minBinId?: number;
  maxBinId?: number;
  /** Active bin saat add. */
  activeId?: number;
  /** Jumlah token mentah (u64 sebagai string) yang masuk lewat bagian ini, per sisi. */
  rawX?: string;
  rawY?: string;
  /** rebalance_liquidity: bentuk distribusi sisi ini. */
  shape?: SideShape;
  // ---- diisi saat dibaca dari event API (tidak disimpan di cache) ----
  /** Jumlah token transaksi add ini (seluruh bagian dalam satu signature), dalam satuan token. */
  tokenX?: number;
  tokenY?: number;
  /** Nilai USD bagian ini saat deposit. */
  usd?: number;
}

interface StrategyMix {
  strategy: StrategyName;
  usd: number;
  pct: number;
}

interface StrategyResult {
  /** Mis. "Spot", "BidAsk 86% + Spot 14%", "Custom"; null jika tidak ada transaksi add yang bisa dibaca. */
  label: string | null;
  /** Porsi tiap strategi (urut kemunculan). */
  mix: StrategyMix[];
  /** true jika porsi dihitung dari jumlah token mentah (nilai USD belum tersedia di API). */
  mixEstimated: boolean;
  /** Sisi deposit pada transaksi add pertama (saat posisi dibuka). */
  openSide: DepositSide | null;
  openAmounts: { x: number; y: number } | null;
  adds: StrategyAdd[];
  cached: boolean;
}

// ---------- decoding ----------

/** Discriminator instruksi Anchor = sha256("global:<nama>")[0..8]. */
const disc = (name: string) => createHash('sha256').update(`global:${name}`).digest().subarray(0, 8).toString('hex');

const STRATEGY_IX: Record<string, { name: string; typeOffset: number; binOffset: number }> = {
  // disc(8) + amountX(8) + amountY(8) + activeId(4) + slippage(4) → minBin, maxBin, strategyType
  [disc('add_liquidity_by_strategy')]: { name: 'add_liquidity_by_strategy', typeOffset: 40, binOffset: 32 },
  [disc('add_liquidity_by_strategy2')]: { name: 'add_liquidity_by_strategy2', typeOffset: 40, binOffset: 32 },
  // disc(8) + amount(8) + activeId(4) + slippage(4) → minBin, maxBin, strategyType
  [disc('add_liquidity_by_strategy_one_side')]: { name: 'add_liquidity_by_strategy_one_side', typeOffset: 32, binOffset: 24 },
};
const REBALANCE_IX = disc('rebalance_liquidity');
const CUSTOM_IX = new Map(
  [
    'add_liquidity',
    'add_liquidity2',
    'add_liquidity_by_weight',
    'add_liquidity_by_weight2',
    'add_liquidity_one_side',
    'add_liquidity_one_side_precise',
    'add_liquidity_one_side_precise2',
  ].map((n) => [disc(n), n]),
);

const shapeStrategy = (delta: bigint, negative: boolean): StrategyName => (delta === 0n ? 'Spot' : negative ? 'Curve' : 'BidAsk');

/** Bin sisi X / Y dari satu add: bin di atas harga berisi X, di bawah berisi Y; active bin milik satu sisi. */
function sideBins(side: 'x' | 'y', lo: number, hi: number, active: number, favorX: boolean) {
  const out: number[] = [];
  if (side === 'x') for (let b = Math.max(lo, favorX ? active : active + 1); b <= hi; b++) out.push(b);
  else for (let b = Math.min(hi, favorX ? active - 1 : active); b >= lo; b--) out.push(b);
  return out; // urut dari yang terdekat ke active bin
}

/**
 * Distribusi satu bagian add per bin (unit token mentah). Dipakai untuk porsi % strategi dan
 * untuk rekonstruksi grafik bin posisi yang sudah ditutup (bins.ts).
 * - rebalance: jumlah persis dari parameter (base ± delta × jarak).
 * - by_strategy / one_side: perkiraan linier sesuai bentuk strategi, total per sisi = jumlah add.
 */
export function distribute(a: StrategyAdd): { bin: number; x: number; y: number }[] {
  if (a.minBinId === undefined || a.maxBinId === undefined || a.activeId === undefined) return [];
  const lo = a.minBinId;
  const hi = a.maxBinId;
  const act = a.activeId;

  if (a.shape) {
    const s = a.shape;
    const base = Number(s.base);
    const delta = Number(s.delta) * (s.negative ? -1 : 1);
    return sideBins(s.side, lo, hi, act, s.favorX).map((bin) => {
      const v = Math.max(0, base + delta * Math.abs(bin - act));
      return { bin, x: s.side === 'x' ? v : 0, y: s.side === 'y' ? v : 0 };
    });
  }

  const out = new Map<number, { bin: number; x: number; y: number }>();
  const spread = (side: 'x' | 'y', bins: number[], amount: number) => {
    if (!bins.length || !(amount > 0)) return;
    const n = bins.length;
    const w = bins.map((_, dist) => (a.strategy === 'Curve' ? n - dist : a.strategy === 'BidAsk' ? dist + 1 : 1));
    const total = w.reduce((p, q) => p + q, 0);
    bins.forEach((bin, i) => {
      const cur = out.get(bin) ?? { bin, x: 0, y: 0 };
      cur[side] += (amount * w[i]) / total;
      out.set(bin, cur);
    });
  };
  const rx = Number(a.rawX ?? 0);
  const ry = Number(a.rawY ?? 0);
  // Dua sisi terisi → active bin dipakai sisi Y saja supaya tidak dihitung dua kali.
  spread('x', sideBins('x', lo, hi, act, !(rx > 0 && ry > 0)), rx);
  spread('y', sideBins('y', lo, hi, act, false), ry);
  return [...out.values()];
}

/** Decode parameter rebalance_liquidity → satu bagian per sisi (X / Y) per `adds[]`. */
function decodeRebalance(raw: Buffer, base: AddBase): StrategyAdd[] {
  let o = 8;
  const activeId = raw.readInt32LE(o);
  // active_id i32, slippage u16, claim_fee bool, claim_reward bool, 4 × u64, shrink_mode u8, padding [u8; 31]
  o += 4 + 2 + 1 + 1 + 32 + 1 + 31;
  const removes = raw.readUInt32LE(o);
  o += 4;
  for (let i = 0; i < removes; i++) {
    // Option<i32> min_bin_id, Option<i32> max_bin_id, u16 bps, [u8; 16] padding
    for (let k = 0; k < 2; k++) o += 1 + (raw[o] ? 4 : 0);
    o += 2 + 16;
  }
  const count = raw.readUInt32LE(o);
  o += 4;
  const out: StrategyAdd[] = [];
  for (let i = 0; i < count; i++) {
    // min_delta_id i32, max_delta_id i32, x0, y0, delta_x, delta_y (u64), bit_flag u8, favor_x_in_active_id bool, [u8; 16]
    const minDelta = raw.readInt32LE(o);
    const maxDelta = raw.readInt32LE(o + 4);
    const x0 = raw.readBigUInt64LE(o + 8);
    const y0 = raw.readBigUInt64LE(o + 16);
    const dx = raw.readBigUInt64LE(o + 24);
    const dy = raw.readBigUInt64LE(o + 32);
    const flag = raw[o + 40];
    const favorX = raw[o + 41] === 1;
    o += 4 + 4 + 32 + 1 + 1 + 16;

    const sides: SideShape[] = [];
    if (x0 !== 0n || dx !== 0n) sides.push({ side: 'x', base: String(x0), delta: String(dx), negative: (flag & 4) !== 0, favorX });
    if (y0 !== 0n || dy !== 0n) sides.push({ side: 'y', base: String(y0), delta: String(dy), negative: (flag & 8) !== 0, favorX });
    for (const shape of sides) {
      const part: StrategyAdd = {
        ...base,
        method: 'rebalance',
        instruction: 'rebalance_liquidity',
        strategy: shapeStrategy(BigInt(shape.delta), shape.negative),
        minBinId: activeId + minDelta,
        maxBinId: activeId + maxDelta,
        activeId,
        shape,
      };
      const total = distribute(part).reduce((sum, b) => sum + b.x + b.y, 0);
      part[shape.side === 'x' ? 'rawX' : 'rawY'] = String(Math.round(total));
      out.push(part);
    }
  }
  return out;
}

type AddBase = Pick<StrategyAdd, 'v' | 'signature' | 'time'>;

/**
 * add_liquidity_by_strategy(2) / _one_side: range bin, active bin, jumlah token, dan strategyType.
 * by_strategy(2): amountX @8, amountY @16, activeId @24. one_side: amount @8, activeId @16.
 */
function decodeStrategyIx(raw: Buffer, s: (typeof STRATEGY_IX)[string], base: AddBase): StrategyAdd {
  const oneSide = s.name === 'add_liquidity_by_strategy_one_side';
  const minBinId = raw.readInt32LE(s.binOffset);
  const maxBinId = raw.readInt32LE(s.binOffset + 4);
  const activeId = raw.readInt32LE(oneSide ? 16 : 24);
  let rawX: string;
  let rawY: string;
  if (oneSide) {
    // Sisi one_side ditentukan letak range terhadap harga: di atas → token X, di bawah → token Y.
    const isX = minBinId >= activeId || maxBinId - activeId > activeId - minBinId;
    const amount = String(raw.readBigUInt64LE(8));
    [rawX, rawY] = isX ? [amount, '0'] : ['0', amount];
  } else {
    rawX = String(raw.readBigUInt64LE(8));
    rawY = String(raw.readBigUInt64LE(16));
  }
  return {
    ...base,
    method: 'strategy',
    instruction: s.name,
    strategy: STRATEGIES[raw[s.typeOffset] % 3],
    minBinId,
    maxBinId,
    activeId,
    rawX,
    rawY,
  };
}

/** Decode satu instruksi DLMM jadi bagian add (kosong jika bukan instruksi add yang dikenal). */
function decodeAddIx(raw: Buffer, base: AddBase): StrategyAdd[] {
  const d = raw.subarray(0, 8).toString('hex');
  const s = STRATEGY_IX[d];
  if (s && raw.length > s.typeOffset) return [decodeStrategyIx(raw, s, base)];
  if (d === REBALANCE_IX) {
    try {
      return decodeRebalance(raw, base);
    } catch {
      return []; // layout tidak dikenal (versi program baru) — lewati
    }
  }
  const custom = CUSTOM_IX.get(d);
  return custom ? [{ ...base, method: 'custom', instruction: custom, strategy: 'Custom' }] : [];
}

/** Semua instruksi add-liquidity program DLMM untuk `position` di satu transaksi. */
function decodeAdds(tx: RpcTransaction, position: string, signature: string): StrategyAdd[] {
  if (!tx.meta || tx.meta.err) return [];
  const keys = [
    ...tx.transaction.message.accountKeys,
    ...(tx.meta.loadedAddresses?.writable ?? []),
    ...(tx.meta.loadedAddresses?.readonly ?? []),
  ];
  const instructions: RpcInstruction[] = [
    ...tx.transaction.message.instructions,
    ...(tx.meta.innerInstructions ?? []).flatMap((g) => g.instructions),
  ];
  const time = tx.blockTime ?? null;
  const adds: StrategyAdd[] = [];

  for (const ix of instructions) {
    if (keys[ix.programIdIndex] !== DLMM_PROGRAM) continue;
    if (!ix.accounts.some((a) => keys[a] === position)) continue;
    let raw: Buffer;
    try {
      raw = base58Decode(ix.data);
    } catch {
      continue;
    }
    if (raw.length >= 8) adds.push(...decodeAddIx(raw, { v: DECODE_VERSION, signature, time }));
  }
  return adds;
}

// ---------- label, porsi, sisi deposit ----------

const byTime = (a: StrategyAdd, b: StrategyAdd) => (a.time ?? 0) - (b.time ?? 0);

/**
 * Bagian yang menentukan label & porsi. Add 1 bin (mis. isi ulang active bin saat rebalance) tidak
 * punya bentuk distribusi, jadi diabaikan selama ada add yang lebih lebar.
 */
function shapedParts(adds: StrategyAdd[]) {
  const singleBin = (a: StrategyAdd) => a.minBinId !== undefined && a.minBinId === a.maxBinId;
  return adds.some((a) => !singleBin(a)) ? adds.filter((a) => !singleBin(a)) : adds;
}

interface SigInfo {
  x: number;
  y: number;
  usdX: number;
  usdY: number;
  time: number;
}

/** Ringkasan event add API per signature (jumlah token & nilai USD saat deposit). */
function eventsBySignature(events: dlmmApi.DlmmPositionEvent[]) {
  const map = new Map<string, SigInfo>();
  for (const e of events) {
    if (e.eventType !== 'add') continue;
    const cur = map.get(e.signature) ?? { x: 0, y: 0, usdX: 0, usdY: 0, time: e.blockTime };
    cur.x += Number(e.amountX) || 0;
    cur.y += Number(e.amountY) || 0;
    cur.usdX += Number(e.amountXUsd) || 0;
    cur.usdY += Number(e.amountYUsd) || 0;
    cur.time = Math.min(cur.time, e.blockTime);
    map.set(e.signature, cur);
  }
  return map;
}

/** Isi tokenX/tokenY/usd tiap bagian dari event API: nilai transaksi dibagi sesuai jumlah token mentah. */
function attachValues(adds: StrategyAdd[], sigs: Map<string, SigInfo>) {
  for (const [sig, parts] of groupBy(adds, (a) => a.signature)) {
    const info = sigs.get(sig);
    const sumX = parts.reduce((s, p) => s + Number(p.rawX ?? 0), 0);
    const sumY = parts.reduce((s, p) => s + Number(p.rawY ?? 0), 0);
    for (const p of parts) {
      if (info) {
        p.tokenX = info.x;
        p.tokenY = info.y;
      }
      if (!info) continue;
      if (p.method === 'custom' || (sumX === 0 && sumY === 0)) {
        // Tanpa data jumlah per bagian: nilai transaksi dibagi rata antar bagian.
        p.usd = (info.usdX + info.usdY) / parts.length;
      } else {
        p.usd = (sumX > 0 ? (info.usdX * Number(p.rawX ?? 0)) / sumX : 0) + (sumY > 0 ? (info.usdY * Number(p.rawY ?? 0)) / sumY : 0);
      }
    }
  }
}

function mixOf(adds: StrategyAdd[]): { mix: StrategyMix[]; estimated: boolean } {
  const parts = shapedParts(adds).sort(byTime);
  const hasUsd = parts.some((p) => (p.usd ?? 0) > 0);
  const order: StrategyName[] = [];
  const value = new Map<StrategyName, number>();
  for (const p of parts) {
    if (!order.includes(p.strategy)) order.push(p.strategy);
    // Tanpa nilai USD (indexer belum mencatat): pakai jumlah token mentah — perkiraan kasar.
    const v = hasUsd ? (p.usd ?? 0) : Number(p.rawX ?? 0) + Number(p.rawY ?? 0);
    value.set(p.strategy, (value.get(p.strategy) ?? 0) + v);
  }
  const total = [...value.values()].reduce((a, b) => a + b, 0);
  const mix = order.map((strategy) => {
    const v = value.get(strategy) ?? 0;
    return { strategy, usd: hasUsd ? v : 0, pct: total > 0 ? (v / total) * 100 : 100 / order.length };
  });
  return { mix, estimated: !hasUsd && mix.length > 1 };
}

/** "Spot" atau "BidAsk 86% + Spot 14%" (persen hanya jika lebih dari satu strategi). */
function labelOf(mix: StrategyMix[]) {
  if (!mix.length) return null;
  if (mix.length === 1) return mix[0].strategy;
  return mix.map((m) => `${m.strategy} ${Math.round(m.pct)}%`).join(' + ');
}

const DUST = 1e-9;
function sideOf(x: number, y: number): DepositSide | null {
  const hx = x > DUST;
  const hy = y > DUST;
  return hx && hy ? 'both' : hx ? 'x' : hy ? 'y' : null;
}

/**
 * Transaksi add yang membentuk posisi saat dibuka. Posisi lebar (lebih dari ~70 bin) dibuat Meteora lewat
 * beberapa transaksi berturut-turut — tiap transaksi mengisi sebagian range — dengan active bin yang sama.
 * Jadi "saat open" = semua add dengan active bin sama seperti add pertama, dalam OPENING_WINDOW_S detik.
 * Rebalance sesudahnya punya active bin berbeda sehingga tidak ikut.
 */
const OPENING_WINDOW_S = 600;
function openingAdds(adds: StrategyAdd[]) {
  const ranged = adds.filter((a) => a.minBinId !== undefined && a.maxBinId !== undefined && a.activeId !== undefined).sort(byTime);
  const first = ranged[0];
  if (!first) return [];
  return ranged.filter((a) => a.activeId === first.activeId && (a.time ?? 0) - (first.time ?? 0) <= OPENING_WINDOW_S);
}

/**
 * Sisi deposit saat open, dijumlahkan dari semua transaksi pembuka (lihat openingAdds) — chunk pertama
 * posisi lebar bisa berisi satu token saja walaupun posisinya double side.
 * Sumber jumlah: event API (satuan token); tanpa event, jumlah mentah hasil decode (hanya untuk sisi).
 */
function openSideOf(adds: StrategyAdd[], sigs: Map<string, SigInfo>) {
  const opening = openingAdds(adds);
  const openingSigs = new Set(opening.map((a) => a.signature));
  const fromEvents = [...sigs.entries()].filter(([sig]) => openingSigs.has(sig)).map(([, info]) => info);
  // Belum ada hasil decode transaksi: pakai event add pertama saja.
  const firstEvent = [...sigs.values()].sort((a, b) => a.time - b.time)[0];
  const events = fromEvents.length ? fromEvents : !opening.length && firstEvent ? [firstEvent] : [];
  if (events.length) {
    const x = events.reduce((s, e) => s + e.x, 0);
    const y = events.reduce((s, e) => s + e.y, 0);
    return { side: sideOf(x, y), amounts: { x, y } };
  }
  if (!opening.length) return { side: null, amounts: null };
  const rx = opening.reduce((s, p) => s + Number(p.rawX ?? 0), 0);
  const ry = opening.reduce((s, p) => s + Number(p.rawY ?? 0), 0);
  // Unit mentah (belum dibagi decimals) — hanya dipakai untuk menentukan sisi.
  return { side: sideOf(rx, ry), amounts: null };
}

function buildResult(adds: StrategyAdd[], events: dlmmApi.DlmmPositionEvent[], cached: boolean): StrategyResult {
  const sigs = eventsBySignature(events);
  attachValues(adds, sigs);
  const { mix, estimated } = mixOf(adds);
  const open = openSideOf(adds, sigs);
  return {
    label: labelOf(mix),
    mix,
    mixEstimated: estimated,
    openSide: open.side,
    openAmounts: open.amounts,
    adds: [...adds].sort(byTime),
    cached,
  };
}

// ---------- range saat open (% dari active bin) ----------

/** Jumlah bin default satu posisi di UI Meteora (docs.meteora.ag: "your position spans 69 bins"). */
const DEFAULT_POSITION_BINS = 69;

interface OpenRange {
  binStep: number;
  bins: number;
  lowerBinId: number;
  upperBinId: number;
  activeId: number;
  /** % harga bin terbawah / teratas terhadap harga active bin saat open (−25.8 = 25.8% di bawah). */
  minPct: number;
  maxPct: number;
  /** Lebar range: harga bin teratas ÷ terbawah − 1, dalam %. */
  widthPct: number;
  /** Range default Meteora (69 bin) untuk bin step & arah yang sama. */
  default: { bins: number; minPct: number; maxPct: number };
  /** Jumlah bin posisi dibanding default 69 bin, dalam %. */
  ofDefaultPct: number;
}

/**
 * Harga bin = (1 + binStep/10000)^binId × 10^(decX−decY), jadi % dari active bin =
 * (1 + binStep/10000)^(binId − activeId) − 1 (decimals saling menghilangkan).
 * Diverifikasi sama persis dengan minPrice/maxPrice API Meteora.
 */
const pctFromActive = (binStep: number, deltaBins: number) => ((1 + binStep / 10_000) ** deltaBins - 1) * 100;

/**
 * Range posisi saat dibuka (semua transaksi pembuka, sebelum ada rebalance), relatif ke active bin saat itu.
 * Posisi lebar terdiri dari beberapa transaksi add — semuanya digabung (lihat openingAdds).
 */
export function openRangeOf(result: StrategyResult, binStep: number): OpenRange | null {
  if (!(binStep > 0)) return null;
  const parts = openingAdds(result.adds);
  const active = parts[0]?.activeId;
  if (!parts.length || active === undefined) return null;
  const lower = Math.min(...parts.map((a) => a.minBinId!));
  const upper = Math.max(...parts.map((a) => a.maxBinId!));
  const bins = upper - lower + 1;

  // Default Meteora mengikuti arah deposit: di bawah harga (token Y), di atas (token X), atau di tengah.
  const n = DEFAULT_POSITION_BINS;
  const half = Math.floor(n / 2);
  const def =
    result.openSide === 'x'
      ? { minPct: 0, maxPct: pctFromActive(binStep, n) }
      : result.openSide === 'both'
        ? { minPct: pctFromActive(binStep, -half), maxPct: pctFromActive(binStep, half) }
        : { minPct: pctFromActive(binStep, -n), maxPct: 0 };

  return {
    binStep,
    bins,
    lowerBinId: lower,
    upperBinId: upper,
    activeId: active,
    minPct: pctFromActive(binStep, lower - active),
    maxPct: pctFromActive(binStep, upper - active),
    widthPct: pctFromActive(binStep, upper - lower),
    default: { bins: n, ...def },
    ofDefaultPct: (bins / n) * 100,
  };
}

// ---------- deteksi + cache ----------

const inflight = new Map<string, Promise<StrategyResult>>();

async function detect(position: string): Promise<StrategyResult> {
  let events: dlmmApi.DlmmPositionEvent[] = [];
  try {
    ({ events } = await dlmmApi.getPositionHistory(position));
  } catch (err) {
    console.warn(`[strategy] history ${position}: ${describeError(err)}`);
  }
  // Event terbaru dulu → dibalik supaya urut waktu.
  let signatures = [...new Set(events.filter((e) => e.eventType === 'add').map((e) => e.signature))].reverse();
  const fromHistory = signatures.length > 0;

  const cachedRow = store.getStrategy(position);
  const cachedAdds = cachedRow?.adds as StrategyAdd[] | undefined;
  const current = cachedAdds?.every((a) => a.v === DECODE_VERSION) ?? false;
  if (cachedAdds && current && fromHistory && cachedRow!.addCount === signatures.length) {
    return buildResult(cachedAdds, events, true);
  }

  // Posisi yang baru dibuka sering belum masuk indexer Meteora → ambil signature langsung dari chain.
  if (!fromHistory) {
    const sigs = await getSignaturesForAddress(position, 50);
    signatures = sigs.filter((s) => !s.err).map((s) => s.signature).reverse();
  }

  let missing = 0;
  const txs = await mapLimit(signatures.slice(0, MAX_TX), TX_CONCURRENCY, async (sig) => {
    const tx = await getTransaction(sig);
    if (!tx) missing++;
    return tx ? decodeAdds(tx, position, sig) : [];
  });
  const adds = txs.flatMap((a) => a ?? []);

  // Yang disimpan hanya hasil decode (tanpa nilai dari event) — jumlah add dipakai sebagai kunci cache.
  // Jangan simpan hasil yang tidak lengkap (transaksi belum tersedia di RPC), supaya dicoba lagi nanti.
  if (fromHistory && missing === 0 && adds.length > 0) {
    const plain = adds.map(({ tokenX: _x, tokenY: _y, usd: _u, ...rest }) => rest);
    store.saveStrategy(position, labelOf(mixOf(adds).mix), plain, signatures.length);
  }
  return buildResult(adds, events, false);
}

/** Strategi posisi DLMM. Permintaan paralel untuk posisi yang sama digabung jadi satu. */
export function detectStrategy(position: string): Promise<StrategyResult> {
  let p = inflight.get(position);
  if (!p) {
    p = detect(position).finally(() => inflight.delete(position));
    inflight.set(position, p);
  }
  return p;
}

/**
 * Seperti detectStrategy tapi menyerah setelah `ms` (untuk alert — jangan sampai menahan notifikasi).
 * `binStep` opsional: jika ada, range saat open ikut dihitung.
 */
export async function detectStrategyWithin(
  position: string,
  ms: number,
  binStep?: number,
): Promise<{ label?: string; openSide?: DepositSide; openRange?: OpenRange } | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([
      detectStrategy(position),
      new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), ms))),
    ]);
    if (!result) return undefined;
    return {
      label: result.label ?? undefined,
      openSide: result.openSide ?? undefined,
      openRange: binStep ? (openRangeOf(result, binStep) ?? undefined) : undefined,
    };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
