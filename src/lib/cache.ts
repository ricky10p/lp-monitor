/**
 * Cache hasil promise dengan masa berlaku (TTL) dan batas jumlah entri.
 *
 * - Permintaan yang sama selama TTL memakai promise yang sama (termasuk yang masih berjalan),
 *   jadi pindah halaman / klik berulang tidak memanggil API lagi.
 * - Promise yang gagal langsung dibuang dari cache supaya percobaan berikutnya mengambil ulang.
 * - Jika penuh, entri yang paling lama tidak dipakai dibuang (Map menjaga urutan sisip; entri
 *   yang dipakai dipindah ke belakang), sehingga memori tidak tumbuh tanpa batas.
 */
export class TtlCache {
  private entries = new Map<string, { expires: number; value: Promise<unknown> }>();

  constructor(
    private defaultTtlMs: number,
    private maxEntries: number,
  ) {}

  get<T>(key: string, load: () => Promise<T>, { fresh = false, ttlMs = this.defaultTtlMs } = {}): Promise<T> {
    const now = Date.now();
    const hit = this.entries.get(key);
    if (!fresh && hit && hit.expires > now) {
      this.entries.delete(key);
      this.entries.set(key, hit);
      return hit.value as Promise<T>;
    }
    const value = load();
    this.set(key, value, ttlMs);
    value.catch(() => {
      if (this.entries.get(key)?.value === value) this.entries.delete(key);
    });
    return value;
  }

  /** Simpan / ganti nilai, mis. untuk memperpanjang TTL hasil yang sudah pasti tidak berubah. */
  set(key: string, value: Promise<unknown>, ttlMs = this.defaultTtlMs) {
    this.entries.delete(key);
    this.entries.set(key, { expires: Date.now() + ttlMs, value });
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
  }

  delete(key: string) {
    this.entries.delete(key);
  }
}
