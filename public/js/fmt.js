// Format angka, harga, waktu. Angka memakai format internasional (1,234.56); tanggal memakai bahasa Indonesia.

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const ok = (v) => typeof v === 'number' && Number.isFinite(v);
export const num = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));
export const short = (a) => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : '');
export const cls = (v) => (!ok(v) || v === 0 ? '' : v > 0 ? 'pos' : 'neg');

/** Tanda minus tipografis, dipakai semua formatter agar seragam. */
const MINUS = '−';
const signOf = (v, plus) => (v < 0 ? MINUS : plus && v > 0 ? '+' : '');
const fmtNum = (v, opts) => v.toLocaleString('en-US', opts);

/** Jumlahkan hasil fn(item) yang berupa angka valid. */
export const sum = (items, fn) => items.reduce((acc, it) => acc + (ok(fn(it)) ? fn(it) : 0), 0);

/** Token X & Y dari string pair "X-Y". */
export const pairTokens = (pair) => String(pair || '').split('-');

/** Lebar range dalam % (max terhadap min); undefined jika data tidak lengkap. */
export const rangeWidth = (min, max) => (ok(min) && ok(max) && min > 0 ? (max / min - 1) * 100 : undefined);
export const rangeWidthText = (w) => (!ok(w) ? '' : w >= 1000 ? `${(w / 100 + 1).toFixed(0)}x` : `${w.toFixed(1)}%`);

export function usd(v, sign = false) {
  if (!ok(v)) return '–';
  const abs = Math.abs(v);
  const d = abs >= 1000 ? 0 : abs >= 1 || abs === 0 ? 2 : 4;
  return `${signOf(v, sign)}$${fmtNum(abs, { minimumFractionDigits: d, maximumFractionDigits: d })}`;
}

export function sol(v, sign = false) {
  if (!ok(v)) return '–';
  const abs = Math.abs(v);
  const d = abs >= 100 ? 1 : abs >= 0.01 || abs === 0 ? 3 : 6;
  return `${signOf(v, sign)}${fmtNum(abs, { maximumFractionDigits: d })} SOL`;
}

export function pct(v, digits = 2) {
  if (!ok(v)) return '–';
  return `${signOf(v, true)}${Math.abs(v).toFixed(digits)}%`;
}

export const int = (v) => (ok(v) ? fmtNum(v) : '–');

/** Jumlah token: 2 desimal untuk angka besar, hingga 6 untuk angka kecil. */
export const amt = (v) => (!ok(v) ? '–' : v === 0 ? '0' : fmtNum(v, { maximumFractionDigits: Math.abs(v) >= 1000 ? 2 : 6 }));

/**
 * Dolar ringkas untuk kotak kalender (maks ±6 karakter supaya muat di layar HP):
 * $4.5 · $216 · $1.0K · $15K · $1.2M. Angka lengkap tetap ada di tooltip & panel detail.
 */
export function compactUsd(v) {
  if (!ok(v)) return '';
  const a = Math.abs(v);
  if (a < 0.05) return '$0';
  const t =
    a >= 1e6 ? `${(a / 1e6).toFixed(1)}M` : a >= 1e4 ? `${Math.round(a / 1e3)}K` : a >= 1e3 ? `${(a / 1e3).toFixed(1)}K` : a >= 10 ? a.toFixed(0) : a.toFixed(1);
  return `${signOf(v, false)}$${t}`;
}

const SUB = '₀₁₂₃₄₅₆₇₈₉';

/** Harga kecil ala DEX: 0.000004489 → 0.0₅4489 */
export function price(v) {
  if (!ok(v)) return '–';
  if (v === 0) return '0';
  const abs = Math.abs(v);
  const sign = signOf(v, false);
  if (abs >= 1) return sign + fmtNum(abs, { maximumSignificantDigits: 6 });
  if (abs >= 0.001) return sign + fmtNum(abs, { maximumSignificantDigits: 4 });
  let zeros = Math.floor(-Math.log10(abs));
  let sig = Math.round(abs * 10 ** (zeros + 4)).toString();
  if (sig.length > 4) {
    zeros -= 1;
    sig = '1';
  }
  sig = sig.replace(/0+$/, '') || '0';
  return `${sign}0.0${[...String(zeros)].map((d) => SUB[+d]).join('')}${sig}`;
}

export function duration(fromSec, toSec) {
  if (!fromSec) return '–';
  const s = Math.max(0, (toSec ?? Date.now() / 1000) - fromSec);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d} hari ${h} jam`;
  if (h) return `${h} jam ${m} mnt`;
  if (m) return `${m} mnt`;
  return `${Math.floor(s)} dtk`;
}

export function ago(sec) {
  if (!sec) return '–';
  const s = Date.now() / 1000 - sec;
  if (s < 45) return 'baru saja';
  return `${duration(sec)} lalu`;
}

export function clock(sec, withDate = true) {
  if (!sec) return '–';
  return new Date(sec * 1000).toLocaleString('id-ID', {
    ...(withDate ? { day: 'numeric', month: 'short' } : {}),
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Tanggal pendek, mis. "26 Sep 2026". Menerima detik unix atau string ISO "YYYY-MM-DD". */
export function dateShort(v) {
  const d = typeof v === 'string' ? new Date(`${v}T00:00:00Z`) : new Date(v * 1000);
  if (Number.isNaN(d.getTime())) return '–';
  return d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric', ...(typeof v === 'string' ? { timeZone: 'UTC' } : {}) });
}

export function dayLabel(sec) {
  const d = new Date(sec * 1000);
  const today = new Date();
  const yest = new Date(Date.now() - 86400000);
  if (d.toDateString() === today.toDateString()) return 'Hari ini';
  if (d.toDateString() === yest.toDateString()) return 'Kemarin';
  return d.toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long' });
}

/** PnL % gabungan berbobot modal (modal = pnl / pct). */
export function combinedPct(parts) {
  let pnl = 0;
  let dep = 0;
  for (const p of parts) {
    if (!ok(p.pnlPct) || p.pnlPct === 0 || !ok(p.pnlUsd)) continue;
    pnl += p.pnlUsd;
    dep += p.pnlUsd / (p.pnlPct / 100);
  }
  return dep > 0 ? (pnl / dep) * 100 : undefined;
}

const COLORS = ['#f97316', '#a855f7', '#3b82f6', '#22c55e', '#ec4899', '#14b8a6', '#eab308', '#6366f1', '#ef4444', '#06b6d4'];
export function colorOf(s) {
  let h = 0;
  for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}
export const initials = (label) =>
  String(label || '?')
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
