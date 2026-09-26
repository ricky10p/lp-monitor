// Grafik likuiditas per bin ala Meteora: batang per bin (token X di atas token Y),
// garis harga sekarang, sumbu harga, dan tooltip per bin. SVG murni, tanpa library.

import { amt, esc, price, usd } from './fmt.js';

const W = 600;
const H = 180;
const TOP = 8;
/** Di atas jumlah bin ini batang digambar rapat tanpa celah. */
const DENSE_BINS = 150;
/** Setengah lebar tooltip (px), agar tooltip tidak keluar dari tepi grafik. */
const TIP_HALF = 70;

/**
 * @param {HTMLElement} el   wadah grafik
 * @param {object} d         respons /api/positions/:position/bins
 */
export function renderBinChart(el, d) {
  if (!d.bins.length) {
    el.innerHTML = `<div class="muted">${esc(d.note || 'Tidak ada data bin.')}</div>`;
    return;
  }
  const n = d.bins.length;
  // Tinggi batang = nilai bin pada HARGA BIN ITU SENDIRI (x × harga bin + y, dalam token Y), sama seperti
  // Meteora. Kalau token X dinilai dengan harga sekarang, bin yang sudah ter-swap di harga lain terlihat
  // miring walaupun distribusinya Spot (rata). Nilai USD di harga sekarang tetap ada di tooltip & legenda.
  const values = d.bins.map((b) => ({
    ...b,
    vx: b.x * b.price * d.priceYUsd,
    vy: b.y * d.priceYUsd,
    nowUsd: b.x * d.priceXUsd + b.y * d.priceYUsd,
  }));
  const max = Math.max(...values.map((v) => v.vx + v.vy)) || 1;
  const bw = W / n;
  const gap = n > DENSE_BINS ? 0 : Math.min(1.5, bw * 0.15);
  const scale = (v) => (v / max) * (H - TOP);

  const bars = values
    .map((v, i) => {
      const x = i * bw + gap / 2;
      const w = Math.max(0.5, bw - gap);
      const hy = scale(v.vy);
      const hx = scale(v.vx);
      return `${hy > 0 ? `<rect class="bc-y" x="${x}" y="${H - hy}" width="${w}" height="${hy}"/>` : ''}${
        hx > 0 ? `<rect class="bc-x" x="${x}" y="${H - hy - hx}" width="${w}" height="${hx}"/>` : ''
      }`;
    })
    .join('');

  // Harga sekarang: garis di tengah active bin, atau panah di tepi jika di luar range.
  const ai = d.activeBin - d.lowerBinId;
  const inRange = ai >= 0 && ai < n;
  const ax = inRange ? (ai + 0.5) * bw : ai < 0 ? 0 : W;
  const active = inRange
    ? `<line class="bc-active" x1="${ax}" x2="${ax}" y1="0" y2="${H}"/>`
    : `<path class="bc-active-arrow" d="${ai < 0 ? `M8 ${H / 2 - 7} L1 ${H / 2} L8 ${H / 2 + 7}` : `M${W - 8} ${H / 2 - 7} L${W - 1} ${H / 2} L${W - 8} ${H / 2 + 7}`}"/>`;

  const reconstructed = d.source === 'reconstructed';
  el.innerHTML = `
    <div class="bc-legend">
      <span><i class="bc-dot x"></i>${esc(d.symbolX)} <b>${amt(d.totals.x)}</b></span>
      <span><i class="bc-dot y"></i>${esc(d.symbolY)} <b>${amt(d.totals.y)}</b></span>
      <span class="faint">≈ ${usd(d.totals.usd)} · ${n} bin</span>
      <span class="spacer"></span>
      <span class="badge ${reconstructed ? 'warn' : 'pos'}" title="${
        reconstructed
          ? 'Posisi sudah ditutup: data bin sudah dihapus dari chain. Distribusi diperkirakan dari transaksi add (range, strategi, jumlah token).'
          : 'Dibaca langsung dari akun posisi on-chain — sama dengan tampilan Meteora.'
      }">${reconstructed ? 'Perkiraan saat open' : 'On-chain'}</span>
    </div>
    <div class="bc-wrap">
      <svg class="bc-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" tabindex="0"
        aria-label="Likuiditas per bin ${esc(d.symbolX)} / ${esc(d.symbolY)}. Gunakan panah kiri/kanan untuk melihat tiap bin.">
        ${bars}${active}<rect class="bc-hover" x="0" y="0" width="0" height="${H}"/>
      </svg>
      <div class="bc-tip" hidden></div>
    </div>
    <div class="bc-axis">
      <span>${price(d.bins[0].price)}</span>
      <span class="bc-now">${inRange ? '' : ai < 0 ? '← ' : ''}Harga sekarang ${price(d.currentPrice)}${inRange ? '' : ai < 0 ? ' (di bawah range)' : ' (di atas range) →'}</span>
      <span>${price(d.bins[n - 1].price)}</span>
    </div>
    ${d.note ? `<div class="faint note-sm">${esc(d.note)}</div>` : ''}`;

  // Tooltip per bin (mouse, sentuh, dan panah keyboard).
  const svg = el.querySelector('.bc-svg');
  const tip = el.querySelector('.bc-tip');
  const hover = el.querySelector('.bc-hover');
  let current = inRange ? ai : 0;
  const showAt = (clientX) => {
    const r = svg.getBoundingClientRect();
    show(Math.floor(((clientX - r.left) / r.width) * n));
  };
  const show = (index) => {
    const i = Math.min(n - 1, Math.max(0, index));
    current = i;
    const r = svg.getBoundingClientRect();
    const v = values[i];
    hover.setAttribute('x', String(i * bw));
    hover.setAttribute('width', String(bw));
    tip.hidden = false;
    tip.innerHTML = `<div class="bc-tip-head">Bin ${v.binId}${v.binId === d.activeBin ? ' · <b>aktif</b>' : ''}</div>
      <div>Harga <b>${price(v.price)}</b> ${esc(d.symbolY)}</div>
      <div><i class="bc-dot x"></i>${amt(v.x)} ${esc(d.symbolX)}</div>
      <div><i class="bc-dot y"></i>${amt(v.y)} ${esc(d.symbolY)}</div>
      <div>Nilai di harga bin <b>${amt((v.vx + v.vy) / (d.priceYUsd || 1))}</b> ${esc(d.symbolY)}</div>
      <div class="faint">≈ ${usd(v.nowUsd)} di harga sekarang</div>`;
    const left = ((i + 0.5) / n) * r.width;
    tip.style.left = `${Math.min(Math.max(left, TIP_HALF), r.width - TIP_HALF)}px`;
  };
  const hide = () => {
    tip.hidden = true;
    hover.setAttribute('width', '0');
  };
  svg.addEventListener('mousemove', (e) => showAt(e.clientX));
  svg.addEventListener('mouseleave', hide);
  svg.addEventListener('touchstart', (e) => showAt(e.touches[0].clientX), { passive: true });
  svg.addEventListener('touchmove', (e) => showAt(e.touches[0].clientX), { passive: true });
  svg.addEventListener('focus', () => show(current));
  svg.addEventListener('blur', hide);
  svg.addEventListener('keydown', (e) => {
    const step = { ArrowLeft: -1, ArrowRight: 1 }[e.key];
    if (!step) return;
    e.preventDefault();
    show(current + step);
  });
}
