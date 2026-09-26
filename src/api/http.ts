import axios, { AxiosError } from 'axios';
import { withRetry, type OnRetry } from '../lib/retry.js';

export { sleep } from '../lib/retry.js';

export const http = axios.create({
  timeout: 20_000,
  headers: { Accept: 'application/json', 'User-Agent': 'monitor-lp-bot/1.0' },
});

/** Error jaringan, 429, dan 5xx layak dicoba ulang; 4xx lain (mis. 404) tidak. */
const isTransientHttp = (err: unknown) => {
  if (!(err instanceof AxiosError)) return false;
  const status = err.response?.status;
  return !status || status === 429 || status >= 500;
};

const httpStatus = (err: unknown) => (err instanceof AxiosError ? err.response?.status : undefined);

export interface GetOptions {
  /** Percobaan ulang setelah gagal (default 2). */
  retries?: number;
  onRetry?: OnRetry;
}

/** GET JSON dengan retry untuk error jaringan, 429 (jeda lebih lama), dan 5xx. */
export function getJson<T>(url: string, params?: Record<string, string | number | undefined>, opts: GetOptions = {}): Promise<T> {
  return withRetry(
    async () => (await http.get<T>(url, { params })).data,
    { retries: opts.retries ?? 2, isRetryable: isTransientHttp, statusOf: httpStatus, onRetry: opts.onRetry },
  );
}

const HTTP_REASONS: Record<number, string> = {
  400: 'permintaan ditolak',
  404: 'data tidak ditemukan',
  429: 'terlalu banyak permintaan (rate limit)',
};

const NETWORK_REASONS: Record<string, string> = {
  ECONNABORTED: 'waktu habis',
  ETIMEDOUT: 'waktu habis',
  ECONNRESET: 'koneksi terputus',
  ECONNREFUSED: 'koneksi ditolak',
  ENOTFOUND: 'server tidak ditemukan',
  ERR_NETWORK: 'gangguan jaringan',
};

/** Host sumber data (tanpa path/query agar alamat wallet & API key tidak ikut tampil). */
const hostOf = (url?: string) => {
  try {
    return url ? new URL(url).host : '';
  } catch {
    return '';
  }
};

/** Pesan error yang aman ditampilkan ke browser: sumber + alasan, tanpa URL lengkap. */
export function describeError(err: unknown): string {
  if (err instanceof AxiosError) {
    const status = err.response?.status;
    const reason = status
      ? `${HTTP_REASONS[status] ?? (status >= 500 ? 'server sedang bermasalah' : 'permintaan gagal')} (HTTP ${status})`
      : (NETWORK_REASONS[err.code ?? ''] ?? 'gangguan jaringan');
    const host = hostOf(err.config?.url);
    return host ? `${host}: ${reason}` : reason;
  }
  return err instanceof Error ? err.message : String(err);
}
