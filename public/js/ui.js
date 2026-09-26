// Komponen UI: ikon, visual range, toast, modal, kartu event, dan helper browser bersama.
import { ago, clock, colorOf, duration, esc, initials, ok, pairTokens, pct, price, rangeWidth, rangeWidthText, short, sol, usd, cls } from './fmt.js';

export const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const MAX_LABEL = 40;
const TOAST_MS = 7000;
const TOAST_MAX = 4;

/** localStorage yang aman: tidak melempar error di mode privat / storage diblokir. */
export const storage = {
  get(key, fallback = null) {
    try {
      return localStorage.getItem(key) ?? fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // storage tidak tersedia: abaikan (hanya preferensi tampilan)
    }
  },
};

/** Salin teks ke clipboard lalu tampilkan toast hasilnya. */
export function copyText(text, title, body = '') {
  const done = navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject(new Error('no clipboard'));
  return done.then(
    () => toast(title, body),
    () => toast('Gagal menyalin', 'Browser tidak mengizinkan akses clipboard.', 'error'),
  );
}

/** Jalankan aksi async sambil menonaktifkan tombol (cegah klik ganda) dan menampilkan spinner. */
export async function busy(btn, fn) {
  if (!btn) return fn();
  if (btn.disabled) return undefined;
  btn.disabled = true;
  btn.classList.add('is-busy');
  btn.setAttribute('aria-busy', 'true');
  try {
    return await fn();
  } finally {
    btn.disabled = false;
    btn.classList.remove('is-busy');
    btn.removeAttribute('aria-busy');
  }
}

// Elemen non-tombol yang bisa diklik (baris tabel, kartu, chip alamat, toast) diberi role="button" tabindex="0";
// Enter / Spasi memicu klik supaya semuanya bisa dipakai dengan keyboard.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const el = e.target;
  if (!(el instanceof HTMLElement) || el.tagName === 'BUTTON' || el.getAttribute('role') !== 'button') return;
  e.preventDefault();
  el.click();
});

export const icon = {
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  up: '<svg viewBox="0 0 24 24"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
  down: '<svg viewBox="0 0 24 24"><path d="M12 5v14M19 12l-7 7-7-7"/></svg>',
  copy: '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/></svg>',
  ext: '<svg viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
  refresh: '<svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
  edit: '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4"/></svg>',
  chevron: '<svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>',
  back: '<svg viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6"/></svg>',
  bell: '<svg viewBox="0 0 24 24"><path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.9 1.9 0 0 0 3.4 0"/></svg>',
  bellOff: '<svg viewBox="0 0 24 24"><path d="M8.7 3.9A6 6 0 0 1 18 8c0 3 .6 5.2 1.3 6.6M17 17H3s3-2 3-9M10.3 21a1.9 1.9 0 0 0 3.4 0M3 3l18 18"/></svg>',
  sun: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  moon: '<svg viewBox="0 0 24 24"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
  search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>',
  stop: '<svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
  download: '<svg viewBox="0 0 24 24"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>',
  play: '<svg viewBox="0 0 24 24"><path d="M7 5l12 7-12 7z"/></svg>',
};

/** Tanda ⓘ dengan penjelasan istilah (tooltip). */
export const info = (text) => `<span class="info" title="${esc(text)}" aria-label="${esc(text)}" tabindex="0">ⓘ</span>`;

/** Penjelasan istilah yang sering muncul, dipakai untuk tooltip ⓘ. */
export const GLOSSARY = {
  upnl: 'uPnL (unrealized PnL): untung/rugi posisi yang masih open, belum direalisasikan.',
  dpr: 'DPR: persentase fee harian = total fee ÷ modal ÷ umur posisi (hari).',
  binStep: 'Bin step: selisih harga antar bin dalam basis poin (100 = 1% per bin).',
  baseFee: 'Base fee: fee dasar pool yang dibayar setiap swap.',
  side: 'Sisi deposit saat open: single side = hanya satu token, double side = kedua token.',
  strategy: 'Strategi distribusi likuiditas DLMM: Spot (rata), Curve (terpusat di tengah), BidAsk (terpusat di ujung).',
  exitRange: 'Titik oranye = perkiraan letak harga saat posisi di-close, dihitung dari komposisi token hasil withdraw.',
};

