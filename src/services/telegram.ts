// Notifikasi Telegram: kirim alert open/close posisi ke chat lewat bot. Pengaturan disimpan di database.
import { AxiosError } from 'axios';
import { http } from '../api/http.js';
import * as store from '../db.js';
import type { PositionInfo } from '../providers/types.js';
import { loadPoolMeta } from './bins.js';
import { SettingsError } from './rpcSettings.js';

interface TelegramSettings {
  enabled: boolean;
  botToken: string;
  chatId: string;
  notifyOpen: boolean;
  notifyClose: boolean;
}

const KEY = 'telegram';
const DEFAULTS: TelegramSettings = { enabled: false, botToken: '', chatId: '', notifyOpen: true, notifyClose: true };
/** Batas panjang satu pesan Telegram (4096) dengan sedikit ruang cadangan. */
const MAX_MESSAGE = 3900;
const TOKEN_RE = /^\d{5,}:[A-Za-z0-9_-]{30,}$/;
/** ID numerik (grup diawali "-") atau @username channel. */
const CHAT_RE = /^(-?\d{3,}|@[A-Za-z0-9_]{5,})$/;
const PROTO: Record<string, string> = { dlmm: 'DLMM', dammv2: 'DAMM V2' };

const getTelegram = (): TelegramSettings => ({ ...DEFAULTS, ...store.getSetting<Partial<TelegramSettings>>(KEY, {}) });

const maskToken = (t: string) => (t ? `${t.slice(0, 4)}…${t.slice(-4)}` : '');

/** Pengaturan untuk browser: token bot tidak pernah dikirim utuh. */
export function telegramJson() {
  const s = getTelegram();
  return { enabled: s.enabled, chatId: s.chatId, notifyOpen: s.notifyOpen, notifyClose: s.notifyClose, hasToken: !!s.botToken, tokenHint: maskToken(s.botToken) };
}

/** Simpan sebagian pengaturan. Token kosong / tidak dikirim = pakai token yang tersimpan. */
export function saveTelegram(body: Record<string, unknown>) {
  const cur = getTelegram();
  const next = { ...cur };
  if (typeof body.botToken === 'string' && body.botToken.trim()) {
    const token = body.botToken.trim();
    if (!TOKEN_RE.test(token)) throw new SettingsError('Format token bot tidak valid. Contoh: 123456789:AAH… (dari @BotFather).');
    next.botToken = token;
  }
  if (typeof body.chatId === 'string') {
    const chatId = body.chatId.trim();
    if (chatId && !CHAT_RE.test(chatId)) throw new SettingsError('Chat ID harus angka (grup diawali "-") atau @username channel.');
    next.chatId = chatId;
  }
  for (const k of ['enabled', 'notifyOpen', 'notifyClose'] as const) if (typeof body[k] === 'boolean') next[k] = body[k];
  if (next.enabled && (!next.botToken || !next.chatId)) {
    throw new SettingsError('Isi token bot dan chat ID dulu sebelum mengaktifkan notifikasi Telegram.');
  }
  store.setSetting(KEY, next);
  return telegramJson();
}

// ---------- API Telegram ----------

/** Panggil Bot API. Error dibuat ulang agar token (bagian dari URL) tidak ikut tercetak di log. */
async function callBot<T>(token: string, method: string, body: Record<string, unknown> = {}): Promise<T> {
  try {
    const { data } = await http.post<{ ok: boolean; result: T; description?: string }>(`https://api.telegram.org/bot${token}/${method}`, body, {
      timeout: 15_000,
    });
    return data.result;
  } catch (err) {
    const res = err instanceof AxiosError ? (err.response?.data as { description?: string } | undefined) : undefined;
    const status = err instanceof AxiosError ? err.response?.status : undefined;
    const reason =
      status === 401 ? 'token bot salah' : status === 400 && res?.description?.includes('chat not found') ? 'chat ID tidak ditemukan (sudah kirim /start ke bot?)' : res?.description;
    throw new Error(`Telegram: ${reason ?? (err instanceof AxiosError ? (err.code ?? 'gangguan jaringan') : String(err))}`);
  }
}

async function sendText(s: TelegramSettings, text: string) {
  await callBot(s.botToken, 'sendMessage', { chat_id: s.chatId, text, parse_mode: 'HTML', disable_web_page_preview: true });
}

