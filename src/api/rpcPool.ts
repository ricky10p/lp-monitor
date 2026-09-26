/**
 * Kumpulan RPC Solana dengan failover.
 *
 * Daftar URL diatur dari halaman Pengaturan (disimpan di database, lihat services/settings.ts) dan
 * dipasang ke sini lewat setRpcEndpoints(). Setiap panggilan mencoba RPC sesuai urutan; RPC yang
 * baru gagal (jaringan, 429, 5xx) diistirahatkan sebentar dan dipindah ke belakang antrean.
 *
 * Modul ini sengaja tidak mengenal database agar lapisan api/ tetap bebas dari penyimpanan.
 */

/** RPC publik dipakai jika daftar di Pengaturan kosong. */
export const PUBLIC_RPC = 'https://api.mainnet-beta.solana.com';
/** Lama RPC yang gagal dilewati sebelum dicoba lagi sebagai pilihan utama. */
const COOLDOWN_MS = 30_000;

interface RpcHealth {
  ok: boolean;
  /** Alasan gagal terakhir (tanpa URL, aman ditampilkan). */
  lastError?: string;
  latencyMs?: number;
  checkedAt: number;
  cooldownUntil: number;
}

let endpoints: string[] = [];
const health = new Map<string, RpcHealth>();

export function setRpcEndpoints(urls: string[]) {
  endpoints = [...urls];
  for (const url of health.keys()) if (!urls.includes(url)) health.delete(url);
}

export const rpcHealth = (url: string) => health.get(url);

/** Urutan percobaan: sesuai prioritas, RPC yang sedang diistirahatkan dipindah ke belakang. */
export function rpcCandidates(): string[] {
  const list = endpoints.length ? endpoints : [PUBLIC_RPC];
  const now = Date.now();
  const resting = (url: string) => (health.get(url)?.cooldownUntil ?? 0) > now;
  return [...list.filter((u) => !resting(u)), ...list.filter(resting)];
}

export function markRpcOk(url: string, latencyMs: number) {
  health.set(url, { ok: true, latencyMs, checkedAt: Date.now(), cooldownUntil: 0 });
}

/** cooldown=false untuk error yang bukan salah RPC-nya (mis. metode tidak didukung) — tetap dicoba lain kali. */
export function markRpcFailed(url: string, reason: string, cooldown = true) {
  const now = Date.now();
  health.set(url, { ok: false, lastError: reason, checkedAt: now, cooldownUntil: cooldown ? now + COOLDOWN_MS : 0 });
}

/** Nama host RPC tanpa path/query, agar API key tidak ikut tampil di log atau browser. */
export function rpcHost(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return 'RPC';
  }
}

const maskToken = (v: string) => (v.length > 10 ? `${v.slice(0, 4)}…${v.slice(-4)}` : '•••');

/**
 * URL RPC dengan API key disamarkan, mis. https://mainnet.helius-rpc.com/?api-key=ab12…9xyz.
 * Nilai query dan potongan path yang panjang (token QuickNode dll.) dianggap rahasia.
 */
export function maskRpcUrl(url: string) {
  try {
    const u = new URL(url);
    const path = u.pathname
      .split('/')
      .map((seg) => (seg.length >= 16 ? maskToken(seg) : seg))
      .join('/');
    const query = [...u.searchParams].map(([k, v]) => `${k}=${maskToken(v)}`).join('&');
    return `${u.protocol}//${u.host}${path === '/' ? '/' : path}${query ? `?${query}` : ''}`;
  } catch {
    return '(URL tidak valid)';
  }
}
