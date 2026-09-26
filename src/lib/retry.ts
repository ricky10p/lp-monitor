// Satu mekanisme retry untuk semua klien HTTP (Meteora lewat axios, GMGN lewat curl).

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Dipanggil sebelum menunggu percobaan berikutnya (untuk log job Track Wallet). */
export type OnRetry = (message: string, attempt: number, delayMs: number) => void;

interface RetryOptions {
  /** Jumlah percobaan ulang setelah percobaan pertama. */
  retries: number;
  /** Error yang layak dicoba ulang (mis. jaringan, 429, 5xx). */
  isRetryable: (err: unknown) => boolean;
  /** Status HTTP dari error (untuk jeda 429 yang lebih panjang). */
  statusOf?: (err: unknown) => number | undefined;
  onRetry?: OnRetry;
}

/**
 * Jeda sebelum percobaan ke-`attempt` (mulai 1): 1s, 2s, 4s…; kena rate limit (429) menunggu
 * lebih lama — 5s × percobaan — supaya kuota API sempat pulih.
 */
const backoffMs = (attempt: number, status?: number) => (status === 429 ? 5000 * attempt : 1000 * 2 ** (attempt - 1));

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt > opts.retries || !opts.isRetryable(err)) throw err;
      const status = opts.statusOf?.(err);
      const delay = backoffMs(attempt, status);
      opts.onRetry?.(status ? `HTTP ${status}` : err instanceof Error ? err.message : String(err), attempt, delay);
      await sleep(delay);
    }
  }
}
