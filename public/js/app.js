import { api, qs } from './api.js';
import {
  ago,
  amt,
  clock,
  cls,
  combinedPct,
  compactUsd,
  dateShort,
  dayLabel,
  duration,
  esc,
  int,
  num,
  ok,
  pairTokens,
  pct,
  price,
  rangeWidth,
  rangeWidthText,
  short,
  sol,
  sum,
  usd,
} from './fmt.js';
import {
  addrChip,
  avatar,
  BASE58,
  MAX_LABEL,
  busy,
  closeOverlays,
  copyText,
  dpr,
  emptyState,
  errorState,
  eventItem,
  GLOSSARY,
  icon,
  info,
  links,
  modal,
  openRangeText,
  pairLabel,
  pnlText,
  positionCell,
  PROTO,
  protoBadge,
  rangeMini,
  rangePos,
  shortAge,
  sideBadge,
  sideLabel,
  skeleton,
  storage,
  strategyBadge,
  toast,
  tokenIcons,
  tokImg,
  totalFee,
} from './ui.js';
import { settingsPage } from './settings.js';
import { trackPage } from './track.js';
import { renderBinChart } from './binchart.js';

const app = document.getElementById('app');

const APP_TITLE = 'Meteora LP Monitor';
const PROTOCOLS = ['dlmm', 'dammv2'];
/** Jumlah event di feed dashboard & per halaman Aktivitas. */
const FEED_LIMIT = 12;
const ACTIVITY_LIMIT = 50;
/** Teks status "Live · cek hh:mm" diperbarui berkala walau tidak ada event. */
const LIVE_REFRESH_MS = 30_000;
/** Baris per halaman untuk tabel lokal (posisi open). */
const PAGE_SIZE = 20;
/** Kotak cari baru muncul jika posisi lebih dari ini. */
const SEARCH_MIN_ITEMS = 10;
/** Batas |PnL| untuk filter "Sembunyikan PnL kecil" (USD). */
const SMALL_PNL_USD = 1;
/** Layar sempit: tabel posisi default tampil sebagai kartu. */
const MOBILE = window.matchMedia('(max-width: 640px)');

const EMPTY_FEED = () => emptyState('🛰️', 'Belum ada aktivitas. Alert open/close akan muncul di sini secara live.');

const state = {
  token: 0,
  status: null,
  unread: 0,
  notify: storage.get('mlp-notify', '1') === '1',
  // callback halaman aktif untuk event live
  onAlert: null,
  // callback halaman Track Wallet untuk progress job
  onTrack: null,
  trackStatus: null,
};

// ================= util halaman =================

function mount(html) {
  app.innerHTML = html;
}

/**
 * Jalankan loader async; abaikan hasil jika user sudah pindah halaman.
 * Jika `target` (elemen / id) diberikan, isinya diganti pesan error + tombol "Coba lagi" yang
 * menjalankan ulang loader. Tanpa target, error cukup ditampilkan sebagai toast.
 */
async function guarded(token, fn, target) {
  try {
    await fn();
  } catch (err) {
    if (token !== state.token || err.status === 401) return;
    console.error(err);
    const el = typeof target === 'string' ? document.getElementById(target) : target;
    if (!el?.isConnected) return toast('Gagal memuat data', esc(err.message), 'error');
    el.innerHTML = errorState(err.message);
    el.querySelector('[data-retry]').onclick = () => {
      el.innerHTML = skeleton(4);
      guarded(token, fn, el);
    };
  }
}

const live = () => state.token;

function kpi(label, value, sub = '') {
  return `<div class="card kpi"><div class="label">${label}</div><div class="kpi-value">${value}</div>${sub ? `<div class="kpi-sub">${sub}</div>` : ''}</div>`;
}

function summarizeWallet(w) {
  const parts = [w.dlmm, w.dammv2].filter((p) => p && !p.error);
  return {
    ...w,
    error: [w.dlmm, w.dammv2].some((p) => p?.error),
    count: sum(parts, (p) => p.count),
    value: sum(parts, (p) => p.valueUsd),
    pnl: sum(parts, (p) => p.pnlUsd),
    pnlPct: combinedPct(parts.filter((p) => p.count > 0)),
  };
}

/** Jumlah posisi per protokol di tabel dashboard; ⚠️ jika data protokol itu gagal dimuat. */
const countCell = (p) => (p?.error ? `<span class="warn" title="${esc(p.error)}">⚠️</span>` : int(p?.count || 0));

// ================= DASHBOARD =================

const DASH_KPIS = ['Total nilai open', 'PnL posisi open', 'Posisi open', 'Wallet dipantau'];

async function dashboardPage(token) {
  mount(`
    <div class="page-head">
      <div><h1>Dashboard</h1><p>Ringkasan semua wallet yang dipantau · posisi open saat ini</p></div>
      <div class="toolbar"><button class="btn" id="refresh">${icon.refresh}Muat ulang</button>
      <a class="btn primary" href="#/wallets">${icon.plus}Tambah wallet</a></div>
    </div>
    <div class="grid kpis" id="kpis">${DASH_KPIS.map(() => `<div class="card kpi">${skeleton(2)}</div>`).join('')}</div>
    <div class="grid two-col">
      <div class="card"><div class="card-head"><h2>Wallet</h2><span class="muted" id="updated"></span></div><div id="wtable">${skeleton(6)}</div></div>
      <div class="card"><div class="card-head"><h2>Aktivitas terbaru</h2><a class="link" href="#/activity">Lihat semua →</a></div><div class="list" id="feed">${skeleton(5)}</div></div>
    </div>`);

  const refreshBtn = document.getElementById('refresh');
  refreshBtn.onclick = () => busy(refreshBtn, () => loadDashSummary(token, true));

  guarded(
    token,
    async () => {
      const events = await api(`/events?limit=${FEED_LIMIT}`);
      if (token !== live()) return;
      renderFeed(document.getElementById('feed'), events);
      state.onAlert = (evs) => prependFeed(document.getElementById('feed'), evs, FEED_LIMIT);
    },
    'feed',
  );
  loadDashSummary(token, false);
}

function loadDashSummary(token, fresh) {
  return guarded(
    token,
    async () => {
      let data;
      try {
        data = await api(`/summary${fresh ? '?fresh=1' : ''}`);
      } catch (err) {
        const kpis = document.getElementById('kpis');
        if (kpis) kpis.innerHTML = DASH_KPIS.map((l) => kpi(l, '–')).join('');
        throw err;
      }
      if (token !== live()) return;
      renderDashSummary(data);
    },
    'wtable',
  );
}

function renderDashSummary(data) {
  const rows = data.wallets.map(summarizeWallet);
  const activeRows = rows.filter((r) => r.count > 0).sort((a, b) => b.value - a.value);
  const idle = rows.filter((r) => r.count === 0);
  const totalPnl = sum(activeRows, (r) => r.pnl);
  const totalPct = combinedPct(activeRows.map((r) => ({ pnlUsd: r.pnl, pnlPct: r.pnlPct })));
  const muted = rows.filter((r) => r.muted.length === PROTOCOLS.length).length;

  document.getElementById('kpis').innerHTML = [
    kpi(DASH_KPIS[0], usd(sum(activeRows, (r) => r.value)), `${activeRows.length} wallet punya posisi`),
    kpi(DASH_KPIS[1], `<span class="${cls(totalPnl)}">${usd(totalPnl, true)}</span>`, ok(totalPct) ? pct(totalPct) : ''),
    kpi(
      DASH_KPIS[2],
      int(sum(activeRows, (r) => r.count)),
      PROTOCOLS.map((p) => `${PROTO[p]} ${int(sum(rows, (r) => r[p]?.count))}`).join(' · '),
    ),
    kpi(DASH_KPIS[3], int(rows.length), muted ? `${muted} wallet alert-nya dimatikan` : 'Semua alert aktif'),
  ].join('');
  document.getElementById('updated').textContent = `diperbarui ${clock(data.updatedAt / 1000, false)}`;

  const table = document.getElementById('wtable');
  if (!rows.length) {
    table.innerHTML = emptyState('👛', 'Belum ada wallet. <a class="link" href="#/wallets">Tambah wallet</a> untuk mulai memantau.');
    return;
  }
  const tr = (r) => `<tr class="clickable" data-href="#/portfolio/${esc(r.address)}" role="button" tabindex="0" aria-label="Buka portfolio ${esc(r.label)}">
      <td><div class="cell-title">${avatar(r.label)}<div><div>${esc(r.label)}${
        r.muted.length ? ` <span class="faint" title="Alert dimatikan: ${r.muted.map((p) => PROTO[p]).join(' & ')}">🔕</span>` : ''
      }</div><div class="cell-sub mono">${esc(short(r.address))}</div></div></div></td>
      <td class="num hide-sm">${countCell(r.dlmm)}</td>
      <td class="num hide-sm">${countCell(r.dammv2)}</td>
      <td class="num"><b>${r.count ? usd(r.value) : '–'}</b></td>
      <td class="num">${r.count ? pnlText(r.pnl, r.pnlPct) : '<span class="faint">Tidak ada posisi</span>'}</td>
    </tr>`;
  table.innerHTML = `<div class="table-wrap"><table class="table">
      <thead><tr><th>Wallet</th><th class="num hide-sm">${PROTO.dlmm}</th><th class="num hide-sm">${PROTO.dammv2}</th><th class="num">Nilai</th><th class="num">PnL open</th></tr></thead>
      <tbody>${activeRows.map(tr).join('')}${idle.map(tr).join('')}</tbody></table></div>`;
}

function renderFeed(el, events) {
  if (!el) return;
  el.innerHTML = events.length ? events.map((e) => eventItem(e)).join('') : EMPTY_FEED();
}

