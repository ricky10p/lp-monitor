// Angka dari API Meteora sering berupa string ("12.5") atau angka; helper di sini menyeragamkannya.

export type Num = string | number;

/** Angka dari API, atau undefined jika kosong / bukan angka. */
export function num(v: Num | null | undefined): number | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Seperti num(), tapi nilai kosong / tidak valid menjadi 0 (untuk penjumlahan). */
export const num0 = (v: Num | null | undefined) => num(v) ?? 0;

/** Kelompokkan item berdasarkan kunci, urutan item dalam tiap kelompok dipertahankan. */
export function groupBy<T>(items: T[], key: (item: T) => string) {
  const map = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    const list = map.get(k);
    if (list) list.push(it);
    else map.set(k, [it]);
  }
  return map;
}
