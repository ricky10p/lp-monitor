/**
 * Kriteria Track Wallet: validasi input form, lalu cocokkan pool dan posisi.
 *
 * Semua target boleh dikosongkan, diisi sebagian, atau semua — yang diisi harus cocok semua (AND),
 * minimal satu wajib diisi. Target yang tidak berlaku di mode terpilih diabaikan (lihat TARGETS).
 * Mode PNL (per posisi): profit USD / SOL / %.
 * Mode PNL PER POOL (total wallet di satu pool, dari /portfolio): profit USD / SOL / %,
 *   total deposit, total withdraw, total fee — masing-masing USD dan SOL.
 * Mode FEES (total per wallet+pool, dari posisi open + closed): total fee USD, total PnL USD / SOL.
 * Kriteria pool (binStep / baseFee): yang null diabaikan; dipakai menyaring pool sedini mungkin.
 * Rentang tanggal (startDate / endDate, "dd-mm-yyyy" atau "yyyy-mm-dd", waktu lokal server):
 *   inklusif — startDate mulai 00:00:00, endDate sampai 23:59:59.
 */

const MODE_PNL = 'pnl';
export const MODE_POOL = 'pool';
export const MODE_FEES = 'fees';
export type Mode = typeof MODE_PNL | typeof MODE_POOL | typeof MODE_FEES;
const MODES: Mode[] = [MODE_PNL, MODE_POOL, MODE_FEES];

export const MODE_NAMES: Record<Mode, string> = {
  pnl: 'PnL (per posisi)',
  pool: 'PnL per pool (total per wallet + pool)',
  fees: 'Fee (total per wallet + pool)',
};

export interface Criteria {
  targetProfitUsd: number | null;
  toleranceUsd: number;
  targetProfitSol: number | null;
  toleranceSol: number;
  targetProfitPct: number | null;
  tolerancePct: number;
  targetFeeUsd: number | null;
  toleranceFeeUsd: number;
  targetFeeSol: number | null;
  toleranceFeeSol: number;
  targetDepositUsd: number | null;
  toleranceDepositUsd: number;
  targetDepositSol: number | null;
  toleranceDepositSol: number;
  targetWithdrawUsd: number | null;
  toleranceWithdrawUsd: number;
  targetWithdrawSol: number | null;
  toleranceWithdrawSol: number;
  binStep: number | null;
  baseFee: number | null;
  rangeStart: number | null;
  rangeEnd: number | null;
  concurrency: number;
}

const DEFAULT_TOLERANCE = 1;
const DEFAULT_CONCURRENCY = 8;
const MAX_CONCURRENCY = 32;
const DMY_RE = /^(\d{2})-(\d{2})-(\d{4})$/;
const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const SECONDS_PER_DAY = 86400;
const MAX_DAYS_BACK = 365; // batas yang diterima parameter days_back Meteora

/** Error validasi input — ditampilkan apa adanya ke user (HTTP 400). */
export class CriteriaError extends Error {}

const isUnset = (v: unknown) => v === null || v === undefined || v === '';

/** Angka dari JSON boleh berupa number atau string angka (input form). */
function toNumber(value: unknown): number {
  return typeof value === 'string' ? Number(value.trim()) : typeof value === 'number' ? value : NaN;
}

function parseTarget(value: unknown, label: string) {
  if (isUnset(value)) return null;
  const n = toNumber(value);
  if (!Number.isFinite(n)) throw new CriteriaError(`"${label}" harus berupa angka atau dikosongkan.`);
  return n;
}

function parseTolerance(value: unknown, label: string) {
  if (isUnset(value)) return DEFAULT_TOLERANCE;
  const n = toNumber(value);
  if (!Number.isFinite(n) || n < 0) throw new CriteriaError(`"${label}" harus angka >= 0.`);
  return n;
}

function parsePoolCriteria(value: unknown, label: string) {
  if (isUnset(value)) return null;
  const n = toNumber(value);
  if (!Number.isFinite(n) || n < 0) throw new CriteriaError(`"${label}" harus angka >= 0 atau dikosongkan.`);
  return n;
}

function parseConcurrency(value: unknown) {
  if (isUnset(value)) return DEFAULT_CONCURRENCY;
  const n = toNumber(value);
  if (!Number.isInteger(n) || n < 1 || n > MAX_CONCURRENCY) {
    throw new CriteriaError(`"Konkurensi" harus bilangan bulat 1-${MAX_CONCURRENCY}.`);
  }
  return n;
}

/**
 * Tanggal -> epoch detik (waktu lokal). Diparse manual dan komponennya dicek ulang supaya
 * tanggal yang tidak ada (mis. 31-02-2026) ditolak, bukan digeser diam-diam.
 */