export async function sendTelegramTest() {
  const s = getTelegram();
  if (!s.botToken || !s.chatId) throw new SettingsError('Isi dan simpan token bot serta chat ID terlebih dahulu.');
  const sample: store.EventRecord = {
    id: 0,
    wallet: 'AlamatWalletContoh1111111111111111111111111',
    label: 'Contoh wallet',
    kind: 'open',
    protocol: 'dlmm',
    position: 'CONTOH',
    pool: 'CONTOH',
    pair: 'TOKEN-SOL',
    created_at: 0,
    data: {
      protocol: 'dlmm',
      position: 'CONTOH',
      pool: 'CONTOH',
      pair: 'TOKEN-SOL',
      depositUsd: 500,
      depositSol: 2.5,
      strategy: 'Spot',
      openSide: 'y',
      bins: 69,
      openRange: { bins: 69, minPct: -49.67, maxPct: 0, binStep: 100 },
    },
  };
  await sendText(
    s,
    `✅ <b>Meteora LP Monitor tersambung</b>\nAlert open/close posisi akan dikirim ke sini. Contoh tampilannya:\n\n${eventText(sample, '100/2', false)}`,
  );
}

/**
 * Chat yang baru mengirim pesan ke bot (dari getUpdates), untuk mengisi chat ID otomatis.
 * Token boleh dari isian form (belum disimpan) atau yang tersimpan.
 */
export async function detectChats(tokenInput?: unknown) {
  const token = typeof tokenInput === 'string' && tokenInput.trim() ? tokenInput.trim() : getTelegram().botToken;
  if (!token) throw new SettingsError('Isi token bot terlebih dahulu.');
  if (!TOKEN_RE.test(token)) throw new SettingsError('Format token bot tidak valid.');
  type Chat = { id: number; type: string; title?: string; username?: string; first_name?: string };
  const updates = await callBot<{ message?: { chat: Chat }; channel_post?: { chat: Chat }; my_chat_member?: { chat: Chat } }[]>(token, 'getUpdates', {
    limit: 50,
  });
  const chats = new Map<number, { id: string; name: string; type: string }>();
  for (const u of updates) {
    const c = u.message?.chat ?? u.channel_post?.chat ?? u.my_chat_member?.chat;
    if (c) chats.set(c.id, { id: String(c.id), name: c.title ?? (c.username ? `@${c.username}` : (c.first_name ?? String(c.id))), type: c.type });
  }
  return [...chats.values()];
}

// ---------- format pesan alert ----------

