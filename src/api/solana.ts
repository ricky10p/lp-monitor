import { AxiosError } from 'axios';
import { http, sleep } from './http.js';
import { markRpcFailed, markRpcOk, rpcCandidates, rpcHost } from './rpcPool.js';

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// ---------- base58 (alamat & data instruksi Solana) ----------

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58Decode(s: string): Buffer {
  let n = 0n;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error('base58 tidak valid');
    n = n * 58n + BigInt(i);
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  const zeros = s.length - s.replace(/^1+/, '').length;
  return Buffer.concat([Buffer.alloc(zeros), n === 0n ? Buffer.alloc(0) : Buffer.from(hex, 'hex')]);
}

export function base58Encode(buf: Uint8Array): string {
  let n = BigInt(`0x${Buffer.from(buf).toString('hex') || '0'}`);
  let out = '';
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  let zeros = 0;
  while (zeros < buf.length && buf[zeros] === 0) zeros++;
  return '1'.repeat(zeros) + out;
}

interface RpcResponse<T> {
  result?: T;
  error?: { code: number; message: string };
}

/** Error dari node RPC (JSON-RPC `error`), mis. metode dinonaktifkan di RPC itu. */
class RpcNodeError extends Error {}

/** Alasan gagal yang aman ditampilkan — AxiosError apa adanya berisi URL + API key RPC. */
function failReason(err: unknown) {
  if (err instanceof AxiosError) {
    const status = err.response?.status;
    return status ? `HTTP ${status}` : (err.code ?? 'gangguan jaringan');
  }
  return err instanceof Error ? err.message : String(err);
}

/** Error jaringan, 429, dan 5xx: RPC-nya sedang bermasalah, layak dicoba ulang nanti. */
const isTransient = (err: unknown) => {
  const status = (err as AxiosError).response?.status;
  return err instanceof AxiosError && (!status || status === 429 || status >= 500);
};

/**
 * Panggil JSON-RPC Solana dengan failover: coba setiap RPC di Pengaturan sesuai urutan. Jika semua
 * gagal karena gangguan sementara, ulangi (maks `retries` putaran) dengan jeda yang makin panjang.
 */
async function rpc<T>(method: string, params: unknown[], retries = 2): Promise<T> {
  const failures: string[] = [];
  for (let round = 0; round <= retries; round++) {
    let transient = false;
    for (const url of rpcCandidates()) {
      const started = Date.now();
      try {
        const { data } = await http.post<RpcResponse<T>>(url, { jsonrpc: '2.0', id: 1, method, params });
        if (data.error) throw new RpcNodeError(data.error.message);
        markRpcOk(url, Date.now() - started);
        return data.result as T;
      } catch (err) {
        const reason = failReason(err);
        const rest = isTransient(err);
        transient ||= rest;
        // Error node (bukan jaringan) tidak membuat RPC diistirahatkan: bisa jadi hanya metode ini yang tidak didukung.
        markRpcFailed(url, reason, rest);
        failures.push(`${rpcHost(url)}: ${reason}`);
      }
    }
    if (!transient) break;
    if (round < retries) await sleep(1000 * 2 ** round);
  }
  throw new Error(`RPC Solana (${method}) gagal: ${[...new Set(failures)].slice(-3).join('; ')}`);
}

/** Cek satu RPC (untuk tombol "Tes" di Pengaturan): slot terbaru + waktu respons. */
export async function testRpc(url: string): Promise<{ ok: true; slot: number; latencyMs: number } | { ok: false; error: string }> {
  const started = Date.now();
  try {
    const { data } = await http.post<RpcResponse<number>>(url, { jsonrpc: '2.0', id: 1, method: 'getSlot', params: [] }, { timeout: 10_000 });
    if (data.error || typeof data.result !== 'number') throw new RpcNodeError(data.error?.message ?? 'respons tidak dikenali');
    const latencyMs = Date.now() - started;
    markRpcOk(url, latencyMs);
    return { ok: true, slot: data.result, latencyMs };
  } catch (err) {
    const error = failReason(err);
    markRpcFailed(url, error);
    return { ok: false, error };
  }
}

export interface RpcTransaction {
  blockTime: number | null;
  transaction: {
    signatures: string[];
    message: { accountKeys: string[]; instructions: RpcInstruction[] };
  };
  meta: {
    err: unknown;
    loadedAddresses?: { writable: string[]; readonly: string[] };
    innerInstructions?: { index: number; instructions: RpcInstruction[] }[];
  } | null;
}

export interface RpcInstruction {
  programIdIndex: number;
  accounts: number[];
  /** base58 */
  data: string;
}

/** `confirmed`: transaksi yang baru terjadi (belum finalized) tetap bisa dibaca — penting untuk alert open. */
export const getTransaction = (signature: string) =>
  rpc<RpcTransaction | null>('getTransaction', [
    signature,
    { encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'confirmed' },
  ]);

/** Data akun (base64 → Buffer), atau null jika akun tidak ada (mis. posisi sudah ditutup). */
export async function getAccountInfo(address: string): Promise<{ owner: string; data: Buffer } | null> {
  const res = await rpc<{ value: { owner: string; data: [string, string] } | null }>('getAccountInfo', [address, { encoding: 'base64' }]);
  return res.value ? { owner: res.value.owner, data: Buffer.from(res.value.data[0], 'base64') } : null;
}

type AccountFilter = { memcmp: { offset: number; bytes: string } } | { dataSize: number };

/** Akun milik `program` yang cocok dengan filter (memcmp / dataSize). */
export async function getProgramAccounts(program: string, filters: AccountFilter[]) {
  const res = await rpc<{ pubkey: string; account: { data: [string, string] } }[]>('getProgramAccounts', [
    program,
    { encoding: 'base64', filters },
  ]);
  return res.map((r) => ({ pubkey: r.pubkey, data: Buffer.from(r.account.data[0], 'base64') }));
}

/** Signature terbaru yang menyentuh `address` (terbaru dulu). */
export const getSignaturesForAddress = (address: string, limit = 50) =>
  rpc<{ signature: string; blockTime: number | null; err: unknown }[]>('getSignaturesForAddress', [
    address,
    { limit, commitment: 'confirmed' },
  ]);

interface TokenAccounts {
  value: { account: { data: { parsed: { info: { tokenAmount: { uiAmount: number | null } } } } } }[];
}

/** Saldo token (jumlah semua token account wallet untuk mint itu), dalam satuan token. */
async function getTokenBalance(wallet: string, mint: string) {
  const res = await rpc<TokenAccounts>('getTokenAccountsByOwner', [wallet, { mint }, { encoding: 'jsonParsed' }]);
  return res.value.reduce((sum, a) => sum + (a.account.data.parsed.info.tokenAmount.uiAmount ?? 0), 0);
}

export const getUsdcBalance = (wallet: string) => getTokenBalance(wallet, USDC_MINT);

/** Saldo SOL native di wallet (bukan di posisi LP), dalam SOL. */
export async function getSolBalance(wallet: string) {
  const res = await rpc<{ value: number }>('getBalance', [wallet]);
  return res.value / 1e9;
}