export const PROTO = { dlmm: 'DLMM', dammv2: 'DAMM V2' };

/** Badge strategi DLMM; label gabungan ("BidAsk 86% + Spot 14%") jadi beberapa badge. */
export const strategyBadge = (label) =>
  String(label || '')
    .split(' + ')
    .filter(Boolean)
    .map((s) => {
      const [name, share] = s.split(' ');
      return `<span class="badge strat strat-${esc(name.toLowerCase())}">${esc(name)}${share ? ` <b>${esc(share)}</b>` : ''}</span>`;
    })
    .join('<span class="strat-plus">+</span>');

/** "Single side SOL" / "Single side BRICK" / "Double side BRICK + SOL" dari sisi deposit saat open. */
export function sideLabel(side, symbolX, symbolY) {
  const x = symbolX || 'Token X';
  const y = symbolY || 'Token Y';
  if (side === 'x') return `Single side ${x}`;
  if (side === 'y') return `Single side ${y}`;
  if (side === 'both') return `Double side ${x} + ${y}`;
  return '';
}

export const sideBadge = (side, symbolX, symbolY) =>
  side ? `<span class="badge side side-${esc(side)}" title="${esc(GLOSSARY.side)}">${esc(sideLabel(side, symbolX, symbolY))}</span>` : '';
export const protoBadge = (p) => `<span class="badge ${esc(p)}">${esc(PROTO[p] ?? p)}</span>`;

/** URL eksternal, sudah di-escape untuk dipakai langsung di atribut href. */
export const links = {
  pool: (protocol, pool) => esc(`https://app.meteora.ag/${protocol === 'dlmm' ? 'dlmm' : 'dammv2'}/${pool}`),
  account: (a) => esc(`https://solscan.io/account/${a}`),
};

export const avatar = (label) =>
  `<span class="avatar" style="background:${colorOf(label)}" aria-hidden="true">${esc(initials(label))}</span>`;

export const addrChip = (a, full = false) =>
  `<span class="addr" data-copy="${esc(a)}" role="button" tabindex="0" title="Klik untuk menyalin" aria-label="Salin alamat ${esc(a)}">${esc(full ? a : short(a))}${icon.copy}</span>`;

export const pnlText = (v, p) =>
  `<span class="${cls(v)}">${usd(v, true)}${ok(p) ? ` <span class="nowrap">(${pct(p)})</span>` : ''}</span>`;

export const skeleton = (lines = 4) =>
  `<div class="card-body" aria-busy="true">${Array.from({ length: lines }, (_, i) => `<div class="skeleton sk-line" style="width:${90 - i * 12}%"></div>`).join('')}</div>`;

export const emptyState = (emoji, text) => `<div class="empty"><div class="big" aria-hidden="true">${emoji}</div>${text}</div>`;

/** Pengganti skeleton saat data gagal dimuat; tombol [data-retry] memuat ulang bagian itu. */
export const errorState = (message) =>
  `<div class="empty"><div class="big" aria-hidden="true">⚠️</div><div>Gagal memuat data.</div>
    <div class="faint small">${esc(message)}</div>
    <button class="btn sm mt-sm" data-retry>${icon.refresh}Coba lagi</button></div>`;

// ---------- token & posisi ----------

export function tokImg(src, sym) {
  const letters = esc(String(sym || '?').slice(0, 3));
  if (!src) return `<span class="tok">${letters}</span>`;
  // gambar gagal dimuat → ganti inisial (lihat handler di bawah)
  return `<img class="tok" src="${esc(src)}" alt="${letters}" data-l="${letters}" loading="lazy" referrerpolicy="no-referrer" />`;
}

// Event error gambar tidak bubble; tangkap di fase capture.
document.addEventListener(
  'error',
  (e) => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement) || !img.classList.contains('tok')) return;
    const span = document.createElement('span');
    span.className = 'tok';
    span.textContent = img.dataset.l || '?';
    img.replaceWith(span);
  },
  true,
);