const esc = (s: unknown) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const sign = (v: number, plus: boolean) => (v < 0 ? '−' : plus && v > 0 ? '+' : '');
const usd = (v: unknown, plus = false) =>
  fin(v) ? `${sign(v, plus)}$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '–';
const pct = (v: unknown) => (fin(v) ? `${sign(v, true)}${Math.abs(v).toFixed(2)}%` : '–');
/** Jumlah SOL dengan desimal secukupnya (angka kecil tetap terlihat, mis. 0.0042 SOL); '' jika tidak ada / nol. */
function sol(v: unknown, plus = false) {
  if (!fin(v)) return '';
  const a = Math.abs(v);
  const digits = a >= 1 ? 2 : a >= 0.01 ? 3 : 4;
  const text = a.toLocaleString('en-US', { maximumFractionDigits: digits });
  return text === '0' ? '' : `${sign(v, plus)}${text} SOL`;
}

function duration(from?: number, to?: number) {
  if (!from) return '';
  const s = Math.max(0, (to ?? Date.now() / 1000) - from);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d ? `${d} hari ${h} jam` : h ? `${h} jam ${m} mnt` : m ? `${m} mnt` : '< 1 mnt';
}

function pairOf(e: store.EventRecord) {
  const [x, y] = e.pair.split('-');
  return `${e.data.symbolX || x || '?'} / ${e.data.symbolY || y || '?'}`;
}

function sideText(p: PositionInfo, x: string, y: string) {
  if (p.openSide === 'x') return `Single side ${x}`;
  if (p.openSide === 'y') return `Single side ${y}`;
  if (p.openSide === 'both') return `Double side ${x} + ${y}`;
  return '';
}

/** Range saat open mengikuti sisi deposit (sama dengan tampilan dashboard). */
function openRangeText(p: PositionInfo) {
  const r = p.openRange;
  if (!r) return '';
  const lo = p.openSide ? p.openSide !== 'x' : Math.abs(r.minPct) > 0.005;
  const hi = p.openSide ? p.openSide !== 'y' : Math.abs(r.maxPct) > 0.005;
  return lo && hi ? `${pct(r.minPct)} / ${pct(r.maxPct)}` : hi ? pct(r.maxPct) : pct(r.minPct);
}

const DIVIDER = '━━━━━━━━━━━━━━';

/** Persen fee ringkas: 2 → "2", 0.25 → "0.25". */
const feeText = (v: number) => String(Number(v.toFixed(4)));

/**
 * Tag pool: DLMM → "100/2" (bin step / base fee %), DAMM V2 → "fee 2%".
 * Metadata DLMM diambil dari cache pool (bins.ts); gagal dibaca → bin step dari range saat open, tanpa fee.
 */
async function poolTag(e: store.EventRecord): Promise<string> {
  if (e.protocol !== 'dlmm') return fin(e.data.baseFeePct) ? `fee ${feeText(e.data.baseFeePct)}%` : '';
  try {
    const m = await loadPoolMeta(e.pool);
    return `${m.binStep}/${feeText(m.baseFeePct)}`;
  } catch {
    return e.data.openRange ? `bin step ${e.data.openRange.binStep}` : '';
  }
}

/** Satu baris "emoji Label: nilai"; kosong jika nilainya tidak ada. */
const row = (emoji: string, label: string, value: string) => (value ? `${emoji} ${label}: ${value}` : '');

function openRows(p: PositionInfo, x: string, y: string) {
  const deposit = fin(p.depositUsd) ? `<b>${usd(p.depositUsd)}</b>${fin(p.depositSol) ? ` (${sol(p.depositSol)})` : ''}` : '';
  const strategy = [p.strategy, sideText(p, x, y)].filter(Boolean).map(esc).join(' · ');
  const range = p.fullRange ? 'Full range' : [openRangeText(p), p.bins ? `${p.bins} bin` : ''].filter(Boolean).join(' · ');
  return [row('💵', 'Deposit', deposit), row('🎯', 'Strategi', strategy), row('📏', 'Range', range)];
}

function closeRows(p: PositionInfo) {
  const profit = fin(p.pnlUsd) && p.pnlUsd >= 0;
  const pnl = fin(p.pnlUsd)
    ? `<b>${usd(p.pnlUsd, true)}</b> (${pct(p.pnlPct)})${sol(p.pnlSol, true) ? ` · ${sol(p.pnlSol, true)}` : ''}`
    : 'belum tersedia';
  return [
    row(profit ? '📈' : '📉', 'PnL', pnl),
    row('💰', 'Fee', fin(p.feesUsd) ? usd(p.feesUsd) : ''),
    row('💵', 'Modal', fin(p.depositUsd) ? usd(p.depositUsd) : ''),
    row('⏱', 'Durasi', esc(duration(p.openedAt, p.closedAt))),
  ];
}

/**
 * Kartu alert satu posisi, mis.:
 *   🟢 POSISI DIBUKA
 *   👛 Friday · 3j6EKRQb…9AGNM (alamat lengkap, ketuk untuk menyalin)
 *   🪙 ETCH / SOL · DLMM 100/2
 *   ━━━━━━━━━━━━━━
 *   💵 Deposit: $648.56 (5.21 SOL)
 *   🎯 Strategi: Spot · Double side ETCH + SOL
 *   📏 Range: −49.67% / +98.07% · 72 bin
 *   ━━━━━━━━━━━━━━
 *   🔗 Meteora | Posisi | Wallet
 */
function eventText(e: store.EventRecord, tag: string, withLinks = true) {
  const p = e.data;
  const open = e.kind === 'open';
  const pair = pairOf(e);
  const [x, y] = pair.split(' / ');
  const pool = `https://app.meteora.ag/${e.protocol === 'dlmm' ? 'dlmm' : 'dammv2'}/${e.pool}`;
  return [
    open ? '🟢 <b>POSISI DIBUKA</b>' : '🔴 <b>POSISI DITUTUP</b>',
    // <code> = di Telegram cukup diketuk sekali untuk menyalin alamat wallet.
    `👛 <b>${esc(e.label)}</b> · <code>${esc(e.wallet)}</code>`,
    `🪙 <b>${esc(pair)}</b> · ${PROTO[e.protocol] ?? esc(e.protocol)}${tag ? ` <b>${esc(tag)}</b>` : ''}`,
    DIVIDER,
    ...(open ? openRows(p, x, y) : closeRows(p)),
    withLinks ? DIVIDER : '',
    withLinks
      ? `🔗 <a href="${pool}">Meteora</a> | <a href="https://solscan.io/account/${e.position}">Posisi</a> | <a href="https://solscan.io/account/${e.wallet}">Wallet</a>`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Gabungkan beberapa blok teks jadi pesan-pesan yang muat batas panjang Telegram. */
function chunk(blocks: string[]) {
  const out: string[] = [];
  let cur = '';
  for (const b of blocks) {
    if (cur && cur.length + b.length + 2 > MAX_MESSAGE) {
      out.push(cur);
      cur = '';
    }
    cur = cur ? `${cur}\n\n${b}` : b;
  }
  if (cur) out.push(cur);
  return out;
}

/** Kirim alert ke Telegram jika aktif. Tidak pernah melempar error (alert di dashboard tetap jalan). */
export async function notifyTelegram(events: store.EventRecord[]) {
  const s = getTelegram();
  if (!s.enabled || !s.botToken || !s.chatId) return;
  const picked = events.filter((e) => (e.kind === 'open' ? s.notifyOpen : s.notifyClose));
  const tags = await Promise.all(picked.map(poolTag));
  for (const text of chunk(picked.map((e, i) => eventText(e, tags[i])))) {
    try {
      await sendText(s, text);
    } catch (err) {
      console.warn('[telegram]', (err as Error).message);
      return;
    }
  }
}