function prependFeed(el, events, max) {
  if (!el) return;
  el.querySelector('.empty')?.remove();
  el.insertAdjacentHTML('afterbegin', events.map((e) => eventItem(e, { isNew: true })).join(''));
  if (max) while (el.children.length > max) el.lastElementChild.remove();
}

// ================= DAFTAR WALLET =================

async function walletsPage(token) {
  mount(`
    <div class="page-head"><div><h1>Wallet</h1><p>Kelola wallet yang dipantau: tambah, ganti nama, atur alert, atau hapus</p></div></div>
    <div class="card mb">
      <div class="card-head"><h2>Tambah wallet</h2></div>
      <form class="card-body toolbar" id="addForm" autocomplete="off">
        <input class="input mono grow-2" name="address" placeholder="Alamat wallet Solana" aria-label="Alamat wallet Solana" required />
        <input class="input grow-1" name="label" placeholder="Nama / label (mis. Whale 1)" aria-label="Nama wallet" maxlength="${MAX_LABEL}" required />
        <button class="btn primary" type="submit">${icon.plus}Tambah</button>
      </form>
      <div class="card-body muted pt0" id="addMsg" role="status" hidden></div>
    </div>
    <div class="wallet-cards" id="wlist">${Array.from({ length: 6 }, () => `<div class="card">${skeleton(3)}</div>`).join('')}</div>`);

  const form = document.getElementById('addForm');
  const msg = document.getElementById('addMsg');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const address = form.address.value.trim();
    const label = form.label.value.trim();
    msg.hidden = false;
    if (!BASE58.test(address)) {
      msg.innerHTML = '<span class="neg">⚠️ Alamat tidak valid. Alamat Solana terdiri dari 32–44 karakter base58.</span>';
      return;
    }
    await busy(form.querySelector('button'), async () => {
      msg.innerHTML = '<span class="spinner"></span> Menambahkan wallet & membaca posisi awal…';
      try {
        const res = await api('/wallets', { method: 'POST', body: { address, label } });
        const c = res.wallet.counts;
        msg.innerHTML = `<span class="pos">✅ <b>${esc(res.wallet.label)}</b> ditambahkan · ${PROTO.dlmm} ${int(c.dlmm)} · ${PROTO.dammv2} ${int(c.dammv2)} posisi open. Alert akan muncul saat ada posisi baru dibuka/ditutup.</span>`;
        form.reset();
        loadWallets();
        loadWalletCards(token);
      } catch (err) {
        msg.innerHTML = `<span class="neg">⚠️ ${esc(err.message)}</span>`;
      }
    });
  };
  loadWalletCards(token);
}

function loadWalletCards(token) {
  return guarded(
    token,
    async () => {
      const wallets = await api('/wallets');
      if (token !== live()) return;
      const el = document.getElementById('wlist');
      if (!wallets.length) {
        el.innerHTML = `<div class="card">${emptyState('👛', 'Belum ada wallet. Tambahkan lewat form di atas.')}</div>`;
        return;
      }
      el.innerHTML = wallets.map(walletCard).join('');
      bindWalletActions(el, wallets, () => loadWalletCards(token));
    },
    'wlist',
  );
}

function walletCard(w) {
  const total = w.counts.dlmm + w.counts.dammv2;
  const counts = total
    ? PROTOCOLS.map((p) => `<span class="badge ${p}">${PROTO[p]} ${int(w.counts[p])}</span>`).join('')
    : '<span class="badge gray">Tidak ada posisi open</span>';
  return `<div class="card wcard" data-addr="${esc(w.address)}">
    <div class="wcard-top">${avatar(w.label)}<div class="min0">
      <div class="wcard-name">${esc(w.label)}</div>${addrChip(w.address)}</div></div>
    <div class="wcard-stats">${counts}</div>
    ${alertToggles(w)}
    <div class="wcard-actions">
      <a class="btn sm primary" href="#/portfolio/${esc(w.address)}">Buka portfolio</a>
      <button class="btn sm" data-act="rename">${icon.edit}Ganti nama</button>
      <span class="spacer"></span>
      <button class="btn sm icon danger" data-act="delete" title="Hapus wallet" aria-label="Hapus wallet ${esc(w.label)}">${icon.trash}</button>
    </div>
  </div>`;
}

function alertToggles(w) {
  return `<div class="toggle-row"><span class="toggle-label">Alert:</span>
    ${PROTOCOLS.map((p) => {
      const on = !w.muted.includes(p);
      return `<button class="toggle ${on ? 'on' : ''}" data-toggle="${p}" aria-pressed="${on}" title="Klik untuk ${on ? 'mematikan' : 'menyalakan'} alert ${PROTO[p]}"><span class="dot"></span>${PROTO[p]}</button>`;
    }).join('')}
  </div>`;
}

/** Aksi ganti nama / hapus / toggle alert pada elemen yang punya data-addr. */
function bindWalletActions(root, wallets, reload) {
  root.onclick = async (e) => {
    const card = e.target.closest('[data-addr]');
    const w = card && wallets.find((x) => x.address === card.dataset.addr);
    if (!w) return;
    const toggle = e.target.closest('[data-toggle]');
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (toggle) await toggleAlert(w, toggle);
    else if (act === 'rename') await renameWallet(w, reload);
    else if (act === 'delete') await deleteWallet(w, reload);
  };
}

function toggleAlert(w, btn) {
  const p = btn.dataset.toggle;
  const muted = w.muted.includes(p) ? w.muted.filter((x) => x !== p) : [...w.muted, p];
  return busy(btn, async () => {
    try {
      const updated = await api(`/wallets/${w.address}`, { method: 'PATCH', body: { muted } });
      w.muted = updated.muted;
      const on = !muted.includes(p);
      btn.classList.toggle('on', on);
      btn.setAttribute('aria-pressed', String(on));
      btn.title = `Klik untuk ${on ? 'mematikan' : 'menyalakan'} alert ${PROTO[p]}`;
      toast(on ? '🔔 Alert dinyalakan' : '🔕 Alert dimatikan', `${esc(w.label)} · ${PROTO[p]}`);
    } catch (err) {
      toast('Gagal menyimpan', esc(err.message), 'error');
    }
  });
}

async function renameWallet(w, reload) {
  const label = await modal({
    title: 'Ganti nama wallet',
    body: `<p class="mt0">Wallet <code>${esc(short(w.address))}</code></p>`,
    input: { value: w.label, placeholder: 'Nama baru' },
    confirmText: 'Simpan',
    validate: async (v) => {
      if (!v) return 'Nama wajib diisi.';
      try {
        await api(`/wallets/${w.address}`, { method: 'PATCH', body: { label: v } });
        return '';
      } catch (err) {
        return err.message;
      }
    },
  });
  if (!label) return;
  toast('✅ Nama diganti', `${esc(w.label)} → ${esc(label)}`);
  loadWallets();
  reload();
}

async function deleteWallet(w, reload) {
  const yes = await modal({
    title: 'Hapus wallet?',
    body: `<p class="mt0"><b>${esc(w.label)}</b> <code>${esc(short(w.address))}</code> akan berhenti dipantau dan data posisinya dihapus.</p>`,
    confirmText: 'Ya, hapus',
    danger: true,
  });
  if (!yes) return;
  try {
    await api(`/wallets/${w.address}`, { method: 'DELETE' });
  } catch (err) {
    toast('Gagal menghapus wallet', esc(err.message), 'error');
    return;
  }
  toast('🗑 Wallet dihapus', esc(w.label));
  loadWallets();
  reload();
}

// ================= PORTFOLIO (ala LP Agent) =================

const MONTHS = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
const DOW = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];
const SORT_ICON = `<span class="sort" aria-hidden="true"><svg class="up" viewBox="0 0 10 6"><path d="M1 5l4-4 4 4"/></svg><svg class="down" viewBox="0 0 10 6"><path d="M1 1l4 4 4-4"/></svg></span>`;
const VIEW_ICONS = {
  card: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>',
  table: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="1"/><path d="M3 10h18M3 15h18M9 4v16"/></svg>',
  chart: '<svg viewBox="0 0 24 24"><path d="M3 3v18h18M7 16l4-5 3 3 5-7"/></svg>',
  calendar: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>',
};
const ICON_CLOSE = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';

const extLinks = (p) => `<div class="toolbar ext-links">
  <a class="btn sm icon ghost" href="${links.pool(p.protocol, p.pool)}" target="_blank" rel="noopener" title="Buka pool di Meteora" aria-label="Buka pool di Meteora">${icon.ext}</a>
  <a class="btn sm icon ghost" href="${links.account(p.position)}" target="_blank" rel="noopener" title="Lihat posisi di Solscan" aria-label="Lihat posisi di Solscan">${icon.search}</a>
</div>`;

/** Tombol segmen (filter / pilihan tampilan) dengan status aria-pressed. */
const segBtn = (key, value, label, current, extra = '') =>
  `<button class="${current === value ? 'active' : ''}" data-${key}="${value}" aria-pressed="${current === value}" ${extra}>${label}</button>`;

// Kalender memakai tanggal UTC karena data harian dari API Meteora dikelompokkan per hari UTC.
const monthKey = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
const pctOf = (v, base) => (ok(v) && ok(base) && base > 0 ? (v / base) * 100 : undefined);
const twoLine = (main, sub, c = '') => `<div class="two-line ${c}"><span>${main}</span>${sub ? `<small>${sub}</small>` : ''}</div>`;