export function tokenIcons(p, size = '') {
  const [x, y] = pairTokens(p.pair);
  return `<span class="tokens ${size}" aria-hidden="true">${tokImg(p.iconX, p.symbolX || x)}${tokImg(p.iconY, p.symbolY || y)}</span>`;
}

export const pairLabel = (p) => {
  const [x, y] = pairTokens(p.pair);
  return `${esc(p.symbolX || x || '?')} / ${esc(p.symbolY || y || '?')}`;
};

const poolLink = (p) =>
  `<a class="link" href="${links.pool(p.protocol, p.pool)}" target="_blank" rel="noopener">${pairLabel(p)}</a>`;

/** Sel "Posisi / Pool": ikon token, pair, badge protokol, alamat posisi. */
export function positionCell(p) {
  return `<div class="pos-cell">${tokenIcons(p)}<div class="min0">
    <a class="pos-name" href="${links.pool(p.protocol, p.pool)}" target="_blank" rel="noopener">${pairLabel(p)}</a>
    <div class="pos-sub">${protoBadge(p.protocol)}<span>${esc(short(p.position))}</span></div></div></div>`;
}

export const totalFee = (p) => (p.claimedFeesUsd || 0) + (p.unclaimedFeesUsd || 0) || p.feesUsd || 0;

/** Umur minimal 10 menit agar DPR posisi yang baru dibuka tidak meledak. */
const MIN_AGE_DAYS = 1 / 144;

/** Umur posisi dalam hari. */
const ageDays = (p) => Math.max(MIN_AGE_DAYS, ((p.closedAt ?? Date.now() / 1000) - (p.openedAt ?? Date.now() / 1000)) / 86400);

/** DPR (persentase fee harian) = fee ÷ modal ÷ umur (hari) × 100. */
export function dpr(p, fee = totalFee(p)) {
  if (!ok(p.depositUsd) || p.depositUsd <= 0 || !p.openedAt) return undefined;
  return (fee / p.depositUsd / ageDays(p)) * 100;
}

