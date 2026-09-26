// Helper kecil yang dipakai bersama oleh route HTTP.
import type { NextFunction, Request, Response } from 'express';

type Handler = (req: Request, res: Response) => Promise<unknown> | unknown;

/** Alamat Solana (wallet, posisi, pool, mint): base58, 32–44 karakter. */
export const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const isAddress = (v: unknown): v is string => typeof v === 'string' && BASE58.test(v);

export const MAX_LABEL = 40;
export const cleanLabel = (v: unknown) => String(v ?? '').trim().slice(0, MAX_LABEL);

/** `?fresh=1` = lewati cache (tombol muat ulang). */
export const fresh = (req: Request) => req.query.fresh === '1';

/** Teruskan error dari handler async ke error handler Express. */
export const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => Promise.resolve(fn(req, res)).catch(next);

/** ID numerik dari parameter URL; kirim 400 dan kembalikan undefined jika tidak valid. */
export function idParam(req: Request, res: Response) {
  const id = Number(req.params.id);
  if (Number.isInteger(id) && id > 0) return id;
  res.status(400).json({ error: 'ID tidak valid' });
  return undefined;
}