async function portfolioPage(token, address) {
  if (!BASE58.test(address || '')) {
    mount(`<div class="card">${emptyState('🔍', 'Alamat wallet tidak valid.')}</div>`);
    return;
  }
  mount(`
    <div class="pf-head" id="pfHead">${addrChip(address, true)}<span class="badge gray">◎ Solana</span></div>
    <div class="pf-meta">
      <span>Lihat di</span><a href="${links.account(address)}" target="_blank" rel="noopener">Solscan ${icon.ext}</a>
      <span class="sep-dot"></span><a href="#/activity/${esc(address)}">Aktivitas alert</a>
      <span class="sep-dot"></span>
      <button class="btn sm ghost icon" id="pfRefresh" title="Muat ulang data" aria-label="Muat ulang data">${icon.refresh}</button>
      <span>Terakhir diperbarui: <b id="pfUpdated" class="text-strong">memuat…</b></span>
    </div>
    <div class="notice">⚠️ Data PnL diambil dari API Meteora dan bisa berbeda dari hasil sebenarnya. DPR &amp; perkiraan harga saat close dihitung oleh dashboard ini.</div>
    <div class="card overview">
      <div class="stat-list" id="pfStats">${skeleton(6)}</div>
      <div><div class="label mb-sm">Riwayat profit</div><div class="calendar-box" id="pfCal">${skeleton(7)}</div></div>
    </div>
    <div class="card mt" id="openCard">${skeleton(8)}</div>
    <div class="card mt" id="histCard">${skeleton(8)}</div>`);

  const calState = { month: monthKey(new Date()), proto: 'all', view: 'calendar', seq: 0 };
  const refresh = (fresh) =>
    Promise.all([
      loadPfHead(token, address),
      loadPfStats(token, address, fresh),
      renderCalendar(token, address, calState, fresh),
      loadOpenCard(token, address, fresh),
      loadHistCard(token, address, fresh),
    ]);
  const refreshBtn = document.getElementById('pfRefresh');
  refreshBtn.onclick = () => busy(refreshBtn, () => refresh(true));
  refresh(false);
}

function loadPfHead(token, address) {
  return guarded(token, async () => {
    const data = await api(`/portfolio/${address}`);
    if (token !== live()) return;
    const head = document.getElementById('pfHead');
    const w = data.tracked;
    const base = `${addrChip(address, true)}<span class="badge gray">◎ Solana</span>`;
    if (!w) {
      head.innerHTML = `${base}<button class="btn sm primary" id="trackBtn">${icon.plus}Pantau wallet ini</button>`;
      document.getElementById('trackBtn').onclick = () => watchAddress(token, address);
      return;
    }
    head.innerHTML = `<span class="pf-label">${esc(w.label)}</span>${base}<span class="spacer"></span>
      <div class="toolbar" data-addr="${esc(w.address)}">${alertToggles(w)}
        <button class="btn sm" data-act="rename">${icon.edit}Ganti nama</button>
        <button class="btn sm danger icon" data-act="delete" title="Berhenti memantau" aria-label="Berhenti memantau wallet ini">${icon.trash}</button></div>`;
    bindWalletActions(head, [w], () => loadPfHead(token, address));
  });
}

async function watchAddress(token, address) {
  const label = await modal({
    title: 'Pantau wallet ini',
    body: `<p class="mt0">Alert akan dikirim setiap wallet <code>${esc(short(address))}</code> membuka / menutup posisi.</p>`,
    input: { placeholder: 'Nama / label wallet' },
    confirmText: 'Pantau',
    validate: async (v) => {
      if (!v) return 'Nama wajib diisi.';
      try {
        await api('/wallets', { method: 'POST', body: { address, label: v } });
        return '';
      } catch (err) {
        return err.message;
      }
    },
  });
  if (!label) return;
  toast('✅ Wallet dipantau', esc(label));
  loadWallets();
  loadPfHead(token, address);
}

function loadPfStats(token, address, fresh) {
  return guarded(
    token,
    async () => {
      const o = await api(`/portfolio/${address}/overview${fresh ? '?fresh=1' : ''}`);
      if (token !== live()) return;
      const el = document.getElementById('pfStats');
      el.innerHTML = pfStatsHtml(o);
      if (o.errors?.length) el.insertAdjacentHTML('beforeend', `<div class="span2 neg small">⚠️ ${esc(o.errors.join('; '))}</div>`);
    },
    'pfStats',
  );
}

function pfStatsHtml(o) {
  const a = o.all || {};
  const m = o.month || {};
  const fee = (num(a.realized_fee_earned_usd) || 0) + (num(a.unrealized_fee_earned_usd) || 0);
  const win = num(a.win_rate_usd);
  const stat = (label, value, sub = '', span2 = false) =>
    `<div class="${span2 ? 'span2' : ''}"><div class="label">${label}</div><div class="v ${span2 ? 'big' : ''}">${value}</div>${sub ? `<div class="s">${sub}</div>` : ''}</div>`;
  const colored = (v) => `<span class="${cls(v)}">${usd(v, true)}</span>`;
  const biggestProto = a.biggest_pnl_usd_protocol ? (PROTO[a.biggest_pnl_usd_protocol] ?? String(a.biggest_pnl_usd_protocol).toUpperCase()) : '';
  return [
    netWorthHtml(o),
    stat('Total closed', int(a.closed_count ?? 0), `${int(a.open_count ?? 0)} masih open`),
    stat('Win rate', ok(win) ? `<span class="${win >= 50 ? 'pos' : 'neg'}">${win.toFixed(1)}%</span>` : '–', `${int(a.win_count_usd ?? 0)} profit · ${int(a.loss_count_usd ?? 0)} rugi`),
    stat('Rata-rata modal', usd(num(a.avg_invested_usd))),
    stat('Fee diperoleh', usd(fee)),
    stat('Total profit', colored(num(a.pnl_usd)), ok(num(a.pnl_pct_change)) ? pct(num(a.pnl_pct_change)) : ''),
    stat('Profit 30 hari', colored(num(m.pnl_usd)), m.closed_count ? `${int(m.closed_count)} posisi ditutup` : ''),
    stat(`uPnL ${info(GLOSSARY.upnl)}`, colored(num(a.unrealized_pnl_usd)), 'Posisi yang masih open'),
    stat('Profit terbesar', colored(num(a.biggest_pnl_usd)), esc(biggestProto)),
  ].join('');
}

/**
 * Kartu "Total aset": angka utama + setara SOL, bar komposisi, lalu rincian per sumber
 * (posisi LP, SOL & USDC di wallet) dalam baris label–nilai supaya mudah dipindai.
 */
function netWorthHtml(o) {
  const solUsd = ok(o.solBalance) && ok(o.solPrice) ? o.solBalance * o.solPrice : undefined;
  const parts = [
    {
      key: 'lp',
      label: 'Posisi LP',
      usd: o.lpUsd,
      sub: ok(o.unclaimedFeeUsd) && o.unclaimedFeeUsd > 0 ? `termasuk fee belum diklaim ${usd(o.unclaimedFeeUsd)}` : '',
    },
    { key: 'sol', label: 'SOL di wallet', usd: solUsd, sub: ok(o.solBalance) ? sol(o.solBalance) : '', failed: !ok(o.solBalance) },
    { key: 'usdc', label: 'USDC di wallet', usd: o.usdcBalance, failed: !ok(o.usdcBalance) },
  ];
  const total = sum(parts, (p) => p.usd);
  const share = (p) => (ok(p.usd) && total > 0 ? (p.usd / total) * 100 : 0);
  const bar = total > 0
    ? `<div class="worth-bar" aria-hidden="true">${parts.map((p) => (share(p) > 0 ? `<span class="w-${p.key}" style="width:${share(p)}%"></span>` : '')).join('')}</div>`
    : '';
  const rows = parts
    .map(
      (p) => `<div class="worth-row">
        <span class="worth-name"><i class="worth-dot w-${p.key}"></i>${p.label}</span>
        <span class="worth-val">${p.failed ? '<span class="neg">Gagal dibaca</span>' : `<b>${usd(p.usd)}</b>${p.sub ? `<small>${p.sub}</small>` : ''}`}</span>
      </div>`,
    )
    .join('');
  return `<div class="span2">
    <div class="label">Total aset</div>
    <div class="worth-head"><span class="v big">${usd(o.netWorthUsd)}</span>${ok(o.netWorthSol) ? `<span class="muted">≈ ${sol(o.netWorthSol)}</span>` : ''}</div>
    ${bar}
    <div class="worth-list">${rows}</div>
  </div>`;
}

// ---------- kalender profit ----------

async function renderCalendar(token, address, st, fresh = false) {
  const el = document.getElementById('pfCal');
  if (!el) return;
  const [y, mo] = st.month.split('-').map(Number);
  const isCurrent = st.month === monthKey(new Date());
  el.innerHTML = `
    <div class="cal-tools">
      <div class="seg" role="group" aria-label="Filter protokol">${segBtn('proto', 'all', 'Semua', st.proto)}${PROTOCOLS.map((p) => segBtn('proto', p, PROTO[p], st.proto)).join('')}</div>
      <div class="seg" role="group" aria-label="Tampilan">
        ${segBtn('view', 'chart', VIEW_ICONS.chart, st.view, 'title="Grafik" aria-label="Tampilan grafik"')}
        ${segBtn('view', 'calendar', VIEW_ICONS.calendar, st.view, 'title="Kalender" aria-label="Tampilan kalender"')}
      </div>
    </div>
    <div class="cal-nav">
      <button class="btn sm ghost icon" data-nav="-1" aria-label="Bulan sebelumnya">${icon.back}</button>
      <h3>${MONTHS[mo - 1]} ${y}</h3>
      <button class="btn sm ghost icon" data-nav="1" aria-label="Bulan berikutnya" ${isCurrent ? 'disabled' : ''}>${icon.chevron}</button>
    </div>
    <div id="calBody">${skeleton(5)}</div>
    <div class="cal-foot" id="calFoot"></div>`;
  el.onclick = (e) => {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    if (b.dataset.proto) st.proto = b.dataset.proto;
    if (b.dataset.view) st.view = b.dataset.view;
    if (b.dataset.nav) st.month = monthKey(new Date(Date.UTC(y, mo - 1 + Number(b.dataset.nav), 1)));
    renderCalendar(token, address, st);
  };

  // Nomor urut permintaan: respons bulan/filter lama yang datang terlambat diabaikan.
  const my = ++st.seq;
  await guarded(
    token,
    async () => {
      const days = await api(`/portfolio/${address}/calendar?month=${st.month}${fresh ? '&fresh=1' : ''}`);
      if (token !== live() || my !== st.seq || !document.getElementById('calBody')) return;
      drawCalendar(days, st, y, mo);
    },
    'calBody',
  );
}