function parseDate(value: unknown, label: string, endOfDay = false) {
  if (isUnset(value)) return null;
  const s = typeof value === 'string' ? value.trim() : '';
  let day: number, month: number, year: number;
  const dmy = s.match(DMY_RE);
  const ymd = s.match(YMD_RE);
  if (dmy) [day, month, year] = [Number(dmy[1]), Number(dmy[2]), Number(dmy[3])];
  else if (ymd) [year, month, day] = [Number(ymd[1]), Number(ymd[2]), Number(ymd[3])];
  else throw new CriteriaError(`"${label}" harus format dd-mm-yyyy, mis. "19-09-2026".`);

  const date = endOfDay ? new Date(year, month - 1, day, 23, 59, 59) : new Date(year, month - 1, day, 0, 0, 0);
  const valid = date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
  if (!valid) throw new CriteriaError(`"${label}" bukan tanggal yang ada: ${s}.`);
  return Math.floor(date.getTime() / 1000);
}

const formatDate = (seconds: number) => {
  const d = new Date(seconds * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()}`;
};

export function parseMode(value: unknown): Mode {
  if (MODES.includes(value as Mode)) return value as Mode;
  throw new CriteriaError('Mode harus "pnl", "pool", atau "fees".');
}

type TargetKey =
  | 'targetProfitUsd'
  | 'targetProfitSol'
  | 'targetProfitPct'
  | 'targetFeeUsd'
  | 'targetFeeSol'
  | 'targetDepositUsd'
  | 'targetDepositSol'
  | 'targetWithdrawUsd'
  | 'targetWithdrawSol';
type ToleranceKey =
  | 'toleranceUsd'
  | 'toleranceSol'
  | 'tolerancePct'
  | 'toleranceFeeUsd'
  | 'toleranceFeeSol'
  | 'toleranceDepositUsd'
  | 'toleranceDepositSol'
  | 'toleranceWithdrawUsd'
  | 'toleranceWithdrawSol';

/** Nilai yang bisa dicocokkan — nama field sama dengan PoolTotals (meteora.ts). */
type ValueKey = 'pnlUsd' | 'pnlSol' | 'pnlPct' | 'feeUsd' | 'feeSol' | 'depositUsd' | 'depositSol' | 'withdrawUsd' | 'withdrawSol';

/** Daftar target: label, satuan, mode yang memakainya, dan nilai yang dicocokkan. */
const TARGETS: { key: TargetKey; tol: ToleranceKey; label: string; unit: '$' | 'SOL' | '%'; modes: Mode[]; value: ValueKey }[] = [
  { key: 'targetProfitUsd', tol: 'toleranceUsd', label: 'Profit', unit: '$', modes: ['pnl', 'pool', 'fees'], value: 'pnlUsd' },
  { key: 'targetProfitSol', tol: 'toleranceSol', label: 'Profit', unit: 'SOL', modes: ['pnl', 'pool', 'fees'], value: 'pnlSol' },
  { key: 'targetProfitPct', tol: 'tolerancePct', label: 'Profit', unit: '%', modes: ['pnl', 'pool'], value: 'pnlPct' },
  { key: 'targetDepositUsd', tol: 'toleranceDepositUsd', label: 'Total deposit', unit: '$', modes: ['pool'], value: 'depositUsd' },
  { key: 'targetDepositSol', tol: 'toleranceDepositSol', label: 'Total deposit', unit: 'SOL', modes: ['pool'], value: 'depositSol' },
  { key: 'targetWithdrawUsd', tol: 'toleranceWithdrawUsd', label: 'Total withdraw', unit: '$', modes: ['pool'], value: 'withdrawUsd' },
  { key: 'targetWithdrawSol', tol: 'toleranceWithdrawSol', label: 'Total withdraw', unit: 'SOL', modes: ['pool'], value: 'withdrawSol' },
  { key: 'targetFeeUsd', tol: 'toleranceFeeUsd', label: 'Total fee', unit: '$', modes: ['pool', 'fees'], value: 'feeUsd' },
  { key: 'targetFeeSol', tol: 'toleranceFeeSol', label: 'Total fee', unit: 'SOL', modes: ['pool'], value: 'feeSol' },
];

const unitText = (unit: string, v: number) => (unit === '$' ? `$${v}` : unit === '%' ? `${v}%` : `${v} SOL`);

/** Baca & validasi kriteria dari body request. */
export function parseCriteria(raw: Record<string, unknown>, mode: Mode): Criteria {
  const targets = {} as Record<TargetKey | ToleranceKey, number | null>;
  for (const t of TARGETS) {
    const label = `${t.label} ${t.unit === '$' ? 'USD' : t.unit}`;
    // Target yang tidak berlaku di mode ini diabaikan (bukan error).
    targets[t.key] = t.modes.includes(mode) ? parseTarget(raw[t.key], `Target ${label.toLowerCase()}`) : null;
    targets[t.tol] = parseTolerance(raw[t.tol], `Toleransi ${label.toLowerCase()}`);
  }
  const c = {
    ...(targets as Pick<Criteria, TargetKey | ToleranceKey>),
    binStep: parsePoolCriteria(raw.binStep, 'binStep'),
    baseFee: parsePoolCriteria(raw.baseFee, 'baseFee'),
    rangeStart: parseDate(raw.startDate, 'Tanggal mulai'),
    rangeEnd: parseDate(raw.endDate, 'Tanggal akhir', true),
    concurrency: parseConcurrency(raw.concurrency),
  } as Criteria;

  if (c.rangeStart !== null && c.rangeEnd !== null && c.rangeStart > c.rangeEnd) {
    throw new CriteriaError(
      `Tanggal mulai (${formatDate(c.rangeStart)}) tidak boleh setelah tanggal akhir (${formatDate(c.rangeEnd)}).`,
    );
  }

  const usable = TARGETS.filter((t) => t.modes.includes(mode));
  if (usable.every((t) => c[t.key] === null)) {
    const names = usable.map((t) => `${t.label.toLowerCase()} ${t.unit === '$' ? 'USD' : t.unit}`).join(', ');
    throw new CriteriaError(`Mode ${MODE_NAMES[mode].split(' (')[0]} wajib mengisi minimal satu target: ${names}.`);
  }
  return c;
}

/** Teks target yang aktif, mis. "Profit $254 ± 1 | Total fee 2.6 SOL ± 0.1". */
export function describeCriteria(c: Criteria, mode: Mode) {
  const total = mode === MODE_PNL ? '' : 'total ';
  return TARGETS.filter((t) => t.modes.includes(mode) && c[t.key] !== null)
    .map((t) => {
      const label = t.label.startsWith('Total') ? t.label : `${total}${t.label}`;
      return `${label} ${unitText(t.unit, c[t.key]!)} ± ${t.unit === '%' ? `${c[t.tol]}%` : c[t.tol]}`;
    })
    .join(' | ');
}

/** Semua target yang diisi (untuk mode ini) harus cocok — AND. */
function matchesTargets(values: Partial<Record<ValueKey, number>>, c: Criteria, mode: Mode) {
  for (const t of TARGETS) {
    const target = c[t.key];
    if (target === null || !t.modes.includes(mode)) continue;
    const v = values[t.value];
    if (v === undefined || Math.abs(v - target) > c[t.tol]) return false;
  }
  return true;
}

export function describePoolCriteria(c: Criteria) {
  if (c.binStep === null && c.baseFee === null) return 'semua pool';
  const parts: string[] = [];
  if (c.binStep !== null) parts.push(`binStep ${c.binStep}`);
  if (c.baseFee !== null) parts.push(`baseFee ${c.baseFee}`);
  return parts.join(' | ');
}

export function describeDateRange({ rangeStart, rangeEnd }: Criteria) {
  if (rangeStart === null && rangeEnd === null) return 'semua waktu';
  if (rangeEnd === null) return `${formatDate(rangeStart!)} sampai sekarang`;
  if (rangeStart === null) return `sampai ${formatDate(rangeEnd)}`;
  return `${formatDate(rangeStart)} s/d ${formatDate(rangeEnd)}`;
}

export function matchesPool(pool: { binStep: unknown; baseFee: unknown }, c: Criteria) {
  if (c.binStep !== null && Number(pool.binStep) !== c.binStep) return false;
  if (c.baseFee !== null && Number(pool.baseFee) !== c.baseFee) return false;
  return true;
}

/** Timestamp kosong dianggap tidak cocok selama rentangnya aktif. */
export function matchesDate(timestamp: number | null, { rangeStart, rangeEnd }: Criteria) {
  if (rangeStart === null && rangeEnd === null) return true;
  if (!timestamp) return false;
  if (rangeStart !== null && timestamp < rangeStart) return false;
  if (rangeEnd !== null && timestamp > rangeEnd) return false;
  return true;
}

/**
 * Nilai days_back untuk /portfolio Meteora (jendela 1-365 hari dari SEKARANG), atau null.
 * Rentang lebih tua dari setahun -> tidak dikirim, karena days_back=365 justru membuang pool yang dicari.
 */
export function daysBackFor(c: Criteria, now = Math.floor(Date.now() / 1000)) {
  if (c.rangeStart === null) return null;
  const days = Math.ceil((now - c.rangeStart) / SECONDS_PER_DAY);
  return days < 1 || days > MAX_DAYS_BACK ? null : days;
}

/** Mode FEES: total fee & PnL seluruh posisi wallet di satu pool. */
export function matchesFees(total: { feesUsd: number; pnlUsd: number; pnlSol: number }, c: Criteria) {
  return matchesTargets({ feeUsd: total.feesUsd, pnlUsd: total.pnlUsd, pnlSol: total.pnlSol }, c, MODE_FEES);
}

/** Mode PNL: satu posisi. */
export function matchesProfit(p: { pnlUsd: number; pnlSol: number; pnlPct: number }, c: Criteria) {
  return matchesTargets(p, c, MODE_PNL);
}

/** Mode PNL PER POOL: total wallet di satu pool dari /portfolio. */
export function matchesPoolTotals(totals: Record<ValueKey, number>, c: Criteria) {
  return matchesTargets(totals, c, MODE_POOL);
}
