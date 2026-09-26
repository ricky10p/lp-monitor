import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { config } from '../config.js';
import * as store from '../db.js';

const COOKIE = 'mlp_session';
const SESSION_DAYS = 30;

const secret = crypto
  .createHash('sha256')
  .update(config.sessionSecret || `monitor-lp:${config.password}`)
  .digest();

const sign = (payload: string) => crypto.createHmac('sha256', secret).update(payload).digest('base64url');

const safeEqual = (a: string, b: string) => {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
};

function readCookie(req: Request, name: string) {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

export const authEnabled = () => !!config.password;

/**
 * Cookie = "<id sesi acak>.<tanda tangan HMAC>". Tanda tangan mencegah id ditebak/dipalsukan,
 * dan sesi juga harus ada di database — jadi logout (hapus sesi) benar-benar mencabut cookie itu.
 */
function sessionId(req: Request) {
  const token = readCookie(req, COOKIE);
  const [id, sig] = token?.split('.') ?? [];
  if (!id || !sig || !safeEqual(sig, sign(id))) return undefined;
  return id;
}

export function isAuthenticated(req: Request) {
  if (!authEnabled()) return true;
  const id = sessionId(req);
  return !!id && store.sessionValid(id);
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (isAuthenticated(req)) return next();
  res.status(401).json({ error: 'Perlu login' });
}

// Batasi percobaan login per IP.
const MAX_ATTEMPTS = 10;
const ATTEMPT_WINDOW_MS = 15 * 60_000;
const attempts = new Map<string, { count: number; reset: number }>();

/** Buang catatan percobaan yang sudah kedaluwarsa agar map tidak terus membesar. */
function pruneAttempts(now: number) {
  for (const [ip, a] of attempts) if (a.reset <= now) attempts.delete(ip);
}

export function login(req: Request, res: Response) {
  const ip = req.ip ?? 'unknown';
  const now = Date.now();
  pruneAttempts(now);
  const a = attempts.get(ip);
  if (a && a.count >= MAX_ATTEMPTS) {
    return res.status(429).json({ error: 'Terlalu banyak percobaan. Coba lagi dalam 15 menit.' });
  }
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!authEnabled() || !safeEqual(password, config.password)) {
    const entry = a ?? { count: 0, reset: now + ATTEMPT_WINDOW_MS };
    entry.count++;
    attempts.set(ip, entry);
    return res.status(401).json({ error: 'Password salah' });
  }
  attempts.delete(ip);
  store.pruneSessions();
  const id = crypto.randomBytes(24).toString('base64url');
  store.createSession(id, now + SESSION_DAYS * 86_400_000);
  const cookie = [
    `${COOKIE}=${encodeURIComponent(`${id}.${sign(id)}`)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${SESSION_DAYS * 86_400}`,
    ...(config.secureCookie ? ['Secure'] : []),
  ].join('; ');
  res.setHeader('Set-Cookie', cookie);
  res.json({ ok: true });
}

export function logout(req: Request, res: Response) {
  const id = sessionId(req);
  if (id) store.deleteSession(id);
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
  res.json({ ok: true });
}
