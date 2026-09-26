// Kelola daftar RPC Solana dari halaman Pengaturan: simpan di database, pasang ke pool failover.
import * as store from '../db.js';
import { maskRpcUrl, PUBLIC_RPC, rpcHealth, rpcHost, setRpcEndpoints } from '../api/rpcPool.js';
import { testRpc } from '../api/solana.js';

const MAX_RPC = 10;
const MAX_LABEL = 40;

export class SettingsError extends Error {}

/** Pasang daftar RPC dari database ke pool. Dipanggil saat start dan setiap daftar berubah. */
export function syncRpcPool() {
  setRpcEndpoints(store.listRpcEndpoints().map((e) => e.url));
}

/** Daftar RPC untuk browser: URL disamarkan (API key tidak pernah dikirim), plus status kesehatan. */
export function rpcListJson() {
  const list = store.listRpcEndpoints();
  return {
    usingPublicFallback: list.length === 0,
    publicRpc: PUBLIC_RPC,
    endpoints: list.map((e) => {
      const h = rpcHealth(e.url);
      return {
        id: e.id,
        label: e.label,
        host: rpcHost(e.url),
        url: maskRpcUrl(e.url),
        health: h ? { ok: h.ok, error: h.lastError ?? null, latencyMs: h.latencyMs ?? null, checkedAt: h.checkedAt, resting: h.cooldownUntil > Date.now() } : null,
      };
    }),
  };
}

function parseRpcUrl(raw: unknown) {
  const text = String(raw ?? '').trim();
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new SettingsError('URL RPC tidak valid. Contoh: https://mainnet.helius-rpc.com/?api-key=…');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new SettingsError('URL RPC harus diawali https:// atau http://');
  return url.toString();
}

/** Tambah RPC setelah dites merespons; RPC yang mati tidak disimpan. */
export async function addRpc(rawUrl: unknown, rawLabel: unknown) {
  const url = parseRpcUrl(rawUrl);
  const label = String(rawLabel ?? '').trim().slice(0, MAX_LABEL);
  if (store.rpcUrlExists(url)) throw new SettingsError('RPC ini sudah ada di daftar.');
  if (store.listRpcEndpoints().length >= MAX_RPC) throw new SettingsError(`Maksimal ${MAX_RPC} RPC.`);
  const test = await testRpc(url);
  if (!test.ok) throw new SettingsError(`RPC tidak merespons (${test.error}). Periksa URL / API key lalu coba lagi.`);
  store.addRpcEndpoint(url, label || rpcHost(url));
  syncRpcPool();
  return test;
}

export function removeRpc(id: number) {
  if (!store.removeRpcEndpoint(id)) throw new SettingsError('RPC tidak ditemukan.');
  syncRpcPool();
}

export function moveRpc(id: number, dir: -1 | 1) {
  if (!store.getRpcEndpoint(id)) throw new SettingsError('RPC tidak ditemukan.');
  store.moveRpcEndpoint(id, dir);
  syncRpcPool();
}

export async function testRpcById(id: number) {
  const e = store.getRpcEndpoint(id);
  if (!e) throw new SettingsError('RPC tidak ditemukan.');
  return testRpc(e.url);
}