function drawCalendar(days, st, y, mo) {
  const stat = (d) => d[st.proto];
  const total = sum(days, (d) => stat(d).pnl);
  const closed = sum(days, (d) => stat(d).closed);
  const fees = sum(days, (d) => stat(d).fees);
  const wins = sum(days, (d) => stat(d).wins);
  const today = new Date().toISOString().slice(0, 10);
  const tip = (d) => {
    const s = stat(d);
    return `${dateShort(d.date)}\nPnL ${usd(s.pnl, true)} · ${s.closed} posisi ditutup (${s.wins} profit / ${s.losses} rugi)\nFee ${usd(s.fees)}`;
  };

  const body = document.getElementById('calBody');
  if (st.view === 'calendar') {
    const first = new Date(Date.UTC(y, mo - 1, 1)).getUTCDay();
    const cells = [...DOW.map((d) => `<div class="cal-dow">${d}</div>`), ...Array.from({ length: first }, () => '<div class="cal-day empty"></div>')];
    for (const d of days) {
      const s = stat(d);
      const c = s.pnl > 0 ? 'win' : s.pnl < 0 ? 'loss' : '';
      cells.push(`<div class="cal-day ${c} ${d.date === today ? 'today' : ''}" title="${esc(tip(d))}">
          <span class="d">${Number(d.date.slice(8))}</span>${s.closed || s.pnl ? `<span class="p ${cls(s.pnl)}">${compactUsd(s.pnl)}</span>` : ''}</div>`);
    }
    body.innerHTML = `<div class="cal-grid">${cells.join('')}</div>`;
  } else {
    const max = Math.max(1e-9, ...days.map((d) => Math.abs(stat(d).pnl)));
    const hasNeg = days.some((d) => stat(d).pnl < 0);
    const hasPos = days.some((d) => stat(d).pnl > 0);
    const zeroPct = hasNeg && hasPos ? 50 : hasNeg ? 100 : 0;
    body.innerHTML = `<div class="bars stretch">
        <div class="zero" style="bottom:${zeroPct}%"></div>
        ${days
          .map((d) => {
            const v = stat(d).pnl;
            const h = (Math.abs(v) / max) * (hasNeg && hasPos ? 50 : 100);
            const at = v < 0 ? `top:${100 - zeroPct}%` : `bottom:${zeroPct}%`;
            return `<div class="bar-col" title="${esc(tip(d))}"><div class="bar ${v < 0 ? 'neg' : ''}" style="${at};height:${h}%"></div></div>`;
          })
          .join('')}
      </div><div class="bars-x"><span>1</span><span>${Math.ceil(days.length / 2)}</span><span>${days.length}</span></div>`;
  }
  document.getElementById('calFoot').innerHTML = `<span>Total profit <b class="${cls(total)}">${usd(total, true)}</b></span>
      <span>${int(closed)} ditutup · win rate ${closed ? ((wins / closed) * 100).toFixed(0) : 0}% · fee ${usd(fees)}</span>`;
}

// ---------- tabel posisi (open & historis) ----------

/**
 * Tabel dengan filter protokol, cari, sort, pagination, dan mode kartu/tabel.
 * cols: [{ key, label, hint?, sort?, cls?, render(p) }]
 *
 * Sumber data:
 *  - lokal  : opts.items (semua posisi sudah ada di browser; pagination di browser)
 *  - remote : opts.remote(state) → { items, total, hasNext, errors } — satu halaman diambil dari server
 *             setiap pindah halaman / ganti filter protokol. Cari, sort & "PnL kecil" berlaku di halaman itu.
 */
function positionTable(card, opts) {
  const viewKey = `mlp-view-${opts.id}`;
  const st = {
    type: 'all',
    q: '',
    page: 0,
    view: storage.get(viewKey, MOBILE.matches ? 'card' : 'table'),
    sort: opts.defaultSort,
    dir: opts.defaultDir ?? 'desc',
    hideSmall: opts.hideSmall ?? false,
    focusQ: false,
  };
  let rendered = [];
  let seq = 0;

  const sortList = (list) => {
    const col = opts.cols.find((c) => c.key === st.sort);
    if (!col?.sort) return list;
    return [...list].sort((a, b) => ((col.sort(a) ?? -Infinity) - (col.sort(b) ?? -Infinity)) * (st.dir === 'asc' ? 1 : -1));
  };
  const localFilter = (list) => {
    let out = list.filter((p) => !st.q || p.pair.toLowerCase().includes(st.q) || p.position.toLowerCase().startsWith(st.q));
    if (opts.smallFilter && st.hideSmall) out = out.filter((p) => Math.abs(p.pnlUsd ?? 0) >= SMALL_PNL_USD);
    return out;
  };

  async function viewModel() {
    if (!opts.remote) {
      const list = sortList(localFilter(opts.items.filter((p) => st.type === 'all' || p.protocol === st.type)));
      const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
      st.page = Math.min(st.page, pages - 1);
      return {
        list,
        rows: list.slice(st.page * PAGE_SIZE, (st.page + 1) * PAGE_SIZE),
        errors: opts.errors,
        hasPrev: st.page > 0,
        hasNext: st.page < pages - 1,
        pager: pages > 1 ? `${int(st.page * PAGE_SIZE + 1)}–${int(Math.min(list.length, (st.page + 1) * PAGE_SIZE))} dari ${int(list.length)}` : '',
        showSearch: opts.items.length > SEARCH_MIN_ITEMS,
      };
    }
    const r = await opts.remote(st);
    const start = r.page * r.pageSize;
    const list = sortList(localFilter(r.items));
    return {
      ...r,
      list,
      rows: list,
      hasPrev: st.page > 0,
      hasNext: r.hasNext,
      pager: r.items.length || st.page > 0 ? `Halaman ${int(st.page + 1)} · posisi ${int(start + 1)}–${int(start + r.items.length)} dari ${int(Math.max(r.total, start + r.items.length))}` : '',
      showSearch: true,
    };
  }

  function setLoading() {
    const body = card.querySelector('.table-wrap, .pos-cards, .empty');
    if (body) body.classList.add('is-loading');
    const pager = card.querySelector('.pager span');
    if (pager) pager.innerHTML = '<span class="spinner"></span> Memuat posisi…';
    card.querySelectorAll('.pager button').forEach((b) => (b.disabled = true));
  }

  const toolbarHtml = (v) => `<div class="toolbar">
      ${opts.smallFilter ? `<label class="switch" title="Sembunyikan posisi dengan |PnL| < $${SMALL_PNL_USD}"><input type="checkbox" data-small ${st.hideSmall ? 'checked' : ''}/><span class="track" aria-hidden="true"></span>Sembunyikan PnL kecil</label>` : ''}
      <div class="seg" role="group" aria-label="Filter protokol">${segBtn('type', 'all', 'Semua', st.type)}${PROTOCOLS.map((p) => segBtn('type', p, PROTO[p], st.type)).join('')}</div>
      ${v.showSearch ? `<input class="input input-search" type="search" data-q placeholder="${opts.remote ? 'Cari di halaman ini…' : 'Cari pair…'}" aria-label="Cari posisi" value="${esc(st.q)}" />` : ''}
      <div class="seg green" role="group" aria-label="Tampilan">${segBtn('view', 'card', `${VIEW_ICONS.card}Kartu`, st.view)}${segBtn('view', 'table', `${VIEW_ICONS.table}Tabel`, st.view)}</div>
    </div>`;

  const ariaSort = (c) => (st.sort !== c.key ? 'none' : st.dir === 'asc' ? 'ascending' : 'descending');
  const headLabel = (c) => `${c.label}${c.hint ? ' <span class="hint" aria-hidden="true">ⓘ</span>' : ''}`;
  const headCell = (c) =>
    c.sort
      ? `<th class="${c.cls ?? ''} sortable ${st.sort === c.key ? st.dir : ''}" data-sort="${c.key}" aria-sort="${ariaSort(c)}" ${c.hint ? `title="${esc(c.hint)}"` : ''}><button class="th-btn">${headLabel(c)}${SORT_ICON}</button></th>`
      : `<th class="${c.cls ?? ''}" ${c.hint ? `title="${esc(c.hint)}"` : ''}>${headLabel(c)}</th>`;
  const rowAttrs = (p) => `data-pos="${esc(p.position)}" role="button" tabindex="0" aria-label="Detail posisi ${pairLabel(p)}"`;

  const tableHtml = (v) => `<div class="table-wrap"><table class="table">
      <thead><tr>${opts.cols.map(headCell).join('')}</tr></thead>
      <tbody>
        ${v.rows.map((p) => `<tr class="clickable" ${rowAttrs(p)}>${opts.cols.map((c) => `<td class="${c.cls ?? ''}">${c.render(p)}</td>`).join('')}</tr>`).join('')}
        ${opts.totalRow ? `<tr class="total">${opts.totalRow(v.list)}</tr>` : ''}
      </tbody></table></div>`;

  const cardsHtml = (v) => `<div class="pos-cards">${v.rows.map((p) => `<div class="pcard" ${rowAttrs(p)}>${opts.card(p)}</div>`).join('')}</div>`;

  const bodyHtml = (v) => {
    if (!v.rows.length) return emptyState(opts.emptyEmoji, st.q || st.hideSmall ? 'Tidak ada posisi yang cocok dengan filter di halaman ini.' : opts.emptyText);
    return st.view === 'table' ? tableHtml(v) : cardsHtml(v);
  };

  const pagerHtml = (v) => {
    if (!v.hasPrev && !v.hasNext) return v.pager ? `<div class="card-foot pager"><span>${v.pager}</span></div>` : '';
    return `<div class="card-foot pager"><button class="btn sm" data-page="-1" ${v.hasPrev ? '' : 'disabled'}>${icon.back}Sebelumnya</button>
      <span>${v.pager}</span>
      <button class="btn sm" data-page="1" ${v.hasNext ? '' : 'disabled'}>Berikutnya${icon.chevron}</button></div>`;
  };

  async function draw() {
    const my = ++seq;
    let v;
    try {
      v = await viewModel();
    } catch (err) {
      if (my !== seq || err.status === 401) return;
      card.innerHTML = `<div class="card-head"><h2>${opts.title({ list: [], total: 0 })}</h2></div>${errorState(err.message)}`;
      card.querySelector('[data-retry]').onclick = draw;
      return;
    }
    if (my !== seq || !card.isConnected) return;
    rendered = v.rows;
    card.innerHTML = `<div class="card-head">
        <div><h2>${opts.title(v)}</h2><div class="card-sub">${opts.summary(v)}</div></div>
        ${toolbarHtml(v)}
      </div>
      ${v.errors?.length ? `<div class="error-box">⚠️ Sebagian data gagal dimuat: ${esc(v.errors.join('; '))}</div>` : ''}
      ${bodyHtml(v)}
      ${pagerHtml(v)}`;
    const q = card.querySelector('[data-q]');
    if (q && st.focusQ) {
      q.focus();
      q.setSelectionRange(q.value.length, q.value.length);
    }
  }

  card.onclick = (e) => {
    const t = e.target;
    const typeBtn = t.closest('[data-type]');
    const viewBtn = t.closest('[data-view]');
    const pageBtn = t.closest('[data-page]');
    const th = t.closest('th[data-sort]');
    let refetch = false;
    if (typeBtn) {
      if (st.type === typeBtn.dataset.type) return;
      st.type = typeBtn.dataset.type;
      st.page = 0;
      refetch = true;
    } else if (viewBtn) {
      st.view = viewBtn.dataset.view;
      storage.set(viewKey, st.view);
    } else if (pageBtn) {
      if (pageBtn.disabled) return;
      st.page = Math.max(0, st.page + Number(pageBtn.dataset.page));
      refetch = true;
      card.scrollIntoView({ block: 'start', behavior: 'smooth' });
    } else if (th) {
      if (st.sort === th.dataset.sort) st.dir = st.dir === 'desc' ? 'asc' : 'desc';
      else {
        st.sort = th.dataset.sort;
        st.dir = 'desc';
      }
    } else {
      const row = t.closest('[data-pos]');
      if (row && !t.closest('a,button,input,label')) {
        const p = rendered.find((x) => x.position === row.dataset.pos);
        if (p) openDrawer(p, opts.kind);
      }
      return;
    }
    st.focusQ = false;
    if (refetch && opts.remote) setLoading();
    draw();
  };
  card.oninput = (e) => {
    if (e.target.matches('[data-q]')) {
      st.q = e.target.value.trim().toLowerCase();
      if (!opts.remote) st.page = 0;
      st.focusQ = true;
      draw();
    }
  };
  card.onchange = (e) => {
    if (e.target.matches('[data-small]')) {
      st.hideSmall = e.target.checked;
      if (!opts.remote) st.page = 0;
      draw();
    }
  };
  draw();
}