export function shortAge(p) {
  if (!p.openedAt) return '–';
  const s = (p.closedAt ?? Date.now() / 1000) - p.openedAt;
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} mnt`;
  if (s < 86400) return `${Math.round(s / 3600)} jam`;
  return `${Math.round(s / 86400)} hari`;
}

// ---------- range dalam % (harga bin DLMM = (1 + binStep/10000)^binId) ----------

/** Di bawah ambang ini (dalam %) angka dianggap nol. */
const ZERO_PCT = 0.005;
const pctCls = (v) => (v > ZERO_PCT ? 'pos' : v < -ZERO_PCT ? 'neg' : 'muted');
const pctSpan = (v, digits = 1) => `<span class="${pctCls(v)}">${pct(v, digits)}</span>`;

/**
 * Range saat open dalam % mengikuti sisi deposit:
 * single side SOL/quote (y) → "−X%", single side token (x) → "+X%", double side → "−X% / +Y%".
 * Tanpa info sisi: tampilkan sisi yang tidak nol.
 */
export function openRangeText(r, side, digits = 2) {
  if (!r) return '';
  const lo = side ? side !== 'x' : Math.abs(r.minPct) > ZERO_PCT;
  const hi = side ? side !== 'y' : Math.abs(r.maxPct) > ZERO_PCT;
  if (lo && hi) return `${pctSpan(r.minPct, digits)} / ${pctSpan(r.maxPct, digits)}`;
  return hi ? pctSpan(r.maxPct, digits) : pctSpan(r.minPct, digits);
}

/** Porsi token Y ≥ SHARE_FULL dianggap 100% (harga keluar di atas range), ≤ SHARE_EMPTY dianggap 0%. */
const SHARE_FULL = 0.99;
const SHARE_EMPTY = 0.01;
// Batas kiri/kanan garis range di mini bar (% lebar); sisanya ruang untuk penanda di luar range.
const MINI_L = 8;
const MINI_R = 92;

/** Letak penanda di range: harga sekarang (open) atau perkiraan harga saat close dari porsi token Y. */
function markerPos(p, mode, outside) {
  if (mode === 'now') return rangePos(p.minPrice, p.maxPrice, p.poolPrice);
  if (!ok(p.shareY)) return undefined;
  return p.shareY >= SHARE_FULL ? 1 + outside : p.shareY <= SHARE_EMPTY ? -outside : p.shareY;
}

export function rangeMini(p, mode = 'now', { showBins = true } = {}) {
  if (p.fullRange) return '<span class="mrange-full">Full range</span>';
  if (!ok(p.minPrice) || !ok(p.maxPrice)) return '<span class="faint">–</span>';
  const t = markerPos(p, mode, 0.1);
  const X = (v) => MINI_L + v * (MINI_R - MINI_L);
  const out = t !== undefined && (t < 0 || t > 1);
  const curTitle = mode === 'now' ? `Harga ${price(p.poolPrice)}` : 'Perkiraan harga saat close';
  const cur = t === undefined ? '' : `<span class="mrange-cur ${out ? 'out' : ''}" style="left:${t < 0 ? 2 : t > 1 ? 98 : X(t)}%" title="${curTitle}"></span>`;
  return `<div class="mrange" title="${price(p.minPrice)} → ${price(p.maxPrice)}">
    <div class="mrange-labels"><span>${price(p.minPrice)}</span><span>${price(p.maxPrice)}</span></div>
    <div class="mrange-track"><span class="mrange-bg"></span><span class="mrange-line" style="left:${MINI_L}%;width:${MINI_R - MINI_L}%"></span>
      <span class="mrange-dot" style="left:${MINI_L}%"></span><span class="mrange-dot" style="left:${MINI_R}%"></span>${cur}</div>
    ${showBins && p.bins ? `<div class="mrange-pct">${p.bins} bin</div>` : ''}
  </div>`;
}

// ---------- visual range ----------

/** Letak harga di range (skala log, bin DLMM geometris): 0 = min, 1 = max. */
export function rangePos(min, max, cur) {
  if (!ok(min) || !ok(max) || !ok(cur) || min <= 0 || max <= min || cur <= 0) return undefined;
  return (Math.log(cur) - Math.log(min)) / (Math.log(max) - Math.log(min));
}

function nowStatus(p, t) {
  if (t === undefined) return '';
  if (t < 0) return `<span class="neg">Di bawah range · ${pct((p.poolPrice / p.minPrice - 1) * 100)} dari min</span>`;
  if (t > 1) return `<span class="neg">Di atas range · ${pct((p.poolPrice / p.maxPrice - 1) * 100)} dari max</span>`;
  return `<span class="pos">Dalam range · ${(t * 100).toFixed(0)}% dari min ke max</span>`;
}

function exitStatus(s, x, y) {
  if (!ok(s)) return '';
  const text =
    s >= SHARE_FULL
      ? `Keluar <b>di atas range</b> (100% ${esc(y)})`
      : s <= SHARE_EMPTY
        ? `Keluar <b>di bawah range</b> (100% ${esc(x)})`
        : `Keluar <b>dalam range</b> (~${(s * 100).toFixed(0)}% ${esc(y)} / ${(100 - s * 100).toFixed(0)}% ${esc(x)})`;
  return `<span class="muted">${text} <span class="faint">· perkiraan</span></span>`;
}

/**
 * mode 'now'  : penanda = harga pool saat ini.
 * mode 'exit' : penanda = perkiraan harga saat close dari komposisi token hasil withdraw.
 */
function rangeBar(p, mode = 'now') {
  if (p.fullRange) return `<div class="range-full">Full range (0 → ∞) · likuiditas tersebar di semua harga</div>`;
  if (!ok(p.minPrice) || !ok(p.maxPrice)) return '';
  const [x = 'X', y = 'Y'] = pairTokens(p.pair);
  const widthText = rangeWidthText(rangeWidth(p.minPrice, p.maxPrice));
  const t = markerPos(p, mode, 0.12);
  const status = mode === 'now' ? nowStatus(p, t) : exitStatus(p.shareY, x, y);
  const outside = t !== undefined && (t < 0 || t > 1);
  const markCls = mode === 'exit' ? 'est' : outside ? 'warn' : '';

  // Domain tampilan melebar jika harga di luar range agar penanda tetap terlihat.
  const lo = Math.min(0, t ?? 0) - 0.06;
  const hi = Math.max(1, t ?? 1) + 0.06;
  const X = (v) => ((v - lo) / (hi - lo)) * 100;
  const clamp = (v) => Math.min(94, Math.max(6, v));
  const segCls = mode === 'exit' ? 'exit' : t !== undefined && !outside ? 'in' : 'out';
  const curLabel = mode === 'now' && ok(p.poolPrice) ? `Harga ${price(p.poolPrice)}` : '';

  return `<div class="range">
    <div class="range-head">
      <span>Range <b>${price(p.minPrice)}</b> → <b>${price(p.maxPrice)}</b></span>
      <span>${[widthText && `lebar ${widthText}`, p.bins && `${p.bins} bin`].filter(Boolean).join(' · ')}</span>
    </div>
    <div class="range-track">
      <div class="range-seg ${segCls}" style="left:${X(0)}%;width:${X(1) - X(0)}%"></div>
      ${t !== undefined ? `<div class="range-mark ${markCls}" style="left:${X(t)}%" title="${esc(curLabel || 'Perkiraan harga saat close')}"></div>` : ''}
    </div>
    <div class="range-labels">
      <span style="left:${clamp(X(0))}%">min</span>
      <span style="left:${clamp(X(1))}%">max</span>
    </div>
    ${status ? `<div class="range-status">${status}${curLabel ? ` <span class="faint">· ${curLabel}</span>` : ''}</div>` : ''}
  </div>`;
}

// ---------- kartu event (open / close) ----------

export function eventItem(e, { withRange = false, isNew = false } = {}) {
  const p = e.data || {};
  const open = e.kind === 'open';
  const verb = open ? 'membuka posisi' : 'menutup posisi';
  const meta = [];
  if (open) {
    if (p.strategy) meta.push(`Strategi ${strategyBadge(p.strategy)}`);
    if (p.openSide) {
      const [x, y] = pairTokens(e.pair);
      meta.push(sideBadge(p.openSide, p.symbolX || x, p.symbolY || y));
    }
    if (p.openRange) meta.push(`Range ${openRangeText(p.openRange, p.openSide)}`);
    if (ok(p.depositUsd)) meta.push(`Deposit <b>${usd(p.depositUsd)}</b>${ok(p.depositSol) ? ` (${sol(p.depositSol)})` : ''}`);
    if (p.fullRange) meta.push('Full range');
  } else {
    if (ok(p.pnlUsd)) meta.push(`PnL <b class="${cls(p.pnlUsd)}">${usd(p.pnlUsd, true)}</b> (${pct(p.pnlPct)})`);
    else meta.push('PnL belum tersedia');
    if (ok(p.feesUsd)) meta.push(`Fee <b>${usd(p.feesUsd)}</b>`);
    if (ok(p.depositUsd)) meta.push(`Modal <b>${usd(p.depositUsd)}</b>`);
    if (p.openedAt) meta.push(`Durasi <b>${duration(p.openedAt, p.closedAt)}</b>`);
  }
  return `<div class="event${isNew ? ' new' : ''}">
    <div class="event-icon ${esc(e.kind)}" aria-hidden="true">${open ? icon.up : icon.down}</div>
    <div class="event-body">
      <div class="item-head">
        <div class="event-title"><a class="link" href="#/portfolio/${esc(e.wallet)}"><b>${esc(e.label)}</b></a> ${verb} ${tokenIcons({ ...p, pair: e.pair })}<b>${poolLink(e)}</b></div>
        ${protoBadge(e.protocol)}
        <span class="item-time" title="${esc(clock(e.created_at))}">${ago(e.created_at)}</span>
      </div>
      ${meta.length ? `<div class="item-meta">${meta.map((m) => `<span>${m}</span>`).join('')}</div>` : ''}
      ${withRange ? rangeBar(p, open ? 'now' : 'exit') : ''}
    </div>
  </div>`;
}

// ---------- toast ----------

/** title & body berupa HTML: pemanggil wajib meng-escape data dari luar dengan esc(). */
export function toast(title, body = '', kind = '', onClick) {
  const root = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  if (onClick) {
    // Toast yang punya aksi juga bisa dibuka lewat keyboard (handler Enter/Spasi di atas).
    el.setAttribute('role', 'button');
    el.tabIndex = 0;
  }
  el.innerHTML = `<div class="toast-title">${title}</div>${body ? `<div class="toast-body">${body}</div>` : ''}
    <button class="toast-close" aria-label="Tutup notifikasi">×</button>`;
  el.addEventListener('click', (e) => {
    if (!e.target.closest('.toast-close')) onClick?.();
    el.remove();
  });
  root.prepend(el);
  while (root.children.length > TOAST_MAX) root.lastElementChild.remove();
  setTimeout(() => el.remove(), TOAST_MS);
}

// ---------- modal ----------

/** Tutup modal / drawer yang sedang terbuka (dipanggil saat pindah halaman). */
export const closeOverlays = () => {
  const root = document.getElementById('modal-root');
  root.dispatchEvent(new Event('close-overlay'));
  root.innerHTML = '';
};

/** Modal konfirmasi / input. Resolve nilai input (atau true), atau null jika batal. */
export function modal({ title, body = '', input, confirmText = 'OK', danger = false, validate }) {
  return new Promise((resolve) => {
    const root = document.getElementById('modal-root');
    const returnFocus = document.activeElement;
    root.innerHTML = `<div class="modal-backdrop">
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <h3 id="modal-title">${title}</h3>
        <div class="modal-body">${body}
          ${input ? `<input class="input" id="modal-input" value="${esc(input.value ?? '')}" placeholder="${esc(input.placeholder ?? '')}" maxlength="${MAX_LABEL}" aria-label="${esc(input.placeholder ?? 'Isian')}" />` : ''}
          <div class="field-error" id="modal-error" role="alert"></div>
        </div>
        <div class="modal-actions">
          <button class="btn ghost" data-m="cancel">Batal</button>
          <button class="btn ${danger ? 'danger' : 'primary'}" data-m="ok">${confirmText}</button>
        </div>
      </div>
    </div>`;
    const inputEl = root.querySelector('#modal-input');
    const errEl = root.querySelector('#modal-error');
    const okBtn = root.querySelector('[data-m=ok]');
    const close = (v) => {
      root.removeEventListener('close-overlay', onRouteClose);
      document.removeEventListener('keydown', onKey);
      root.innerHTML = '';
      if (returnFocus instanceof HTMLElement && returnFocus.isConnected) returnFocus.focus();
      resolve(v);
    };
    const onRouteClose = () => close(null);
    // busy() mencegah submit ganda (Enter + klik) selama validasi async berjalan.
    const submit = () =>
      busy(okBtn, async () => {
        const value = inputEl ? inputEl.value.trim() : true;
        const err = validate ? await validate(value) : '';
        if (err) errEl.textContent = err;
        else close(value);
      });
    const onKey = (e) => {
      if (e.key === 'Escape') close(null);
      // Enter saat fokus di tombol dibiarkan menjalankan tombol itu sendiri (mis. "Batal").
      if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) submit();
    };
    document.addEventListener('keydown', onKey);
    root.addEventListener('close-overlay', onRouteClose);
    root.querySelector('.modal-backdrop').addEventListener('click', (e) => {
      if (e.target.classList.contains('modal-backdrop')) close(null);
    });
    root.querySelector('[data-m=cancel]').addEventListener('click', () => close(null));
    okBtn.addEventListener('click', submit);
    (inputEl ?? okBtn).focus();
    inputEl?.select();
  });
}
