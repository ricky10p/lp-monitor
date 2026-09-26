// Halaman Track Wallet: cari wallet yang PnL / fee-nya cocok dengan kriteria di pool token tertentu.

import { api } from './api.js';
import { clock, cls, esc, int, short, sol, usd } from './fmt.js';
import { addrChip, BASE58, busy, copyText, emptyState, GLOSSARY, icon, info, links, modal, pnlText, skeleton, storage, toast } from './ui.js';

const FORM_KEY = 'mlp-track-form';
/** Log dianggap "sedang dibaca di bawah" jika jarak ke dasar kurang dari ini (px), jadi tetap auto-scroll. */
const LOG_STICK_PX = 40;

const STATUS = {
  scanning: ['warn', 'Tahap 1 · daftar wallet'],
  pools: ['warn', 'Tahap 2 · cari pool'],
  awaiting_selection: ['info', 'Menunggu pilihan pool'],
  matching: ['warn', 'Tahap 3 · cek posisi'],
  done: ['pos', 'Selesai'],
  cancelled: ['gray', 'Dihentikan'],
  error: ['neg', 'Gagal'],
};
const statusBadge = (s) => {
  const [c, t] = STATUS[s] ?? ['gray', s];
  return `<span class="badge ${c}">${esc(t)}</span>`;
};

const loadForm = () => {
  try {
    return JSON.parse(storage.get(FORM_KEY, '{}'));
  } catch {
    return {};
  }
};
const saveForm = (v) => storage.set(FORM_KEY, JSON.stringify(v));

/** Pair dari backend ("X/Y") ditampilkan seragam dengan halaman lain: "X / Y". */
const pairText = (pair) => esc(String(pair || '').split('/').join(' / '));