// Kolom & isi kartu yang dipakai bersama tabel posisi open dan historis.
const COL = {
  name: { key: 'name', label: 'Posisi / Pool', render: positionCell },
  age: (endOf) => ({ key: 'age', label: 'Umur', cls: 'num', sort: (p) => endOf(p) - (p.openedAt ?? 0), render: (p) => `<b>${shortAge(p)}</b>` }),
  invested: { key: 'invested', label: 'Modal', cls: 'num', sort: (p) => p.depositUsd, render: (p) => usd(p.depositUsd) },
  fee: {
    key: 'fee',
    label: 'Total fee',
    cls: 'num',
    sort: (p) => totalFee(p),
    render: (p) => twoLine(usd(totalFee(p)), pct(pctOf(totalFee(p), p.depositUsd)), 'pos'),
  },
  pnl: (label, hint) => ({
    key: 'pnl',
    label,
    hint,
    cls: 'num',
    sort: (p) => p.pnlUsd,
    render: (p) => twoLine(usd(p.pnlUsd, true), pct(p.pnlPct), cls(p.pnlUsd)),
  }),
  dpr: { key: 'dpr', label: 'DPR', hint: GLOSSARY.dpr, cls: 'num', sort: (p) => dpr(p), render: (p) => `<span class="${cls(dpr(p))}">${pct(dpr(p))}</span>` },
  range: (mode, hint) => ({ key: 'range', label: 'Range', hint, cls: 'hide-sm', render: (p) => rangeMini(p, mode) }),
  act: { key: 'act', label: 'Aksi', cls: 'num', render: extLinks },
};

const statBox = (label, value, c = '') => `<div><div class="label">${label}</div><b class="${c}">${value}</b></div>`;
const posCard = (p, mode, stats) => `${positionCell(p)}<div class="pcard-stats">${stats.join('')}</div>${rangeMini(p, mode)}`;

function loadOpenCard(token, address, fresh) {
  const card = document.getElementById('openCard');
  return guarded(
    token,
    async () => {
      const d = await api(`/portfolio/${address}/open${fresh ? '?fresh=1' : ''}`);
      if (token !== live()) return;
      const upd = document.getElementById('pfUpdated');
      if (upd) {
        upd.textContent = ago(d.updatedAt / 1000);
        upd.title = clock(d.updatedAt / 1000);
      }
      const value = (l) => sum(l, (p) => p.valueUsd);
      const invested = (l) => sum(l, (p) => p.depositUsd);
      const pnl = (l) => sum(l, (p) => p.pnlUsd);
      const fee = (l) => sum(l, totalFee);
      positionTable(card, {
        id: 'open',
        kind: 'open',
        items: d.positions,
        errors: d.errors,
        defaultSort: 'age',
        defaultDir: 'asc',
        title: (v) => `Posisi open (${int(v.list.length)})`,
        summary: ({ list: l }) =>
          `<span>Total nilai <b>${usd(value(l))}</b></span>
         <span>Total uPnL <b class="${cls(pnl(l))}">${usd(pnl(l), true)}</b> <small class="${cls(pnl(l))}">${pct(pctOf(pnl(l), invested(l)))}</small></span>
         <span>Fee diklaim <b class="pos">${usd(sum(l, (p) => p.claimedFeesUsd))}</b></span>
         <span>Fee belum diklaim <b class="pos">${usd(sum(l, (p) => p.unclaimedFeesUsd))}</b></span>`,
        emptyEmoji: '💤',
        emptyText: 'Tidak ada posisi open.',
        cols: [
          COL.name,
          COL.age(() => Date.now() / 1000),
          COL.invested,
          { key: 'value', label: 'Nilai', cls: 'num', sort: (p) => p.valueUsd, render: (p) => `<b>${usd(p.valueUsd)}</b>` },
          COL.fee,
          COL.pnl('uPnL', GLOSSARY.upnl),
          COL.dpr,
          COL.range('now'),
          COL.act,
        ],
        totalRow: (l) =>
          `<td>Total</td><td></td><td class="num">${usd(invested(l))}</td><td class="num">${usd(value(l))}</td>
         <td class="num">${twoLine(usd(fee(l)), pct(pctOf(fee(l), invested(l))), 'pos')}</td>
         <td class="num">${twoLine(usd(pnl(l), true), pct(pctOf(pnl(l), invested(l))), cls(pnl(l)))}</td><td></td><td class="hide-sm"></td><td></td>`,
        card: (p) =>
          posCard(p, 'now', [
            statBox('Nilai', usd(p.valueUsd)),
            statBox('uPnL', usd(p.pnlUsd, true), cls(p.pnlUsd)),
            statBox('Fee', usd(totalFee(p)), 'pos'),
            statBox('Umur', shortAge(p)),
            statBox('Modal', usd(p.depositUsd)),
            statBox('DPR', pct(dpr(p)), cls(dpr(p))),
          ]),
      });
    },
    card,
  );
}

