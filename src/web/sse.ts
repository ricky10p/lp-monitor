// Server-Sent Events: push alert, status tracker, dan progress Track Wallet ke browser.
import type { Express, Response } from 'express';
import { config } from '../config.js';
import * as store from '../db.js';
import type { Tracker } from '../tracker.js';

/** Batas koneksi SSE bersamaan (satu per tab browser yang terbuka). */
const MAX_CLIENTS = 50;
/** Klien yang tidak membaca data (koneksi macet) diputus jika antrean kirimnya melebihi ini. */
const MAX_BUFFERED_BYTES = 1024 * 1024;
const PING_MS = 25_000;

const clients = new Set<Response>();

function send(res: Response, payload: string) {
  if (res.writableLength > MAX_BUFFERED_BYTES) {
    clients.delete(res);
    res.end();
    return;
  }
  res.write(payload);
}

export function broadcast(event: string, data: unknown) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) send(res, payload);
}

// Komentar SSE berkala agar proxy (Nginx) tidak menutup koneksi yang diam.
setInterval(() => {
  for (const res of clients) send(res, ': ping\n\n');
}, PING_MS).unref();

export function statusJson(tracker: Tracker) {
  return {
    lastRunAt: tracker.lastRunAt?.getTime() ?? null,
    lastRunMs: tracker.lastRunMs,
    errors: tracker.lastErrors,
    pollIntervalSec: config.pollIntervalSec,
    wallets: store.listWallets().length,
    uptimeSec: Math.round(process.uptime()),
  };
}

export function registerStream(app: Express, tracker: Tracker) {
  app.get('/api/stream', (req, res) => {
    if (clients.size >= MAX_CLIENTS) return res.status(503).json({ error: 'Terlalu banyak koneksi live. Tutup beberapa tab dashboard.' });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`event: status\ndata: ${JSON.stringify(statusJson(tracker))}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
  });
}
