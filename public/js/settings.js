// Halaman Pengaturan: daftar RPC Solana (failover) dan notifikasi Telegram.

import { api } from './api.js';
import { ago, esc, int } from './fmt.js';
import { busy, emptyState, icon, modal, skeleton, toast } from './ui.js';

const ICON = {
  up: '<svg viewBox="0 0 24 24"><path d="M6 15l6-6 6 6"/></svg>',
  down: '<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>',
  pulse: '<svg viewBox="0 0 24 24"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>',
  send: '<svg viewBox="0 0 24 24"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>',
};

/**
 * @param {object} ctx { token, live(), mount(html), guarded(token, fn, target?) }
 */
export function settingsPage(ctx) {
  const { token, live, mount, guarded } = ctx;
  mount(`
    <div class="page-head"><div><h1>Pengaturan</h1><p>RPC Solana cadangan dan notifikasi alert ke Telegram</p></div></div>
    <div class="settings-grid" id="settingsGrid">
      <div class="card" id="rpcCard">${skeleton(5)}</div>
      <div class="card" id="tgCard">${skeleton(5)}</div>
    </div>`);

  guarded(
    token,
    async () => {
      const s = await api('/settings');
      if (token !== live()) return;
      renderRpc(document.getElementById('rpcCard'), s.rpc);
      renderTelegram(document.getElementById('tgCard'), s.telegram);
    },
    'settingsGrid',
  );
}

// ================= RPC =================

function healthBadge(h) {
  if (!h) return '<span class="status-dot" title="Belum dipakai sejak server dinyalakan"></span><span class="faint">Belum dicek</span>';
  const when = `dicek ${ago(h.checkedAt / 1000)}`;
  if (h.ok) return `<span class="status-dot ok"></span><span class="pos">Aktif</span><span class="faint">· ${int(h.latencyMs)} ms · ${when}</span>`;
  return `<span class="status-dot err"></span><span class="neg">Gagal: ${esc(h.error)}</span><span class="faint">· ${h.resting ? 'dilewati sementara · ' : ''}${when}</span>`;
}

function rpcRow(e, i, total) {
  return `<li class="rpc-row" data-id="${e.id}">
    <span class="rpc-rank" title="Urutan pemakaian">${i + 1}</span>
    <div class="min0 grow">
      <div class="rpc-name">${esc(e.label || e.host)}${i === 0 ? ' <span class="badge pos">Utama</span>' : ' <span class="badge gray">Cadangan</span>'}</div>
      <div class="rpc-url mono" title="API key disamarkan">${esc(e.url)}</div>
      <div class="rpc-health">${healthBadge(e.health)}</div>
    </div>
    <div class="rpc-actions">
      <button class="btn sm" data-act="test" title="Tes koneksi">${ICON.pulse}Tes</button>
      <button class="btn sm icon ghost" data-act="up" aria-label="Naikkan urutan" title="Naikkan urutan" ${i === 0 ? 'disabled' : ''}>${ICON.up}</button>
      <button class="btn sm icon ghost" data-act="down" aria-label="Turunkan urutan" title="Turunkan urutan" ${i === total - 1 ? 'disabled' : ''}>${ICON.down}</button>
      <button class="btn sm icon danger" data-act="delete" aria-label="Hapus RPC ${esc(e.label || e.host)}" title="Hapus">${icon.trash}</button>
    </div>
  </li>`;
}

