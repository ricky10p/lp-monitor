/**
 * GET lewat curl + retry/backoff — khusus GMGN.
 *
 * PENTING — kenapa curl dan bukan fetch()/axios:
 *   1. GMGN membalas HTTP 403 untuk request dari Node (fingerprint TLS-nya ketahuan
 *      bukan browser). curl + User-Agent di bawah tembus 200.
 *   2. Header "accept: application/json" JUGA memicu 403. Jadi request di sini sengaja
 *      tidak mengirim header accept sama sekali.
 * Keduanya sudah diuji langsung. Jangan diganti tanpa mengetes ulang.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { withRetry, type OnRetry } from '../lib/retry.js';

const execFileAsync = promisify(execFile);

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
/** Percobaan ulang setelah gagal (total 3 percobaan). */
const RETRIES = 2;
const MAX_BUFFER = 64 * 1024 * 1024;

class HttpStatusError extends Error {
  constructor(public status: number) {
    super(`GMGN gagal merespons (HTTP ${status})`);
  }
}

class CurlMissingError extends Error {
  constructor() {
    super('curl tidak ditemukan di PATH — scan GMGN butuh curl (Ubuntu: sudo apt install curl).');
  }
}

async function httpGet(url: string) {
  const args = ['-s', '--compressed', '--max-time', '30', '-A', USER_AGENT, '-w', '\n%{http_code}', url];
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync('curl', args, { maxBuffer: MAX_BUFFER }));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new CurlMissingError();
    throw err;
  }
  const cut = stdout.lastIndexOf('\n');
  return { status: Number(stdout.slice(cut + 1).trim()), body: stdout.slice(0, cut) };
}

/** Apakah curl tersedia? Dipakai saat startup untuk memberi peringatan. */
export async function curlAvailable() {
  try {
    await execFileAsync('curl', ['--version']);
    return true;
  } catch {
    return false;
  }
}

/**
 * GET + parse JSON dengan retry bersama (lib/retry.ts): jeda 1s/2s, 429 → 5s × percobaan.
 * Semua error dicoba ulang (termasuk respons bukan JSON / ditolak `validate`) kecuali curl tidak terpasang.
 */
export function curlJson<T>(url: string, { validate, onRetry }: { validate?: (json: T) => void; onRetry?: OnRetry } = {}): Promise<T> {
  return withRetry(
    async () => {
      const { status, body } = await httpGet(url);
      if (status !== 200) throw new HttpStatusError(status);
      const json = JSON.parse(body) as T;
      validate?.(json);
      return json;
    },
    {
      retries: RETRIES,
      isRetryable: (err) => !(err instanceof CurlMissingError),
      statusOf: (err) => (err instanceof HttpStatusError ? err.status : undefined),
      onRetry,
    },
  );
}