function loadHistCard(token, address, fresh) {
  const card = document.getElementById('histCard');
  const pnl = (l) => sum(l, (p) => p.pnlUsd);
  let refresh = fresh;
  positionTable(card, {
    id: 'hist',
    kind: 'closed',
    // Satu halaman = 100 posisi dari server; halaman berikutnya diambil saat klik Berikutnya.
    remote: async (st) => {
      const r = await api(`/portfolio/${address}/history${qs({ page: st.page, protocol: st.type, fresh: refresh ? 1 : undefined })}`);
      refresh = false;
      if (token !== live()) throw Object.assign(new Error('pindah halaman'), { status: 401 });
      return r;
    },
    defaultSort: 'closed',
    smallFilter: true,
    hideSmall: false,
    title: (v) => `Posisi historis${ok(v.total) && v.total ? ` (${int(v.total)})` : ''}`,
    summary: (v) => {
      const l = v.list;
      const winRate = l.length ? (l.filter((p) => (p.pnlUsd ?? 0) > 0).length / l.length) * 100 : 0;
      return `<span class="faint">Halaman ini:</span>
        <span>PnL <b class="${cls(pnl(l))}">${usd(pnl(l), true)}</b></span>
        <span>Fee <b class="pos">${usd(sum(l, totalFee))}</b></span>
        <span>Win rate <b class="${l.length ? (winRate >= 50 ? 'pos' : 'neg') : ''}">${winRate.toFixed(0)}%</b></span>`;
    },
    emptyEmoji: '📭',
    emptyText: 'Belum ada posisi yang ditutup.',
    cols: [
      COL.name,
      COL.age((p) => p.closedAt ?? 0),
      COL.invested,
      COL.fee,
      COL.pnl('PnL'),
      COL.dpr,
      COL.range('exit', GLOSSARY.exitRange),
      { key: 'closed', label: 'Waktu close', cls: 'num', sort: (p) => p.closedAt, render: (p) => `<span title="${esc(clock(p.closedAt))}">${ago(p.closedAt)}</span>` },
      COL.act,
    ],
    card: (p) =>
      posCard(p, 'exit', [
        statBox('PnL', usd(p.pnlUsd, true), cls(p.pnlUsd)),
        statBox('Fee', usd(totalFee(p)), 'pos'),
        statBox('Modal', usd(p.depositUsd)),
        statBox('Umur', shortAge(p)),
        statBox('DPR', pct(dpr(p)), cls(dpr(p))),
        statBox('Close', ago(p.closedAt)),
      ]),
  });
}

// ---------- panel detail posisi ----------

function tokRows(p, rows) {
  const [x, y] = pairTokens(p.pair);
  const sym = { x: p.symbolX || x, y: p.symbolY || y };
  const iconOf = { x: p.iconX, y: p.iconY };
  return ['x', 'y']
    .map(
      (k) => `<tr><td><div class="t"><span class="tokens">${tokImg(iconOf[k], sym[k])}</span><b>${esc(sym[k])}</b></div></td>
        ${rows.map((r) => `<td>${r(k)}</td>`).join('')}</tr>`,
    )
    .join('');
}

const STRATEGY_HEAD = `<h4><span>Strategi ${info(GLOSSARY.strategy)}</span></h4>`;
const BIN_HEAD = '<h4>Likuiditas per bin</h4>';

