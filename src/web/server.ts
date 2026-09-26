// Server HTTP: keamanan dasar, login, route API per domain, file frontend, dan error handler global.
import express, { type NextFunction, type Request, type Response } from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeError } from '../api/http.js';
import type { Tracker } from '../tracker.js';
import { authEnabled, isAuthenticated, login, logout, requireAuth } from './auth.js';
import { registerPortfolioRoutes } from './portfolioRoutes.js';
import { registerSettingsRoutes } from './settingsRoutes.js';
import { registerStream } from './sse.js';
import { registerTrackRoutes } from './trackRoutes.js';
import { registerWalletRoutes } from './walletRoutes.js';

export { broadcast, statusJson } from './sse.js';

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public');

function securityHeaders(_req: Request, res: Response, next: NextFunction) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
}

function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  // Error dari express.json: body bukan JSON valid (400) atau terlalu besar (413).
  const status = (err as { status?: number }).status;
  if (status === 400 || status === 413) {
    return res.status(status).json({ error: status === 413 ? 'Data yang dikirim terlalu besar.' : 'Format data tidak valid.' });
  }
  console.error('[web]', err);
  res.status(502).json({ error: `Gagal memuat data: ${describeError(err)}` });
}

export function createServer(tracker: Tracker) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  // 300kb: cukup untuk daftar wallet tempelan Track Wallet (maks 5000 alamat).
  app.use(express.json({ limit: '300kb' }));
  app.use(securityHeaders);

  // Login (sebelum requireAuth), lalu semua /api lain wajib login.
  app.get('/api/me', (req, res) => res.json({ authEnabled: authEnabled(), authenticated: isAuthenticated(req) }));
  app.post('/api/login', login);
  app.post('/api/logout', logout);
  app.use('/api', requireAuth);

  registerStream(app, tracker);
  registerWalletRoutes(app, tracker);
  registerPortfolioRoutes(app);
  registerTrackRoutes(app);
  registerSettingsRoutes(app);
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Endpoint tidak ada' }));

  // File tampilan. maxAge 0: browser selalu cek versi terbaru (ETag), jadi update langsung terlihat.
  app.use(express.static(publicDir, { index: 'index.html', maxAge: 0 }));
  app.get(/.*/, (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));

  app.use(errorHandler);
  return app;
}
