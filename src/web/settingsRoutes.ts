// Route halaman Pengaturan: daftar RPC Solana (failover) dan notifikasi Telegram.
import type { Express, Response } from 'express';
import { addRpc, moveRpc, removeRpc, rpcListJson, SettingsError, testRpcById } from '../services/rpcSettings.js';
import { detectChats, saveTelegram, sendTelegramTest, telegramJson } from '../services/telegram.js';
import { idParam, wrap } from './util.js';

/** Kesalahan isian user → 400 dengan pesan; error lain diteruskan ke handler global. */
function handle(res: Response, err: unknown) {
  if (err instanceof SettingsError) return res.status(400).json({ error: err.message });
  throw err;
}

export function registerSettingsRoutes(app: Express) {
  app.get('/api/settings', (_req, res) => res.json({ rpc: rpcListJson(), telegram: telegramJson() }));

  // ---------- RPC ----------
  app.post(
    '/api/settings/rpc',
    wrap(async (req, res) => {
      try {
        const test = await addRpc(req.body?.url, req.body?.label);
        res.status(201).json({ ...rpcListJson(), test });
      } catch (err) {
        handle(res, err);
      }
    }),
  );

  app.delete('/api/settings/rpc/:id', (req, res) => {
    const id = idParam(req, res);
    if (id === undefined) return;
    try {
      removeRpc(id);
      res.json(rpcListJson());
    } catch (err) {
      handle(res, err);
    }
  });

  app.post('/api/settings/rpc/:id/move', (req, res) => {
    const id = idParam(req, res);
    if (id === undefined) return;
    const dir = req.body?.dir === 'up' ? -1 : req.body?.dir === 'down' ? 1 : 0;
    if (!dir) return res.status(400).json({ error: 'Arah harus "up" atau "down".' });
    try {
      moveRpc(id, dir);
      res.json(rpcListJson());
    } catch (err) {
      handle(res, err);
    }
  });

  app.post(
    '/api/settings/rpc/:id/test',
    wrap(async (req, res) => {
      const id = idParam(req, res);
      if (id === undefined) return;
      try {
        const test = await testRpcById(id);
        res.json({ ...rpcListJson(), test });
      } catch (err) {
        handle(res, err);
      }
    }),
  );

  // ---------- Telegram ----------
  app.put('/api/settings/telegram', (req, res) => {
    try {
      res.json(saveTelegram((req.body ?? {}) as Record<string, unknown>));
    } catch (err) {
      handle(res, err);
    }
  });

  app.post(
    '/api/settings/telegram/test',
    wrap(async (_req, res) => {
      try {
        await sendTelegramTest();
        res.json({ ok: true });
      } catch (err) {
        if (err instanceof SettingsError) return handle(res, err);
        res.status(502).json({ error: (err as Error).message });
      }
    }),
  );

  app.post(
    '/api/settings/telegram/chats',
    wrap(async (req, res) => {
      try {
        res.json({ chats: await detectChats(req.body?.botToken) });
      } catch (err) {
        if (err instanceof SettingsError) return handle(res, err);
        res.status(502).json({ error: (err as Error).message });
      }
    }),
  );
}