function renderRpc(card, rpc) {
  const list = rpc.endpoints;
  card.innerHTML = `
    <div class="card-head"><div><h2>RPC Solana</h2>
      <div class="card-sub">Dipakai berurutan dari atas. Jika satu mati atau kena limit, otomatis pindah ke berikutnya.</div></div></div>
    ${
      list.length
        ? `<ol class="rpc-list">${list.map((e, i) => rpcRow(e, i, list.length)).join('')}</ol>`
        : `<div class="notice mx">⚠️ Belum ada RPC. Dashboard memakai RPC publik (<span class="mono">${esc(rpc.publicRpc)}</span>) yang cepat kena limit. Tambahkan minimal satu RPC, mis. Helius.</div>`
    }
    <form class="card-body rpc-add" id="rpcForm" autocomplete="off">
      <div class="label">Tambah RPC</div>
      <input class="input mono" name="url" type="url" placeholder="https://mainnet.helius-rpc.com/?api-key=…" aria-label="URL RPC" required />
      <div class="toolbar">
        <input class="input grow-1" name="label" maxlength="40" placeholder="Nama (opsional), mis. Helius utama" aria-label="Nama RPC" />
        <button class="btn primary" type="submit">${icon.plus}Tambah</button>
      </div>
      <small class="faint">RPC dites dulu sebelum disimpan. URL lengkap (termasuk API key) hanya disimpan di server.</small>
      <div class="field-error neg" id="rpcErr" role="alert"></div>
    </form>`;

  const form = card.querySelector('#rpcForm');
  form.onsubmit = (e) => {
    e.preventDefault();
    const err = card.querySelector('#rpcErr');
    err.textContent = '';
    busy(form.querySelector('button[type=submit]'), async () => {
      try {
        const res = await api('/settings/rpc', { method: 'POST', body: { url: form.url.value.trim(), label: form.label.value.trim() } });
        toast('✅ RPC ditambahkan', `Merespons dalam ${int(res.test.latencyMs)} ms`);
        renderRpc(card, res);
      } catch (ex) {
        err.textContent = ex.message;
      }
    });
  };

  card.querySelector('.rpc-list')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    const row = e.target.closest('[data-id]');
    if (!btn || !row || btn.disabled) return;
    const id = row.dataset.id;
    const e0 = list.find((x) => String(x.id) === id);
    const act = btn.dataset.act;
    if (act === 'delete') {
      const yes = await modal({
        title: 'Hapus RPC?',
        body: `<p class="mt0"><b>${esc(e0.label || e0.host)}</b> akan dihapus dari daftar.${list.length === 1 ? ' Setelah ini dashboard memakai RPC publik.' : ''}</p>`,
        confirmText: 'Ya, hapus',
        danger: true,
      });
      if (!yes) return;
    }
    await busy(btn, async () => {
      try {
        if (act === 'test') {
          const res = await api(`/settings/rpc/${id}/test`, { method: 'POST' });
          if (res.test.ok) toast('✅ RPC aktif', `${esc(e0.label || e0.host)} · ${int(res.test.latencyMs)} ms`);
          else toast('RPC gagal merespons', esc(res.test.error), 'error');
          renderRpc(card, res);
        } else if (act === 'delete') {
          renderRpc(card, await api(`/settings/rpc/${id}`, { method: 'DELETE' }));
          toast('🗑 RPC dihapus', esc(e0.label || e0.host));
        } else {
          renderRpc(card, await api(`/settings/rpc/${id}/move`, { method: 'POST', body: { dir: act } }));
        }
      } catch (ex) {
        toast('Gagal', esc(ex.message), 'error');
      }
    });
  });
}

// ================= Telegram =================

