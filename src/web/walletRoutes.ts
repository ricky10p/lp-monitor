// Route wallet yang dipantau, ringkasan dashboard, dan feed event open/close.
import type { Express, Request, Response } from 'express';
import * as store from '../db.js';
import { PROTOCOLS } from '../providers/types.js';
import { loadSummary } from '../services/data.js';
import type { Tracker } from '../tracker.js';
import { cleanLabel, fresh, isAddress, wrap } from './util.js';

export function walletJson(w: store.Wallet) {
  return {
    address: w.address,
    label: w.label,
    muted: [...store.mutedSet(w)],
    createdAt: w.created_at,
    counts: store.countPositions(w.address),
  };
}

function getWalletOr404(req: Request, res: Response) {
  const w = store.getWallet(String(req.params.address));
  if (!w) res.status(404).json({ error: 'Wallet tidak ditemukan' });
  return w;
}

const errorOf = <T>(v: T | Error) => (v instanceof Error ? { error: v.message } : v);

export function registerWalletRoutes(app: Express, tracker: Tracker) {
  app.get('/api/wallets', (_req, res) => res.json(store.listWallets().map(walletJson)));

  app.post(
    '/api/wallets',
    wrap(async (req, res) => {
      const address = String(req.body?.address ?? '').trim();
      const label = cleanLabel(req.body?.label);
      if (!isAddress(address)) return res.status(400).json({ error: 'Alamat wallet Solana tidak valid (32–44 karakter base58).' });
      if (!label) return res.status(400).json({ error: 'Nama wallet wajib diisi.' });
      if (store.getWallet(address)) return res.status(409).json({ error: 'Wallet ini sudah dipantau.' });
      if (store.labelTaken(label)) return res.status(409).json({ error: `Nama "${label}" sudah dipakai.` });
      store.addWallet(address, label);
      // Cek pertama hanya menyimpan snapshot posisi (tanpa alert), supaya jumlah posisi langsung tampil.
      const errors = await tracker.checkWallet(store.getWallet(address)!);
      res.status(201).json({ wallet: walletJson(store.getWallet(address)!), errors });
    }),
  );

  app.get('/api/wallets/:address', (req, res) => {
    const w = getWalletOr404(req, res);
    if (w) res.json(walletJson(w));
  });

  app.patch('/api/wallets/:address', (req, res) => {
    const w = getWalletOr404(req, res);
    if (!w) return;
    if (req.body?.label !== undefined) {
      const label = cleanLabel(req.body.label);
      if (!label) return res.status(400).json({ error: 'Nama wajib diisi.' });
      if (store.labelTaken(label, w.address)) return res.status(409).json({ error: `Nama "${label}" sudah dipakai.` });
      store.renameWallet(w.address, label);
    }
    if (Array.isArray(req.body?.muted)) {
      store.setMuted(w.address, PROTOCOLS.filter((p) => req.body.muted.includes(p)));
    }
    res.json(walletJson(store.getWallet(w.address)!));
  });

  app.delete('/api/wallets/:address', (req, res) => {
    const w = getWalletOr404(req, res);
    if (!w) return;
    store.removeWallet(w.address);
    res.json({ ok: true });
  });

  app.get(
    '/api/summary',
    wrap(async (req, res) => {
      const data = await loadSummary(store.listWallets(), fresh(req));
      res.json({
        wallets: data.map((s) => ({
          ...walletJson(store.getWallet(s.wallet.address) ?? s.wallet),
          dlmm: errorOf(s.dlmm),
          dammv2: errorOf(s.damm),
        })),
        updatedAt: Date.now(),
      });
    }),
  );

  app.get('/api/events', (req, res) => {
    const kind = req.query.kind === 'open' || req.query.kind === 'close' ? req.query.kind : undefined;
    res.json(
      store.listEvents({
        limit: Math.trunc(Number(req.query.limit)) || 50,
        before: Math.trunc(Number(req.query.before)) || undefined,
        wallet: isAddress(req.query.wallet) ? req.query.wallet : undefined,
        kind,
      }),
    );
  });
}