function openDrawer(p, kind) {
  const b = p.breakdown || {};
  const open = kind === 'open';
  const cur = b.current;
  const curTotal = cur ? cur.x.usd + cur.y.usd : 0;
  const share = (k) => (cur && curTotal > 0 ? `<span class="share">${((cur[k].usd / curTotal) * 100).toFixed(1)}%</span>` : '');
  const cell = (pair, k) => (pair ? `${amt(pair[k].amount)}<small>${usd(pair[k].usd)}</small>` : '–');

  const root = document.getElementById('modal-root');
  const returnFocus = document.activeElement;
  root.innerHTML = `<div class="drawer-backdrop" data-close></div>
  <aside class="drawer" role="dialog" aria-modal="true" aria-label="Detail posisi ${pairLabel(p)}">
    <div class="drawer-head">
      <span class="mono strong">${esc(short(p.position))}</span>
      <span class="badge ${open ? 'green' : 'gray'}">${open ? 'Open' : 'Closed'}</span>${protoBadge(p.protocol)}
      <span class="spacer"></span>
      <a class="btn sm" href="${links.pool(p.protocol, p.pool)}" target="_blank" rel="noopener">Meteora ${icon.ext}</a>
      <a class="btn sm" href="${links.account(p.position)}" target="_blank" rel="noopener">Solscan ${icon.ext}</a>
      <button class="btn sm icon ghost" data-close title="Tutup (Esc)" aria-label="Tutup panel">${ICON_CLOSE}</button>
    </div>
    <div class="drawer-body">
      <div class="pos-cell">${tokenIcons(p, 'lg')}<div><div class="pair-title">${pairLabel(p)}</div><div class="pos-sub">${esc(short(p.pool))} · pool</div></div></div>
      <div class="panel-grid">
        <div class="panel"><h4>PnL</h4><div class="kpi-value ${cls(p.pnlUsd)}">${usd(p.pnlUsd, true)} <small>(${pct(p.pnlPct)})</small></div>
          <div class="kpi-sub">${ok(p.pnlSol) ? sol(p.pnlSol, true) : ''}</div></div>
        <div class="panel"><h4>Umur</h4><div class="kpi-value">${duration(p.openedAt, p.closedAt)}</div>
          <div class="kpi-sub">Dibuka ${clock(p.openedAt)}${p.closedAt ? ` · ditutup ${clock(p.closedAt)}` : ''}</div></div>
      </div>
      <div class="panel" id="stratPanel">${STRATEGY_HEAD}<div class="muted"><span class="spinner"></span> Membaca transaksi add liquidity…</div></div>
      ${
        open && cur
          ? `<div class="panel"><h4>Likuiditas <span class="muted">${usd(curTotal)}</span></h4>
          <table class="tok-table"><thead><tr><th>Token</th><th>Saat ini</th></tr></thead><tbody>
          ${tokRows(p, [(k) => `${amt(cur[k].amount)}${share(k)}<small>${usd(cur[k].usd)}</small>`])}</tbody></table></div>`
          : ''
      }
      <div class="panel"><h4>Fee <span class="pos">${usd(totalFee(p))}</span></h4>
        <table class="tok-table"><thead><tr><th>Token</th>${open ? '<th>Belum diklaim</th>' : ''}<th>Diklaim</th></tr></thead><tbody>
        ${tokRows(p, [...(open ? [(k) => cell(b.unclaimed, k)] : []), (k) => cell(b.claimed, k)])}</tbody></table></div>
      ${p.protocol === 'dlmm' ? `<div class="panel" id="binPanel">${BIN_HEAD}<div class="muted"><span class="spinner"></span> Membaca bin dari chain…</div></div>` : ''}
      ${rangePanel(p, open)}
      <div class="panel"><h4>Deposit &amp; withdraw</h4>
        <table class="tok-table"><thead><tr><th>Token</th><th>Deposit</th><th>Withdraw</th></tr></thead><tbody>
        ${tokRows(p, [(k) => cell(b.deposits, k), (k) => cell(b.withdrawals, k)])}</tbody></table>
        <div class="item-meta mt-sm"><span>Total modal <b>${usd(p.depositUsd)}</b></span>${ok(p.withdrawUsd) ? `<span>Total withdraw <b>${usd(p.withdrawUsd)}</b></span>` : ''}
          <span>DPR <b class="${cls(dpr(p))}">${pct(dpr(p))}</b></span></div>
      </div>
      <div class="faint small">Posisi ${addrChip(p.position, true)}</div>
    </div>
  </aside>`;
  const close = () => {
    root.removeEventListener('close-overlay', onRouteClose);
    document.removeEventListener('keydown', onKey);
    root.innerHTML = '';
    if (returnFocus instanceof HTMLElement && returnFocus.isConnected) returnFocus.focus();
  };
  // Pindah halaman: closeOverlays() sudah mengosongkan root, cukup lepas listener.
  const onRouteClose = () => {
    root.removeEventListener('close-overlay', onRouteClose);
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => e.key === 'Escape' && close();
  document.addEventListener('keydown', onKey);
  root.addEventListener('close-overlay', onRouteClose);
  root.querySelectorAll('[data-close]').forEach((el) => el.addEventListener('click', close));
  root.querySelector('button[data-close]').focus();
  loadStrategy(root.querySelector('#stratPanel'), p);
  if (p.protocol === 'dlmm') loadBins(root.querySelector('#binPanel'), p);
}

/** Grafik likuiditas per bin: on-chain untuk posisi open, perkiraan dari transaksi add untuk yang closed. */
async function loadBins(el, p) {
  try {
    const d = await api(`/positions/${p.position}/bins${qs({ pool: p.pool })}`);
    if (!el.isConnected) return;
    el.innerHTML = `${BIN_HEAD}<div class="binchart"></div>`;
    renderBinChart(el.querySelector('.binchart'), d);
  } catch (err) {
    if (el.isConnected) el.innerHTML = `${BIN_HEAD}<div class="neg">${esc(err.message)}</div>`;
  }
}

function rangeStatus(p, open) {
  if (!open) return '<span class="faint">● Ditutup</span>';
  const t = rangePos(p.minPrice, p.maxPrice, p.poolPrice);
  if (t === undefined) return '<span class="faint">–</span>';
  if (t < 0) return '<span class="neg">● Keluar range · harga di bawah range</span>';
  if (t > 1) return '<span class="neg">● Keluar range · harga di atas range</span>';
  return '<span class="pos">● Dalam range</span>';
}

/** Panel range harga di drawer: bar range + rangkuman (min → max, range saat open, bin step, base fee, status). */
function rangePanel(p, open) {
  const head = '<h4>Range harga</h4>';
  if (p.fullRange) return `<div class="panel">${head}<div class="muted">Full range (0 → ∞) · likuiditas tersebar di semua harga.</div></div>`;
  if (!ok(p.minPrice) || !ok(p.maxPrice)) return `<div class="panel">${head}<div class="muted">Data range tidak tersedia.</div></div>`;
  const dlmm = p.protocol === 'dlmm';
  const width = rangeWidthText(rangeWidth(p.minPrice, p.maxPrice));
  const pending = '<span class="faint">…</span>';
  return `<div class="panel">${head}
    ${rangeMini(p, open ? 'now' : 'exit', { showBins: false })}
    <div class="info-grid">
      <span>Harga min → max</span><b class="mono">${price(p.minPrice)} → ${price(p.maxPrice)}</b>
      <span>Range saat open</span><b id="rgOpen">${dlmm ? pending : `lebar ${width}`}</b>
      ${dlmm ? `<span>Bin step ${info(GLOSSARY.binStep)}</span><b id="rgStep">${pending}</b><span>Base fee ${info(GLOSSARY.baseFee)}</span><b id="rgFee">${pending}</b>` : ''}
      <span>Status</span><b>${rangeStatus(p, open)}</b>
    </div></div>`;
}

/**
 * Strategi (badge + porsi %) dan sisi deposit saat open. Satu fetch sekaligus mengisi
 * bagian range harga yang butuh data pool (range saat open, bin step, base fee).
 */
async function loadStrategy(el, p) {
  const body = (html) => {
    // drawer bisa sudah ditutup / diganti posisi lain
    if (el.isConnected) el.innerHTML = `${STRATEGY_HEAD}${html}`;
  };
  const fill = (id, html) => {
    const t = document.getElementById(id);
    if (t) t.innerHTML = html;
  };
  const widthText = rangeWidthText(rangeWidth(p.minPrice, p.maxPrice));
  const width = widthText ? `lebar ${widthText}` : '–';
  try {
    const r = await api(`/positions/${p.position}/strategy${qs({ protocol: p.protocol, pool: p.protocol === 'dlmm' ? p.pool : undefined })}`);

    // Range harga: data dari pool & transaksi add pertama.
    fill('rgOpen', r.openRange ? openRangeText(r.openRange, r.openSide) : width);
    fill('rgStep', r.pool ? esc(r.pool.binStep) : '–');
    fill('rgFee', r.pool ? `${esc(r.pool.baseFeePct)}%` : '–');

    if (r.note) return body(`<div class="muted">${esc(r.note)}</div>`);
    if (!r.label) return body('<div class="muted">Strategi tidak bisa dibaca untuk posisi ini.</div>');
    const [x, y] = pairTokens(p.pair);
    const side = r.openSide ? `<span class="strat-sep"></span>${sideBadge(r.openSide, p.symbolX || x, p.symbolY || y)}` : '';
    body(`<div class="strat-head">${strategyBadge(r.label)}${side}</div>`);
  } catch (err) {
    fill('rgOpen', width);
    fill('rgStep', '–');
    fill('rgFee', '–');
    body(`<div class="neg">Strategi gagal dibaca: ${esc(err.message)}</div>`);
  }
}

// ================= AKTIVITAS =================

async function activityPage(token, presetWallet = '') {
  state.unread = 0;
  updateUnread();
  let kind = '';
  let wallet = '';
  mount(`
    <div class="page-head"><div><h1>Aktivitas</h1><p>Semua posisi yang dibuka &amp; ditutup oleh wallet yang dipantau · diperbarui live</p></div>
      <div class="toolbar">
        <select class="input" id="aWallet" aria-label="Filter wallet"><option value="">Semua wallet</option></select>
        <div class="chips" id="aKind" role="group" aria-label="Filter jenis aktivitas">
          <button class="chip active" data-k="" aria-pressed="true">Semua</button>
          <button class="chip" data-k="open" aria-pressed="false"><span class="chip-dot open"></span>Dibuka</button>
          <button class="chip" data-k="close" aria-pressed="false"><span class="chip-dot close"></span>Ditutup</button>
        </div>
      </div>
    </div>
    <div class="card"><div class="list" id="afeed">${skeleton(6)}</div>
      <div class="card-foot" id="aMore" hidden><button class="btn sm">Muat lebih lama</button></div></div>`);

  const feed = document.getElementById('afeed');
  const more = document.getElementById('aMore');
  const select = document.getElementById('aWallet');
  let lastId;
  let lastDay = '';
  let seq = 0;

  const withDays = (events) =>
    events
      .map((e) => {
        const d = dayLabel(e.created_at);
        const sep = d !== lastDay ? `<div class="day-sep">${d}</div>` : '';
        lastDay = d;
        return sep + eventItem(e, { withRange: true });
      })
      .join('');

  // Nomor urut permintaan: hasil filter lama yang datang terlambat tidak menimpa filter terbaru.
  const load = async (reset) => {
    const my = ++seq;
    if (reset) {
      lastId = undefined;
      lastDay = '';
      feed.innerHTML = skeleton(6);
      more.hidden = true;
    }
    const events = await api(`/events${qs({ limit: ACTIVITY_LIMIT, before: lastId, wallet, kind })}`);
    if (token !== live() || my !== seq) return;
    if (reset) feed.innerHTML = events.length ? '' : EMPTY_FEED();
    feed.insertAdjacentHTML('beforeend', withDays(events));
    lastId = events.at(-1)?.id;
    more.hidden = events.length < ACTIVITY_LIMIT;
  };
  const reload = () => guarded(token, () => load(true), feed);

  select.onchange = (e) => {
    wallet = e.target.value;
    reload();
  };
  document.getElementById('aKind').onclick = (e) => {
    const b = e.target.closest('[data-k]');
    if (!b) return;
    kind = b.dataset.k;
    document.querySelectorAll('#aKind .chip').forEach((c) => {
      c.classList.toggle('active', c === b);
      c.setAttribute('aria-pressed', String(c === b));
    });
    reload();
  };
  const moreBtn = more.querySelector('button');
  moreBtn.onclick = () => busy(moreBtn, () => guarded(token, () => load(false)));
  state.onAlert = (evs) => {
    const match = evs.filter((e) => (!wallet || e.wallet === wallet) && (!kind || e.kind === kind));
    if (!match.length) return;
    feed.querySelector('.empty')?.remove();
    const today = dayLabel(match[0].created_at);
    const firstSep = feed.querySelector('.day-sep');
    const html = match.map((e) => eventItem(e, { withRange: true, isNew: true })).join('');
    if (firstSep && firstSep.textContent === today) firstSep.insertAdjacentHTML('afterend', html);
    else feed.insertAdjacentHTML('afterbegin', `<div class="day-sep">${today}</div>${html}`);
    state.unread = 0;
    updateUnread();
  };

  const wallets = await loadWallets();
  if (token !== live()) return;
  wallet = wallets.some((w) => w.address === presetWallet) ? presetWallet : '';
  select.insertAdjacentHTML(
    'beforeend',
    wallets.map((w) => `<option value="${esc(w.address)}" ${w.address === wallet ? 'selected' : ''}>${esc(w.label)}</option>`).join(''),
  );
  reload();
}

// ================= LOGIN =================

function loginPage() {
  state.token++;
  closeOverlays();
  mount(`<div class="login"><form class="card" id="loginForm">
    <h1>Masuk</h1><p>Masukkan password dashboard.</p>
    <label class="sr-only" for="loginPwd">Password</label>
    <input class="input" id="loginPwd" type="password" name="password" placeholder="Password" autocomplete="current-password" autofocus required />
    <div class="field-error neg" id="loginErr" role="alert"></div>
    <button class="btn primary w-full">Masuk</button>
  </form></div>`);
  const form = document.getElementById('loginForm');
  form.onsubmit = (e) => {
    e.preventDefault();
    busy(form.querySelector('button'), async () => {
      try {
        await api('/login', { method: 'POST', body: { password: form.password.value } });
        document.getElementById('logoutBtn').hidden = false;
        connectStream();
        loadWallets();
        route();
      } catch (err) {
        document.getElementById('loginErr').textContent = err.message;
      }
    });
  };
}

// ================= LIVE: status & alert =================

let source;

function connectStream() {
  source?.close();
  source = new EventSource('/api/stream');
  source.addEventListener('status', (e) => {
    state.status = JSON.parse(e.data);
    renderLive();
  });
  source.addEventListener('alert', (e) => onAlert(JSON.parse(e.data)));
  source.addEventListener('track', (e) => onTrack(JSON.parse(e.data)));
  source.onerror = () => {
    const el = document.getElementById('live');
    el.className = 'live err';
    el.querySelector('.live-text').textContent = 'Terputus, menyambung ulang…';
  };
}

/** Progress Track Wallet: diteruskan ke halaman track; di halaman lain cukup toast saat butuh perhatian. */
function onTrack(job) {
  const prev = state.trackStatus;
  state.trackStatus = job?.status ?? null;
  if (state.onTrack) return state.onTrack(job);
  if (!job || prev === job.status) return;
  const goTrack = () => (location.hash = '#/track');
  if (job.status === 'awaiting_selection') {
    toast('🎯 Track Wallet', `${job.pools.length} pool ditemukan. Pilih pool untuk lanjut.`, '', goTrack);
  } else if (job.status === 'done' || job.status === 'error') {
    toast('🎯 Track Wallet', esc(job.message || 'Selesai'), job.status === 'error' ? 'error' : '', goTrack);
  }
}

function renderLive() {
  const s = state.status;
  const el = document.getElementById('live');
  if (!s) return;
  const errors = s.errors?.length || 0;
  el.className = `live ${errors ? 'err' : 'ok'}`;
  el.querySelector('.live-text').textContent = s.lastRunAt
    ? `Live · cek ${clock(s.lastRunAt / 1000, false)}${errors ? ` · ${errors} gagal` : ''}`
    : 'Live · memulai…';
  el.title = [
    `Cek setiap ${s.pollIntervalSec} detik · ${s.wallets} wallet`,
    s.lastRunAt ? `Cek terakhir ${clock(s.lastRunAt / 1000)} (${(s.lastRunMs / 1000).toFixed(1)} dtk)` : '',
    ...(s.errors || []).slice(0, 5),
  ]
    .filter(Boolean)
    .join('\n');
}

setInterval(renderLive, LIVE_REFRESH_MS);

/** Teks polos dari HTML (untuk notifikasi browser). DOMParser tidak menjalankan skrip / handler. */
const plainText = (html) => new DOMParser().parseFromString(html, 'text/html').body.textContent ?? '';

function openAlertBody(e) {
  const d = e.data ?? {};
  const [x, y] = pairTokens(e.pair);
  return [
    PROTO[e.protocol],
    d.strategy && esc(d.strategy),
    d.openSide && esc(sideLabel(d.openSide, d.symbolX || x, d.symbolY || y)),
    d.openRange && `range ${openRangeText(d.openRange, d.openSide)}`,
    `deposit ${usd(d.depositUsd)}`,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Judul & isi toast untuk event satu wallet: detail jika satu event, ringkasan jika lebih. */
function alertMessage(label, evs) {
  if (evs.length === 1) {
    const e = evs[0];
    const opened = e.kind === 'open';
    const pair = pairLabel({ ...e.data, pair: e.pair });
    return {
      title: `${opened ? '🟢' : '🔴'} ${esc(label)} ${opened ? 'membuka' : 'menutup'} ${pair}`,
      body: opened ? openAlertBody(e) : `${PROTO[e.protocol]} · PnL ${usd(e.data?.pnlUsd, true)} (${pct(e.data?.pnlPct)})`,
    };
  }
  const opened = evs.filter((e) => e.kind === 'open');
  const closed = evs.filter((e) => e.kind === 'close');
  return {
    title: `🔄 ${esc(label)}: ${opened.length} dibuka · ${closed.length} ditutup`,
    body: closed.length
      ? `Total PnL close ${usd(sum(closed, (e) => e.data?.pnlUsd), true)}`
      : evs
          .slice(0, 3)
          .map((e) => pairLabel({ ...e.data, pair: e.pair }))
          .join(', '),
  };
}

function onAlert(events) {
  if (!events?.length) return;
  if (!location.hash.startsWith('#/activity')) {
    state.unread += events.length;
    updateUnread();
  }
  state.onAlert?.(events);

  const byWallet = {};
  for (const e of events) (byWallet[e.label] ??= []).push(e);
  for (const [label, evs] of Object.entries(byWallet)) {
    const { title, body } = alertMessage(label, evs);
    const goPortfolio = () => (location.hash = `#/portfolio/${evs[0].wallet}`);
    const openedMore = evs.filter((e) => e.kind === 'open').length >= evs.length / 2;
    toast(title, body, openedMore ? 'open' : 'close', goPortfolio);
    if (state.notify && document.hidden && 'Notification' in window && Notification.permission === 'granted') {
      const n = new Notification(plainText(title), { body: plainText(body), tag: `mlp-${evs[0].id}` });
      n.onclick = () => {
        window.focus();
        goPortfolio();
      };
    }
  }
  if (state.notify) beep(events.some((e) => e.kind === 'open') ? 'open' : 'close');
}

let audioCtx;
function beep(kind) {
  try {
    audioCtx ??= new AudioContext();
    const tones = kind === 'open' ? [660, 880] : [660, 440];
    tones.forEach((f, i) => {
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.frequency.value = f;
      o.type = 'sine';
      const t = audioCtx.currentTime + i * 0.13;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.15, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
      o.connect(g).connect(audioCtx.destination);
      o.start(t);
      o.stop(t + 0.13);
    });
  } catch {
    /* audio tidak tersedia */
  }
}

function updateUnread() {
  const el = document.getElementById('unread');
  el.hidden = !state.unread;
  el.textContent = state.unread > 99 ? '99+' : String(state.unread);
  document.title = state.unread ? `(${state.unread}) ${APP_TITLE}` : APP_TITLE;
}

// ================= tombol topbar =================

const themeBtn = document.getElementById('themeBtn');
function renderTheme() {
  const light = document.documentElement.dataset.theme === 'light';
  themeBtn.innerHTML = light ? icon.moon : icon.sun;
  const label = light ? 'Ganti ke tema gelap' : 'Ganti ke tema terang';
  themeBtn.title = label;
  themeBtn.setAttribute('aria-label', label);
}
themeBtn.onclick = () => {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  document.documentElement.dataset.theme = next;
  storage.set('mlp-theme', next);
  renderTheme();
};
renderTheme();

const notifyBtn = document.getElementById('notifyBtn');
function renderNotify() {
  notifyBtn.innerHTML = state.notify ? icon.bell : icon.bellOff;
  notifyBtn.classList.toggle('on', state.notify);
  notifyBtn.setAttribute('aria-pressed', String(state.notify));
  const label = state.notify ? 'Suara & notifikasi alert: aktif (klik untuk mematikan)' : 'Suara & notifikasi alert: mati (klik untuk menyalakan)';
  notifyBtn.title = label;
  notifyBtn.setAttribute('aria-label', label);
}
notifyBtn.onclick = async () => {
  state.notify = !state.notify;
  storage.set('mlp-notify', state.notify ? '1' : '0');
  renderNotify();
  if (state.notify) {
    beep('open');
    if ('Notification' in window && Notification.permission === 'default') await Notification.requestPermission();
    const blocked = !('Notification' in window) || Notification.permission !== 'granted';
    toast('🔔 Alert dinyalakan', blocked ? 'Suara aktif. Notifikasi browser tidak tersedia (butuh izin / HTTPS).' : 'Suara & notifikasi browser aktif.');
  } else toast('🔕 Suara & notifikasi dimatikan', 'Alert tetap tampil di halaman.');
};
renderNotify();

document.getElementById('logoutBtn').onclick = async () => {
  await api('/logout', { method: 'POST' }).catch(() => {});
  source?.close();
  document.getElementById('logoutBtn').hidden = true;
  loginPage();
};

// salin alamat & baris tabel yang bisa diklik
document.addEventListener('click', (e) => {
  const copy = e.target.closest('[data-copy]');
  if (copy) {
    e.preventDefault();
    e.stopPropagation();
    copyText(copy.dataset.copy, '📋 Alamat disalin', `<span class="mono">${esc(short(copy.dataset.copy))}</span>`);
    return;
  }
  const row = e.target.closest('tr[data-href]');
  if (row && !e.target.closest('a,button')) location.hash = row.dataset.href;
});

window.addEventListener('auth-required', () => loginPage());

// ---------- daftar wallet & pencarian ----------

let knownWallets = [];

/** Ambil daftar wallet dipantau, perbarui saran pencarian, dan kembalikan daftarnya. */
async function loadWallets() {
  try {
    knownWallets = await api('/wallets');
    document.getElementById('walletOptions').innerHTML = knownWallets
      .map((w) => `<option value="${esc(w.label)}">${esc(short(w.address))}</option>`)
      .join('');
  } catch {
    /* belum login / server belum siap: pakai daftar terakhir */
  }
  return knownWallets;
}

const searchInput = document.getElementById('searchInput');
document.getElementById('searchForm').onsubmit = (e) => {
  e.preventDefault();
  const q = searchInput.value.trim();
  if (!q) return;
  const lower = q.toLowerCase();
  const hit =
    knownWallets.find((w) => w.address === q || w.label.toLowerCase() === lower) ||
    knownWallets.find((w) => w.label.toLowerCase().includes(lower));
  const address = hit?.address ?? (BASE58.test(q) ? q : '');
  if (!address) {
    toast('Wallet tidak ditemukan', 'Tempel alamat wallet Solana atau ketik nama wallet yang dipantau.', 'error');
    return;
  }
  searchInput.value = '';
  searchInput.blur();
  location.hash = `#/portfolio/${address}`;
};
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && !e.target.closest('input,textarea,select')) {
    e.preventDefault();
    searchInput.focus();
  }
});

