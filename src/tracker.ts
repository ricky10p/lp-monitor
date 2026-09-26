import { config } from './config.js';
import * as store from './db.js';
import { describeError } from './api/http.js';
import { providers } from './providers/index.js';
import { mapLimit } from './lib/concurrent.js';
import type { PositionInfo, Provider } from './providers/types.js';

interface WalletEvents {
  wallet: store.Wallet;
  opened: PositionInfo[];
  closed: PositionInfo[];
}

type Notify = (events: WalletEvents) => Promise<void>;

function fallbackClosed(s: store.StoredPosition): PositionInfo {
  return {
    protocol: s.protocol,
    position: s.position,
    pool: s.pool,
    pair: s.pair,
    openedAt: s.opened_at ?? undefined,
    depositUsd: s.deposit_usd ?? undefined,
  };
}

export class Tracker {
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private busy = false;
  /** Wallet yang sedang dicek, agar tambah wallet & siklus tracker tidak mengecek wallet yang sama bersamaan. */
  private checking = new Set<string>();
  lastRunAt?: Date;
  lastRunMs = 0;
  lastErrors: string[] = [];

  constructor(
    private notify: Notify,
    /** Dipanggil setiap selesai satu siklus pengecekan semua wallet. */
    private onCycle?: () => void,
  ) {}

  start() {
    this.stopped = false;
    void this.loop();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  private async loop() {
    if (this.stopped) return;
    try {
      await this.runOnce();
    } catch (err) {
      // Error tak terduga (mis. database) tidak boleh menghentikan tracker selamanya.
      console.error('[tracker] siklus gagal:', err);
    }
    if (!this.stopped) this.timer = setTimeout(() => void this.loop(), config.pollIntervalSec * 1000);
  }

  async runOnce() {
    if (this.busy) return;
    this.busy = true;
    const started = Date.now();
    const errors: string[] = [];
    try {
      // Paralel terbatas supaya satu siklus banyak wallet tetap selesai dalam hitungan detik.
      const results = await mapLimit(store.listWallets(), config.trackerConcurrency, (wallet) => this.checkWallet(wallet));
      for (const r of results) errors.push(...(r ?? []));
    } finally {
      this.busy = false;
      this.lastRunAt = new Date();
      this.lastRunMs = Date.now() - started;
      this.lastErrors = errors;
      if (errors.length) console.warn(`[tracker] ${errors.length} gagal:`, errors.join(' | '));
      this.onCycle?.();
    }
  }

  /** Cek satu wallet. Mengembalikan daftar error (per provider). */
  async checkWallet(wallet: store.Wallet): Promise<string[]> {
    if (this.checking.has(wallet.address)) return [];
    this.checking.add(wallet.address);
    try {
      return await this.checkWalletOnce(wallet);
    } finally {
      this.checking.delete(wallet.address);
    }
  }

  private async checkWalletOnce(wallet: store.Wallet): Promise<string[]> {
    const errors: string[] = [];
    const events: WalletEvents = { wallet, opened: [], closed: [] };
    for (const provider of providers) await this.checkProvider(wallet, provider, events, errors);

    // Alert untuk protokol yang di-mute tetap dicatat di database posisi, hanya tidak dikirim.
    const muted = store.mutedSet(wallet);
    events.opened = events.opened.filter((p) => !muted.has(p.protocol));
    events.closed = events.closed.filter((p) => !muted.has(p.protocol));
    if (events.opened.length || events.closed.length) {
      try {
        await this.notify(events);
      } catch (err) {
        errors.push(`kirim alert ${wallet.label}: ${describeError(err)}`);
      }
    }
    return errors;
  }

  /** Bandingkan posisi open sekarang dengan snapshot tersimpan untuk satu protokol. */
  private async checkProvider(wallet: store.Wallet, provider: Provider, events: WalletEvents, errors: string[]) {
    const fail = (what: string, err: unknown) => errors.push(`${wallet.label}/${provider.id}${what}: ${describeError(err)}`);
    let current: PositionInfo[];
    try {
      current = await provider.getOpenPositions(wallet.address);
    } catch (err) {
      // API gagal: lewati siklus ini, jangan anggap posisi tertutup.
      return fail('', err);
    }

    // Pengecekan pertama wallet / protokol hanya menyimpan snapshot (tanpa alert).
    if (!store.hasBaseline(wallet.address, provider.id)) return store.saveBaseline(wallet.address, provider.id, current);

    const stored = store.getPositions(wallet.address, provider.id);
    const storedIds = new Set(stored.map((s) => s.position));
    const currentIds = new Set(current.map((c) => c.position));
    for (const s of stored) if (s.missing > 0 && currentIds.has(s.position)) store.setMissing(s, 0);

    const opened = current.filter((c) => !storedIds.has(c.position));
    if (opened.length) events.opened.push(...(await this.recordOpened(wallet, provider, opened, fail)));

    const missing = stored.filter((s) => !currentIds.has(s.position));
    if (missing.length) events.closed.push(...(await this.confirmClosed(wallet, provider, missing, fail)));
  }

  /** Lengkapi detail posisi baru (gagal → tetap pakai data dasar) lalu simpan ke snapshot. */
  private async recordOpened(wallet: store.Wallet, provider: Provider, opened: PositionInfo[], fail: Fail) {
    let enriched = opened;
    try {
      enriched = await provider.enrichOpened(wallet.address, opened);
    } catch (err) {
      fail(' detail posisi baru', err);
    }
    store.insertPositions(wallet.address, enriched);
    return enriched;
  }

  /**
   * Posisi yang hilang dari daftar open dianggap close jika data close-nya ditemukan, atau jika sudah
   * hilang `closeConfirmPolls` kali berturut-turut (data close belum tersedia di API).
   */
  private async confirmClosed(wallet: store.Wallet, provider: Provider, missing: store.StoredPosition[], fail: Fail) {
    let closedInfo = new Map<string, PositionInfo>();
    try {
      closedInfo = await provider.findClosed(wallet.address, missing);
    } catch (err) {
      fail(' data close', err);
    }
    const closed: PositionInfo[] = [];
    for (const s of missing) {
      const info = closedInfo.get(s.position);
      const attempts = s.missing + 1;
      if (info || attempts >= config.closeConfirmPolls) {
        store.deletePosition(s);
        closed.push(info ? { ...info, pair: info.pair || s.pair } : fallbackClosed(s));
      } else {
        store.setMissing(s, attempts);
      }
    }
    return closed;
  }
}

type Fail = (what: string, err: unknown) => void;
