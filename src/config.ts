import 'dotenv/config';

/** Baca angka dari env; nilai kosong / bukan angka memakai default, lalu dibatasi ke [min, max]. */
function envNumber(name: string, fallback: number, min = -Infinity, max = Infinity): number {
  const raw = process.env[name];
  const value = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  if (!Number.isFinite(value)) {
    if (raw !== undefined && raw.trim() !== '') console.warn(`[config] ${name}="${raw}" bukan angka, memakai ${fallback}`);
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(value)));
}

export const config = {
  port: envNumber('PORT', 3000, 1, 65535),
  /** 127.0.0.1 = hanya bisa dibuka dari PC ini. Di VPS pakai 0.0.0.0 + DASHBOARD_PASSWORD. */
  host: process.env.HOST || '127.0.0.1',
  /** Password login dashboard. Wajib jika HOST bukan localhost atau NODE_ENV=production. */
  password: process.env.DASHBOARD_PASSWORD || '',
  /** Kunci penandatangan cookie login (opsional; default diturunkan dari password). */
  sessionSecret: process.env.SESSION_SECRET || '',
  /** Set true jika dashboard diakses lewat HTTPS (cookie Secure). */
  secureCookie: process.env.SECURE_COOKIE === 'true',
  production: process.env.NODE_ENV === 'production',
  pollIntervalSec: envNumber('POLL_INTERVAL_SEC', 5, 5),
  /** Berapa wallet dicek bersamaan dalam satu siklus tracker. */
  trackerConcurrency: envNumber('TRACKER_CONCURRENCY', 4, 1, 16),
  closeConfirmPolls: envNumber('CLOSE_CONFIRM_POLLS', 3, 1),
  dbPath: process.env.DB_PATH || 'data/monitor.db',
  seedPath: process.env.SEED_PATH || 'wallets.seed.json',
  /** RPC Solana untuk membaca saldo token wallet (USDC). Public RPC cukup; ganti ke Helius/QuickNode jika sering 429. */
  solanaRpcUrl: process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
  /** Jumlah event open/close yang disimpan di database. */
  eventsKeep: 5000,
};

export const isLocalHost = (h: string) => ['127.0.0.1', 'localhost', '::1'].includes(h);
