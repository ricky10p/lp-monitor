/**
 * Jalankan pekerjaan paralel dengan batas jumlah yang berjalan bersamaan.
 *
 * Modelnya worker pool yang bergulir, BUKAN batch: dengan limit 10, begitu SATU
 * pekerjaan selesai pekerjanya langsung menarik pekerjaan berikutnya, jadi jumlah
 * yang jalan bertahan di 10 sampai antrean habis.
 *
 * Hasil dikembalikan dalam URUTAN INPUT, bukan urutan selesai.
 * `shouldStop` dicek sebelum mengambil pekerjaan baru (dipakai untuk membatalkan job).
 */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
  shouldStop?: () => boolean,
): Promise<(R | undefined)[]> {
  const results: (R | undefined)[] = new Array(items.length);
  const workers = Math.max(1, Math.min(limit, items.length));
  let next = 0;

  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (next < items.length && !shouldStop?.()) {
        const index = next++;
        results[index] = await worker(items[index], index);
      }
    }),
  );
  return results;
}