function renderTelegram(card, tg) {
  card.innerHTML = `
    <div class="card-head">
      <div><h2>Notifikasi Telegram</h2><div class="card-sub">Alert open/close posisi dikirim juga ke chat Telegram.</div></div>
      <label class="switch" title="Nyalakan / matikan notifikasi Telegram">
        <input type="checkbox" id="tgEnabled" ${tg.enabled ? 'checked' : ''} /><span class="track" aria-hidden="true"></span><span id="tgState">${tg.enabled ? 'Aktif' : 'Nonaktif'}</span>
      </label>
    </div>
    <form class="card-body tg-form" id="tgForm" autocomplete="off">
      <details class="tg-help" ${tg.hasToken ? '' : 'open'}>
        <summary>Cara menyambungkan bot</summary>
        <ol>
          <li>Buka <b>@BotFather</b> di Telegram, kirim <code>/newbot</code>, lalu salin token bot.</li>
          <li>Buka bot baru Anda dan kirim <code>/start</code> (untuk grup: tambahkan bot ke grup lalu kirim pesan di grup).</li>
          <li>Tempel token di bawah, klik <b>Deteksi</b> untuk mengisi chat ID, lalu <b>Simpan</b>.</li>
        </ol>
      </details>
      <label class="tfield"><span class="label">Token bot</span>
        <input class="input mono" name="botToken" type="password" autocomplete="off"
          placeholder="${tg.hasToken ? `Tersimpan (${esc(tg.tokenHint)}). Kosongkan jika tidak diganti` : '123456789:AAH…'}" />
      </label>
      <label class="tfield"><span class="label">Chat ID</span>
        <div class="toolbar nowrap-row">
          <input class="input mono grow" name="chatId" value="${esc(tg.chatId)}" placeholder="mis. 123456789 atau -100…" />
          <button class="btn" type="button" id="tgDetect">Deteksi</button>
        </div>
      </label>
      <div id="tgChats"></div>
      <div class="tg-kinds" role="group" aria-label="Jenis alert yang dikirim">
        <span class="label">Kirim alert</span>
        <label class="tcheck"><input type="checkbox" name="notifyOpen" ${tg.notifyOpen ? 'checked' : ''} /> Posisi dibuka</label>
        <label class="tcheck"><input type="checkbox" name="notifyClose" ${tg.notifyClose ? 'checked' : ''} /> Posisi ditutup</label>
      </div>
      <small class="faint">Alert mengikuti pengaturan per wallet: wallet/protokol yang alert-nya dimatikan tidak dikirim ke Telegram.</small>
      <div class="field-error neg" id="tgErr" role="alert"></div>
    </form>
    <div class="card-foot end">
      <button class="btn" id="tgTest" ${tg.hasToken && tg.chatId ? '' : 'disabled'}>${ICON.send}Kirim pesan tes</button>
      <button class="btn primary" id="tgSave">Simpan</button>
    </div>`;

  const form = card.querySelector('#tgForm');
  const err = card.querySelector('#tgErr');
  const values = () => ({
    botToken: form.botToken.value.trim(),
    chatId: form.chatId.value.trim(),
    notifyOpen: form.notifyOpen.checked,
    notifyClose: form.notifyClose.checked,
  });
  const save = async (extra = {}) => {
    err.textContent = '';
    const res = await api('/settings/telegram', { method: 'PUT', body: { ...values(), ...extra } });
    renderTelegram(card, res);
    return res;
  };

  form.onsubmit = (e) => e.preventDefault();
  const saveBtn = card.querySelector('#tgSave');
  saveBtn.onclick = () =>
    busy(saveBtn, async () => {
      try {
        await save();
        toast('✅ Pengaturan Telegram disimpan');
      } catch (ex) {
        err.textContent = ex.message;
      }
    });

  // Switch langsung menyimpan (beserta isian form), supaya on/off tidak perlu klik Simpan.
  const enabled = card.querySelector('#tgEnabled');
  enabled.onchange = async () => {
    enabled.disabled = true;
    try {
      const res = await save({ enabled: enabled.checked });
      toast(res.enabled ? '🔔 Notifikasi Telegram aktif' : '🔕 Notifikasi Telegram dimatikan');
    } catch (ex) {
      enabled.checked = !enabled.checked;
      enabled.disabled = false;
      err.textContent = ex.message;
    }
  };

  const testBtn = card.querySelector('#tgTest');
  testBtn.onclick = () =>
    busy(testBtn, async () => {
      try {
        await api('/settings/telegram/test', { method: 'POST' });
        toast('✅ Pesan tes terkirim', 'Cek chat Telegram Anda.');
      } catch (ex) {
        toast('Pesan tes gagal', esc(ex.message), 'error');
      }
    });

  const detectBtn = card.querySelector('#tgDetect');
  detectBtn.onclick = () =>
    busy(detectBtn, async () => {
      const box = card.querySelector('#tgChats');
      try {
        const { chats } = await api('/settings/telegram/chats', { method: 'POST', body: { botToken: form.botToken.value.trim() } });
        box.innerHTML = chats.length
          ? `<div class="chips">${chats.map((c) => `<button type="button" class="chip" data-chat="${esc(c.id)}">${esc(c.name)} <span class="faint mono">${esc(c.id)}</span></button>`).join('')}</div>
             <small class="faint">Pilih chat yang akan menerima alert.</small>`
          : emptyState('💬', 'Belum ada chat. Kirim /start ke bot Anda dulu, lalu klik Deteksi lagi.');
        box.onclick = (e) => {
          const chip = e.target.closest('[data-chat]');
          if (!chip) return;
          form.chatId.value = chip.dataset.chat;
          box.querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c === chip));
        };
      } catch (ex) {
        box.innerHTML = '';
        err.textContent = ex.message;
      }
    });
}