const fmtDate = (sec) => {
  if (!sec) return null;
  const d = new Date(sec * 1000);
  return `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;
};

/** Ringkasan kriteria (untuk riwayat run yang tidak membawa teks dari server). */
function criteriaText(c, mode) {
  const parts = [];
  for (const [key, tol, label, , , modes] of TARGET_FIELDS) {
    if (c[key] == null || !modes.split(' ').includes(mode)) continue;
    const name = label.replace(/^Target /, '').replace(/ (USD|SOL|%)$/, '');
    const unit = unitOf(label);
    const val = unit === 'USD' ? `$${c[key]}` : unit === '%' ? `${c[key]}%` : `${c[key]} SOL`;
    parts.push(`${name} ${val} ± ${c[tol]}`);
  }
  if (c.binStep != null) parts.push(`Bin step ${c.binStep}`);
  if (c.baseFee != null) parts.push(`Base fee ${c.baseFee}%`);
  if (c.rangeStart || c.rangeEnd) parts.push(`${fmtDate(c.rangeStart) ?? '…'} – ${fmtDate(c.rangeEnd) ?? 'sekarang'}`);
  return parts.join(' · ');
}

const MODE_NAMES = { pnl: 'PnL', pool: 'PnL per pool', fees: 'Fee' };
const modeLabel = (m) => esc(MODE_NAMES[m] ?? m);

// ================= halaman =================

/**
 * @param {object} ctx { token, live(), mount(html), guarded(token, fn, target?), kpi(), loadWallets(), setOnTrack(fn), runId }
 */
export async function trackPage(ctx) {
  if (ctx.runId) return runDetailPage(ctx);
  const { token, live, mount, guarded } = ctx;

  mount(`
    <div class="page-head">
      <div><h1>Track Wallet</h1><p>Cari wallet LP yang PnL / fee-nya cocok dengan kriteria di pool Meteora DLMM sebuah token</p></div>
    </div>
    <div class="card mb" id="tFormCard">${formHtml(loadForm())}</div>
    <div id="tJob"></div>
    <div class="card mt">
      <div class="card-head"><h2>Riwayat</h2></div>
      <div id="tRuns">${skeleton(3)}</div>
    </div>`);

  const form = document.getElementById('tForm');

  let tracked = new Set();
  let lastKey = '';
  const render = (job) => {
    if (token !== live()) return;
    setFormBusy(form, !!job?.active);
    // Bagian pilihan pool hanya digambar ulang saat status berubah supaya centang user tidak hilang.
    const key = job ? `${job.id}:${job.status}` : '';
    renderJob(ctx, job, tracked, key !== lastKey);
    if (key !== lastKey && job && !job.active) loadRuns(ctx);
    lastKey = key;
  };
  ctx.setOnTrack(render);
  bindForm(form, render);

  guarded(token, async () => {
    const [{ job }, wallets] = await Promise.all([api('/track'), ctx.loadWallets()]);
    if (token !== live()) return;
    tracked = new Set(wallets.map((w) => w.address));
    render(job);
  });
  loadRuns(ctx);
}

// ---------- form ----------

function field(label, input, hint = '') {
  return `<label class="tfield"><span class="label">${label}</span>${input}${hint ? `<small class="faint">${hint}</small>` : ''}</label>`;
}
const numInput = (name, v, ph = '', step = 'any') =>
  `<input class="input" type="number" step="${step}" name="${name}" value="${esc(v ?? '')}" placeholder="${ph}" />`;

const MODES = [
  ['pnl', MODE_NAMES.pnl, 'Cocokkan PnL tiap posisi'],
  ['pool', MODE_NAMES.pool, 'Cocokkan total wallet di satu pool: PnL, deposit, withdraw, fee'],
  ['fees', MODE_NAMES.fees, 'Cocokkan total fee & PnL wallet di satu pool (posisi open + closed)'],
];

/**
 * Kolom target: [nama target, nama toleransi, label, placeholder, toleransi default, mode yang memakai].
 * Semua boleh dikosongkan / diisi sebagian — yang diisi harus cocok semua.
 */
const TARGET_FIELDS = [
  ['targetProfitUsd', 'toleranceUsd', 'Target profit USD', 'mis. 254', 1, 'pnl pool fees'],
  ['targetProfitSol', 'toleranceSol', 'Target profit SOL', 'mis. 2.43', 0.1, 'pnl pool fees'],
  ['targetProfitPct', 'tolerancePct', 'Target profit %', 'mis. 24', 1, 'pnl pool'],
  ['targetDepositUsd', 'toleranceDepositUsd', 'Total deposit USD', 'mis. 7288', 1, 'pool'],
  ['targetDepositSol', 'toleranceDepositSol', 'Total deposit SOL', 'mis. 70', 0.1, 'pool'],
  ['targetWithdrawUsd', 'toleranceWithdrawUsd', 'Total withdraw USD', 'mis. 7183', 1, 'pool'],
  ['targetWithdrawSol', 'toleranceWithdrawSol', 'Total withdraw SOL', 'mis. 69', 0.1, 'pool'],
  ['targetFeeUsd', 'toleranceFeeUsd', 'Total fee USD', 'mis. 411', 1, 'pool fees'],
  ['targetFeeSol', 'toleranceFeeSol', 'Total fee SOL', 'mis. 3.9', 0.1, 'pool'],
];

const unitOf = (label) => (label.endsWith('SOL') ? 'SOL' : label.endsWith('%') ? '%' : 'USD');

function formHtml(v) {
  const mode = MODES.some(([m]) => m === v.mode) ? v.mode : 'pnl';
  const targets = TARGET_FIELDS.map(
    ([key, tol, label, ph, def, modes]) => `
        <div data-only="${modes}">${field(label, numInput(key, v[key], ph))}</div>
        <div data-only="${modes}">${field(`Toleransi ± ${unitOf(label)}`, numInput(tol, v[tol] ?? def, String(def)))}</div>`,
  ).join('');
  return `<form id="tForm" autocomplete="off">
    <div class="card-head"><h2>Kriteria</h2>
      <div class="chips" id="tMode" role="group" aria-label="Mode pencocokan">
        ${MODES.map(([m, name, title]) => `<button type="button" class="chip ${mode === m ? 'active' : ''}" data-mode="${m}" aria-pressed="${mode === m}" title="${esc(title)}">${name}</button>`).join('')}
      </div>
    </div>
    <div class="card-body">
      <div class="tgrid">
        <div class="tspan">${field('Alamat kontrak token (mint)', `<input class="input mono" name="contract" value="${esc(v.contract ?? '')}" placeholder="Alamat mint token…" required />`)}</div>
        ${targets}
        <div>${field(`Bin step ${info(GLOSSARY.binStep)}`, numInput('binStep', v.binStep, 'semua'))}</div>
        <div>${field(`Base fee (%) ${info(GLOSSARY.baseFee)}`, numInput('baseFee', v.baseFee, 'semua'))}</div>
        <div>${field('Tanggal mulai', `<input class="input" type="date" name="startDate" value="${esc(v.startDate ?? '')}" />`)}</div>
        <div>${field('Tanggal akhir', `<input class="input" type="date" name="endDate" value="${esc(v.endDate ?? '')}" />`)}</div>
        <div>${field('Konkurensi', numInput('concurrency', v.concurrency ?? 8, '8', '1'), '1–32 permintaan paralel ke API')}</div>
      </div>
      <p class="faint tnote">Semua target boleh dikosongkan, diisi salah satu, atau diisi semua. Yang diisi harus cocok semua.</p>
      <p class="faint tnote" data-only="pool">Mode PnL per pool: total semua posisi wallet di satu pool (deposit, withdraw, fee, PnL). Tanggal disaring lewat waktu close terakhir di pool itu.</p>
      <p class="faint tnote" data-only="fees">Mode Fee: fee & PnL semua posisi (open + closed) wallet di satu pool dijumlahkan. Jika tanggal diisi, posisi yang masih open ikut terbuang karena belum punya waktu close.</p>
      <label class="tcheck" id="tReuseWrap" hidden><input type="checkbox" name="reuseWallets" checked /> <span id="tReuseText"></span></label>
      <details class="tpaste" ${v.wallets ? 'open' : ''}>
        <summary>Tempel daftar wallet manual (lewati scan GMGN)</summary>
        <textarea class="input mono" name="wallets" rows="4" placeholder="Satu alamat per baris. Pakai ini jika scan GMGN diblokir dari server.">${esc(v.wallets ?? '')}</textarea>
      </details>
      <div class="field-error neg" id="tErr"></div>
    </div>
    <div class="card-foot end">
      <button class="btn primary" type="submit" id="tStart">${icon.play}Mulai tracking</button>
    </div>
  </form>`;
}

function applyMode(form, mode) {
  form.dataset.mode = mode;
  form.querySelectorAll('[data-only]').forEach((el) => {
    el.hidden = !el.dataset.only.split(' ').includes(mode);
  });
  form.querySelectorAll('#tMode .chip').forEach((c) => {
    c.classList.toggle('active', c.dataset.mode === mode);
    c.setAttribute('aria-pressed', String(c.dataset.mode === mode));
  });
}

/** Semua isian form (untuk localStorage) — termasuk kolom mode lain supaya tidak hilang saat ganti mode. */
function readForm(form) {
  const v = { mode: form.dataset.mode };
  for (const el of form.querySelectorAll('input[name],textarea[name]')) {
    if (el.type !== 'checkbox') v[el.name] = el.value.trim();
  }
  return v;
}

function setFormBusy(form, busy) {
  form.querySelectorAll('input,textarea,button').forEach((el) => (el.disabled = busy));
}

/** onStarted(job) dipanggil setelah job berhasil dibuat, agar tampilan langsung berpindah ke progress. */
function bindForm(form, onStarted) {
  const err = form.querySelector('#tErr');
  applyMode(form, form.querySelector('#tMode .chip.active')?.dataset.mode ?? 'pnl');
  form.querySelector('#tMode').onclick = (e) => {
    const b = e.target.closest('[data-mode]');
    if (b && !b.disabled) applyMode(form, b.dataset.mode);
  };

  // Info jumlah wallet tersimpan untuk contract ini (hasil scan / tempelan sebelumnya).
  const reuseWrap = form.querySelector('#tReuseWrap');
  let checkSeq = 0;
  const checkSaved = async () => {
    const contract = form.contract.value.trim();
    const seq = ++checkSeq;
    reuseWrap.hidden = true;
    if (!BASE58.test(contract)) return;
    try {
      const { count } = await api(`/track/wallets/${contract}`);
      if (seq !== checkSeq || !count) return;
      form.querySelector('#tReuseText').textContent = `Pakai ${int(count)} wallet tersimpan untuk token ini (hilangkan centang untuk scan ulang GMGN)`;
      reuseWrap.hidden = false;
    } catch {
      /* abaikan */
    }
  };
  form.contract.addEventListener('input', checkSaved);
  checkSaved();

  form.onsubmit = async (e) => {
    e.preventDefault();
    err.textContent = '';
    const v = readForm(form);
    if (!BASE58.test(v.contract)) {
      err.textContent = 'Alamat kontrak token tidak valid (base58, 32–44 karakter).';
      return;
    }
    saveForm(v);
    // Target yang disembunyikan mode ini tidak dikirim (tetap tersimpan di localStorage).
    const body = { ...v, reuseWallets: !reuseWrap.hidden && form.reuseWallets.checked };
    for (const [key, , , , , modes] of TARGET_FIELDS) if (!modes.split(' ').includes(v.mode)) body[key] = '';
    const btn = form.querySelector('#tStart');
    btn.disabled = true;
    try {
      const { job } = await api('/track', { method: 'POST', body });
      onStarted(job);
    } catch (ex) {
      err.textContent = ex.message;
      btn.disabled = false;
    }
  };
}

// ---------- job aktif ----------

function progressHtml(job) {
  const { done, total } = job.progress;
  const p = total ? Math.round((done / total) * 100) : 0;
  let what = '';
  if (job.status === 'scanning') what = job.gmgn ? `GMGN halaman ${int(job.gmgn.pages)} · ${int(job.gmgn.wallets)} wallet unik` : 'Menyiapkan daftar wallet…';
  else if (job.status === 'pools') what = `${int(done)} / ${int(total)} wallet dicek`;
  else if (job.status === 'matching') what = `${int(done)} / ${int(total)} kombinasi wallet+pool`;
  const bar = job.active && job.status !== 'scanning' && job.status !== 'awaiting_selection'
    ? `<div class="tbar" role="progressbar" aria-valuenow="${p}" aria-valuemin="0" aria-valuemax="100"><div style="width:${p}%"></div></div>`
    : job.status === 'scanning' ? '<div class="tbar indeterminate" role="progressbar"><div></div></div>' : '';
  return `${what ? `<div class="toolbar between"><span>${job.active ? '<span class="spinner"></span> ' : ''}${what}</span>${bar && total ? `<b>${p}%</b>` : ''}</div>` : ''}${bar}`;
}

function logHtml(job) {
  return job.log
    .map((l) => `<div class="tlog-${l.level}"><span class="faint">${clock(l.t / 1000, false)}</span> ${esc(l.msg)}</div>`)
    .join('');
}

function renderJob(ctx, job, tracked, statusChanged) {
  const root = document.getElementById('tJob');
  if (!root) return;
  if (!job) {
    root.innerHTML = '';
    return;
  }

  if (statusChanged || !root.querySelector('#tProg')) {
    root.innerHTML = `
      <div class="card mb">
        <div class="card-head">
          <h2>Proses #${esc(job.id)} ${statusBadge(job.status)}</h2>
          <div class="toolbar">
            ${job.active ? `<button class="btn sm danger" id="tCancel">${icon.stop}Hentikan</button>` : ''}
          </div>
        </div>
        <div class="card-body">
          <div class="tmeta">
            <span>Token ${addrChip(job.contract)}</span>
            <span>${modeLabel(job.mode)} · ${esc(job.criteriaText)}</span>
            <span>${esc(job.poolText)} · ${esc(job.dateText)}</span>
            ${job.walletCount ? `<span>${int(job.walletCount)} wallet${job.walletSource === 'pasted' ? ' (tempelan)' : job.walletSource === 'saved' ? ' (tersimpan)' : ''}</span>` : ''}
          </div>
          ${job.message ? `<div class="tmsg ${job.status === 'error' ? 'neg' : ''}">${esc(job.message)}</div>` : ''}
          <div id="tProg" aria-live="polite"></div>
          <details class="tlog-wrap" ${job.active ? 'open' : ''}><summary>Log proses</summary><div class="tlog" id="tLog"></div></details>
        </div>
      </div>
      <div id="tPools"></div>
      <div id="tResults"></div>`;
    const cancelBtn = root.querySelector('#tCancel');
    cancelBtn?.addEventListener('click', async () => {
      // Tombol tetap nonaktif sampai status baru datang lewat SSE (kartu digambar ulang).
      cancelBtn.disabled = true;
      cancelBtn.innerHTML = '<span class="spinner"></span> Menghentikan…';
      try {
        await api(`/track/${job.id}/cancel`, { method: 'POST' });
      } catch (ex) {
        toast('Gagal menghentikan', esc(ex.message), 'error');
        cancelBtn.disabled = false;
        cancelBtn.innerHTML = `${icon.stop}Hentikan`;
      }
    });
    renderPools(job);
  }

  document.getElementById('tProg').innerHTML = progressHtml(job);
  const logEl = document.getElementById('tLog');
  const atBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < LOG_STICK_PX;
  logEl.innerHTML = logHtml(job);
  if (atBottom || statusChanged) logEl.scrollTop = logEl.scrollHeight;

  renderResults(document.getElementById('tResults'), job, tracked, ctx);
}

function renderPools(job) {
  const el = document.getElementById('tPools');
  if (job.status !== 'awaiting_selection') {
    el.innerHTML = '';
    return;
  }
  el.innerHTML = `<div class="card mb">
    <div class="card-head"><h2>Pilih pool (${job.pools.length})</h2>
      <label class="tcheck"><input type="checkbox" id="tAll" /> Pilih semua</label></div>
    <div class="table-wrap"><table class="table">
      <thead><tr><th></th><th>Pool</th><th class="num">Bin step</th><th class="num">Base fee</th><th class="num">Wallet</th></tr></thead>
      <tbody>${job.pools
        .map(
          (p) => `<tr>
        <td class="col-check"><input type="checkbox" class="tpool" value="${esc(p.poolAddress)}" aria-label="Pilih pool ${esc(p.tokenX)} / ${esc(p.tokenY)}" /></td>
        <td><a class="link" href="${links.pool('dlmm', p.poolAddress)}" target="_blank" rel="noopener">${esc(p.tokenX)} / ${esc(p.tokenY)}</a>
          <div class="cell-sub mono">${esc(short(p.poolAddress))}</div></td>
        <td class="num">${esc(p.binStep)}</td><td class="num">${esc(p.baseFee)}%</td><td class="num">${int(p.walletCount)}</td></tr>`,
        )
        .join('')}</tbody></table></div>
    <div class="card-foot end">
      <span class="muted" id="tSelInfo" aria-live="polite">0 pool dipilih</span>
      <button class="btn primary" id="tGo" disabled>Lanjut cek posisi →</button>
    </div></div>`;

  const boxes = [...el.querySelectorAll('.tpool')];
  const go = el.querySelector('#tGo');
  const sync = () => {
    const picked = boxes.filter((b) => b.checked);
    const wallets = picked.reduce((a, b) => a + (job.pools.find((p) => p.poolAddress === b.value)?.walletCount || 0), 0);
    el.querySelector('#tSelInfo').textContent = `${picked.length} pool dipilih · ${int(wallets)} kombinasi wallet`;
    go.disabled = !picked.length;
    el.querySelector('#tAll').checked = picked.length === boxes.length;
  };
  boxes.forEach((b) => (b.onchange = sync));
  el.querySelector('#tAll').onchange = (e) => {
    boxes.forEach((b) => (b.checked = e.target.checked));
    sync();
  };
  go.onclick = async () => {
    go.disabled = true;
    const picked = boxes.filter((b) => b.checked).map((b) => b.value);
    try {
      await api(`/track/${job.id}/pools`, { method: 'POST', body: { pools: picked.length === boxes.length ? 'all' : picked } });
    } catch (ex) {
      toast('Gagal memulai cek posisi', esc(ex.message), 'error');
      go.disabled = false;
    }
  };
}

// ---------- hasil ----------

function renderResults(el, job, tracked, ctx) {
  if (!el) return;
  const s = job.stats;
  const hasStats = job.status === 'matching' || job.status === 'done' || job.status === 'cancelled' || job.matches.length;
  if (!hasStats) {
    el.innerHTML = '';
    return;
  }
  const matchWallets = new Set(job.matches.map((m) => m.wallet));
  el.innerHTML = `
    <div class="grid kpis">
      ${ctx.kpi('Wallet diproses', int(s.wallets))}
      ${ctx.kpi(job.mode === 'pool' ? 'Wallet+pool diperiksa' : 'Posisi diperiksa', int(s.checked), `${int(s.outOfRange)} di luar rentang · ${int(s.noData)} tanpa data`)}
      ${ctx.kpi(job.mode === 'pnl' ? 'Posisi cocok' : 'Kombinasi cocok', `<span class="${job.matches.length ? 'pos' : ''}">${int(job.matches.length)}</span>`)}
      ${ctx.kpi('Wallet cocok', int(matchWallets.size), s.failed ? `<span class="neg">${int(s.failed)} wallet gagal</span>` : '')}
    </div>
    ${resultsCard(job.mode, job.matches, tracked)}`;
  bindResults(el, job.mode, job.matches, tracked, ctx);
}

function resultsCard(mode, matches, tracked) {
  if (!matches.length) return `<div class="card">${emptyState('🔍', 'Belum ada wallet yang cocok.')}</div>`;
  const head = {
    fees: '<th>Wallet</th><th>Pool</th><th class="num">Total fee</th><th class="num">Total PnL</th><th class="num">Total PnL SOL</th><th class="num">Posisi</th><th></th>',
    pool: '<th>Wallet</th><th>Pool</th><th class="num">Deposit</th><th class="num">Withdraw</th><th class="num">Fee</th><th class="num">PnL</th><th class="num">PnL SOL</th><th></th>',
    pnl: '<th>Wallet</th><th>Pool</th><th>Posisi</th><th class="num">PnL</th><th class="num">PnL SOL</th><th class="num hide-sm">Ditutup</th><th></th>',
  }[mode];
  // USD utama, SOL di bawahnya.
  const both = (u, s) => `<div class="two-line"><span>${usd(u)}</span><small>${sol(s)}</small></div>`;
  const rows = matches
    .map((m) => {
      const wallet = `<td><a class="link mono" href="#/portfolio/${esc(m.wallet)}">${esc(short(m.wallet))}</a> ${addrChip(m.wallet)}</td>`;
      const pool = `<td><a class="link" href="${links.pool('dlmm', m.pool)}" target="_blank" rel="noopener">${m.pair ? pairText(m.pair) : esc(short(m.pool))}</a></td>`;
      const action = `<td class="num">${
        tracked.has(m.wallet)
          ? '<span class="badge pos">Dipantau</span>'
          : `<button class="btn sm outline-green nowrap" data-watch="${esc(m.wallet)}">${icon.plus} Tambahkan</button>`
      }</td>`;
      if (mode === 'pool') {
        return `<tr>${wallet}${pool}<td class="num">${both(m.depositUsd, m.depositSol)}</td><td class="num">${both(m.withdrawUsd, m.withdrawSol)}</td>
          <td class="num">${both(m.feeUsd, m.feeSol)}</td><td class="num">${pnlText(m.pnlUsd, m.pnlPct)}</td>
          <td class="num ${cls(m.pnlSol)}">${sol(m.pnlSol, true)}</td>${action}</tr>`;
      }
      if (mode === 'fees') {
        return `<tr>${wallet}${pool}<td class="num"><b>${usd(m.feesUsd)}</b></td><td class="num ${cls(m.pnlUsd)}">${usd(m.pnlUsd, true)}</td><td class="num ${cls(m.pnlSol)}">${sol(m.pnlSol, true)}</td><td class="num">${int(m.positions)}</td>${action}</tr>`;
      }
      return `<tr>${wallet}${pool}<td class="mono"><a class="link" href="${links.account(m.position)}" target="_blank" rel="noopener">${esc(short(m.position))}</a></td>
        <td class="num">${pnlText(m.pnlUsd, m.pnlPct)}</td><td class="num ${cls(m.pnlSol)}">${sol(m.pnlSol, true)}</td><td class="num hide-sm">${m.closedAt ? clock(m.closedAt) : '–'}</td>${action}</tr>`;
    })
    .join('');
  return `<div class="card">
    <div class="card-head"><h2>Hasil cocok</h2>
      <div class="toolbar">
        <button class="btn sm" data-res="copy">${icon.copy}Salin wallet</button>
        <button class="btn sm" data-res="json">${icon.download}Unduh JSON</button>
      </div></div>
    <div class="table-wrap"><table class="table"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div></div>`;
}

/** Format sama dengan wallet_cocok.json milik CLI lama. */
function groupedJson(mode, matches) {
  const key = mode === 'pnl' ? 'positions' : 'pools';
  const by = new Map();
  for (const m of matches) {
    if (!by.has(m.wallet)) by.set(m.wallet, new Set());
    by.get(m.wallet).add(mode === 'pnl' ? m.position : m.pool);
  }
  return [...by].map(([wallet, items]) => ({ wallet, [key]: [...items] }));
}

function bindResults(el, mode, matches, tracked, ctx) {
  el.querySelector('[data-res=copy]')?.addEventListener('click', () => {
    const wallets = [...new Set(matches.map((m) => m.wallet))];
    copyText(wallets.join('\n'), '📋 Wallet disalin', `${int(wallets.length)} alamat`);
  });
  el.querySelector('[data-res=json]')?.addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(groupedJson(mode, matches), null, 2) + '\n'], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'wallet_cocok.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  el.querySelectorAll('[data-watch]').forEach((b) =>
    b.addEventListener('click', async () => {
      const address = b.dataset.watch;
      // Wallet ditambahkan dari dalam validate, supaya error (nama sudah dipakai, dll.) tampil
      // langsung di modal dan user bisa memperbaiki namanya tanpa membuka ulang.
      const label = await modal({
        title: 'Tambahkan ke daftar wallet',
        body: `<p class="muted">Wallet <span class="mono">${esc(short(address))}</span> akan dipantau (alert open/close). Beri nama wallet ini:</p>`,
        input: { value: `Track ${address.slice(0, 4)}`, placeholder: 'Nama wallet' },
        confirmText: 'Tambahkan',
        validate: async (name) => {
          if (!name) return 'Nama wajib diisi.';
          try {
            await api('/wallets', { method: 'POST', body: { address, label: name } });
            return '';
          } catch (ex) {
            return ex.message;
          }
        },
      });
      if (!label) return;
      tracked.add(address);
      ctx.loadWallets();
      el.querySelectorAll(`[data-watch="${address}"]`).forEach((x) => (x.outerHTML = '<span class="badge pos">Dipantau</span>'));
      toast('✅ Wallet ditambahkan', `<b>${esc(label)}</b> sekarang dipantau.`);
    }),
  );
}

// ---------- riwayat ----------

async function loadRuns(ctx) {
  const { token, live, guarded } = ctx;
  const target = document.getElementById('tRuns');
  await guarded(token, async () => {
    const runs = await api('/track/runs');
    const el = document.getElementById('tRuns');
    if (token !== live() || !el) return;
    if (!runs.length) {
      el.innerHTML = emptyState('🗂️', 'Belum ada riwayat.');
      return;
    }
    el.innerHTML = `<div class="table-wrap"><table class="table">
      <thead><tr><th>#</th><th>Waktu</th><th>Token</th><th class="hide-sm">Kriteria</th><th>Status</th><th class="num">Cocok</th></tr></thead>
      <tbody>${runs
        .map(
          (r) => `<tr class="clickable" data-href="#/track/${esc(r.id)}" role="button" tabindex="0" aria-label="Buka proses #${esc(r.id)}">
        <td class="faint">${esc(r.id)}</td><td class="nowrap">${clock(r.createdAt)}</td>
        <td class="mono">${esc(short(r.contract))}</td>
        <td class="hide-sm muted">${modeLabel(r.mode)} · ${esc(criteriaText(r.criteria, r.mode))}</td>
        <td>${statusBadge(r.status)}</td><td class="num"><b>${int(r.matchCount)}</b></td></tr>`,
        )
        .join('')}</tbody></table></div>`;
  }, target);
}

async function runDetailPage(ctx) {
  const { token, live, mount, guarded, runId } = ctx;
  mount(`<div class="page-head"><div><h1>Track Wallet · Proses #${esc(runId)}</h1><p><a class="link" href="#/track">← Kembali ke Track Wallet</a></p></div></div>
    <div id="tDetail">${skeleton(4)}</div>`);
  guarded(token, async () => {
    const [run, wallets] = await Promise.all([api(`/track/runs/${encodeURIComponent(runId)}`), ctx.loadWallets()]);
    if (token !== live()) return;
    const tracked = new Set(wallets.map((w) => w.address));
    const el = document.getElementById('tDetail');
    const s = run.stats || {};
    el.innerHTML = `
      <div class="card mb"><div class="card-body tmeta">
        <span>${statusBadge(run.status)}</span>
        <span>Token ${addrChip(run.contract)}</span>
        <span>${modeLabel(run.mode)} · ${esc(criteriaText(run.criteria, run.mode))}</span>
        <span>${clock(run.createdAt)}${run.finishedAt ? ` → ${clock(run.finishedAt)}` : ''}</span>
        ${run.message ? `<span class="muted">${esc(run.message)}</span>` : ''}
        ${run.pools?.length ? `<span>Pool: ${run.pools.map((p) => `<a class="link" href="${links.pool('dlmm', p.poolAddress)}" target="_blank" rel="noopener">${esc(p.tokenX)} / ${esc(p.tokenY)} (bin step ${esc(p.binStep)})</a>`).join(', ')}</span>` : ''}
      </div></div>
      <div id="tRes"></div>`;
    renderResults(
      document.getElementById('tRes'),
      { mode: run.mode, status: run.status, matches: run.matches, stats: { wallets: 0, checked: 0, outOfRange: 0, noData: 0, failed: 0, ...s } },
      tracked,
      ctx,
    );
  }, 'tDetail');
}