// ================= router =================

function route() {
  const token = ++state.token;
  state.onAlert = null;
  state.onTrack = null;
  closeOverlays();
  const hash = location.hash || '#/';
  const [, page = '', a] = hash.split('/');
  const active = page === '' ? 'dashboard' : page === 'w' || page === 'portfolio' ? 'wallets' : page;
  document.querySelectorAll('[data-nav]').forEach((n) => {
    const on = n.dataset.nav === active;
    n.classList.toggle('active', on);
    if (on) n.setAttribute('aria-current', 'page');
    else n.removeAttribute('aria-current');
  });
  window.scrollTo(0, 0);
  if (page === 'wallets') return walletsPage(token);
  if (page === 'w' && a) {
    location.replace(`#/portfolio/${a}`);
    return;
  }
  if (page === 'portfolio' && a) return portfolioPage(token, a);
  if (page === 'activity') return activityPage(token, a);
  if (page === 'settings') return settingsPage({ token, live, mount, guarded });
  if (page === 'track') {
    return trackPage({
      token,
      live,
      mount,
      guarded,
      kpi,
      loadWallets,
      runId: a,
      setOnTrack: (fn) => (state.onTrack = fn),
    });
  }
  return dashboardPage(token);
}

window.addEventListener('hashchange', route);

(async function start() {
  try {
    const me = await api('/me');
    document.getElementById('logoutBtn').hidden = !me.authEnabled;
    if (me.authEnabled && !me.authenticated) return loginPage();
  } catch {
    // server belum siap; tetap coba render
  }
  connectStream();
  loadWallets();
  route();
})();
