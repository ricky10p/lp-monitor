/**
 * GMGN — daftar wallet yang pernah REMOVE LIQUIDITY untuk sebuah token.
 *
 * Konfigurasi di bawah diambil dari URL browser. CLIENT_ID dan APP_VER ikut berubah
 * tiap GMGN deploy ulang web-nya; kalau suatu saat request ditolak (HTTP 403 /
 * code != 0), ambil nilai baru dari Network tab browser lalu ganti dua konstanta itu.
 * Kalau IP server (mis. VPS) diblokir, daftar wallet bisa ditempel manual di halaman Track Wallet.
 */
import { sleep, type OnRetry } from '../lib/retry.js';
import { curlJson } from './curl.js';

const API_BASE = 'https://gmgn.ai/vas/api/mul-region/token_trades_v2/sol';
const DEVICE_ID = '697054c2-a31d-4134-9b53-6905a50df7fa';
const TAB_ID = 'muaq5c0qvaov';
const FP_DID = '94e2f5897bcbc402b9204faad2706f0b';
const CLIENT_ID = 'gmgn_web_20260921-4720-f21d674';
const APP_VER = '20260921-4720-f21d674';

// API meng-cap di 50 item per halaman walaupun diminta lebih.
const PAGE_LIMIT = 50;
const DELAY_MS = 400;

interface GmgnResponse {
  code: number;
  message?: string;
  reason?: string;
  data?: { history?: { maker?: string }[]; next?: string };
}

function buildUrl(contract: string, cursor: string) {
  const qs = new URLSearchParams({
    event: 'remove',
    device_id: DEVICE_ID,
    tab_id: TAB_ID,
    fp_did: FP_DID,
    client_id: CLIENT_ID,
    from_app: 'gmgn',
    app_ver: APP_VER,
    tz_name: 'Asia_Jakarta',
    tz_offset: '25200',
    app_lang: 'id',
    os: 'web',
    worker: '0',
    limit: String(PAGE_LIMIT),
  });
  if (cursor) qs.set('cursor', cursor);
  return `${API_BASE}/${contract}?${qs}`;
}

async function fetchPage(contract: string, cursor: string, onRetry?: OnRetry) {
  const json = await curlJson<GmgnResponse>(buildUrl(contract, cursor), {
    onRetry,
    validate: (j) => {
      if (j.code !== 0) throw new Error(`GMGN menolak permintaan (kode ${j.code}): ${j.message || j.reason || 'tanpa keterangan'}`);
    },
  });
  return {
    history: Array.isArray(json.data?.history) ? json.data.history : [],
    next: json.data?.next || '',
  };
}

/**
 * Telusuri semua halaman sampai `next` kosong, kumpulkan field `maker`.
 * `wallets` di-pass dari luar supaya hasil parsial tetap kepegang kalau error / dibatalkan.
 */
export async function scanRemovers(
  contract: string,
  wallets: Set<string>,
  {
    onPage,
    onRetry,
    shouldStop,
  }: {
    onPage?: (p: { page: number; trades: number; added: number; total: number }) => void;
    onRetry?: OnRetry;
    shouldStop?: () => boolean;
  } = {},
) {
  let cursor = '';
  let page = 0;
  let trades = 0;

  while (!shouldStop?.()) {
    const before = wallets.size;
    const { history, next } = await fetchPage(contract, cursor, onRetry);
    for (const trade of history) if (trade?.maker) wallets.add(trade.maker);

    page += 1;
    trades += history.length;
    onPage?.({ page, trades: history.length, added: wallets.size - before, total: wallets.size });

    if (history.length === 0 || !next || next === cursor) break;
    cursor = next;
    await sleep(DELAY_MS);
  }
  return { pages: page, trades };
}
