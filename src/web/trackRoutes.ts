// Route Track Wallet: mulai / pilih pool / hentikan job, riwayat, dan jumlah wallet tersimpan.
import type { Express, Response } from 'express';
import * as store from '../db.js';
import { CriteriaError, parseCriteria, parseMode } from '../track/criteria.js';
import * as track from '../track/job.js';
import { BASE58, idParam, isAddress } from './util.js';

const MAX_PASTED_WALLETS = 5000;
const RUNS_LIMIT = 50;

/** Kesalahan isian → 400, kesalahan status job → 404 / 409; selain itu diteruskan ke handler global. */
function handleTrackError(res: Response, err: unknown) {
  if (err instanceof CriteriaError) return res.status(400).json({ error: err.message });
  if (err instanceof track.TrackError) return res.status(err.status).json({ error: err.message });
  throw err;
}

/** Daftar wallet tempelan (dipisah spasi / koma / baris baru), atau pesan error. */
function parsePasted(raw: unknown): { wallets: string[] } | { error: string } {
  const list = (typeof raw === 'string' ? raw : '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const invalid = list.filter((w) => !BASE58.test(w));
  if (invalid.length) return { error: `${invalid.length} alamat wallet tempelan tidak valid, mis. "${invalid[0].slice(0, 50)}".` };
  if (list.length > MAX_PASTED_WALLETS) return { error: `Maksimal ${MAX_PASTED_WALLETS} wallet tempelan.` };
  return { wallets: [...new Set(list)] };
}

export function registerTrackRoutes(app: Express) {
  app.get('/api/track', (_req, res) => res.json({ job: track.jobJson() }));

  app.post('/api/track', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const contract = String(body.contract ?? '').trim();
    if (!isAddress(contract)) return res.status(400).json({ error: 'Alamat kontrak token tidak valid (harus base58, 32–44 karakter).' });
    const pasted = parsePasted(body.wallets);
    if ('error' in pasted) return res.status(400).json({ error: pasted.error });
    try {
      const mode = parseMode(body.mode);
      const job = track.startJob({
        contract,
        mode,
        criteria: parseCriteria(body, mode),
        reuseWallets: body.reuseWallets === true,
        pastedWallets: pasted.wallets,
      });
      res.status(201).json({ job: track.jobJson(job) });
    } catch (err) {
      handleTrackError(res, err);
    }
  });

  app.post('/api/track/:id/pools', (req, res) => {
    const pools = req.body?.pools;
    if (pools !== 'all' && !(Array.isArray(pools) && pools.every(isAddress))) {
      return res.status(400).json({ error: 'Format pilihan pool tidak valid.' });
    }
    const id = idParam(req, res);
    if (id === undefined) return;
    try {
      res.json({ job: track.jobJson(track.selectPools(id, pools)) });
    } catch (err) {
      handleTrackError(res, err);
    }
  });

  app.post('/api/track/:id/cancel', (req, res) => {
    const id = idParam(req, res);
    if (id === undefined) return;
    try {
      res.json({ job: track.jobJson(track.cancelJob(id)) });
    } catch (err) {
      handleTrackError(res, err);
    }
  });

  app.get('/api/track/runs', (_req, res) => res.json(store.listTrackRuns(RUNS_LIMIT)));

  app.get('/api/track/runs/:id', (req, res) => {
    const id = idParam(req, res);
    if (id === undefined) return;
    const run = store.getTrackRun(id);
    if (!run) return res.status(404).json({ error: 'Riwayat tidak ditemukan' });
    res.json(run);
  });

  app.get('/api/track/wallets/:contract', (req, res) => {
    const contract = String(req.params.contract);
    if (!isAddress(contract)) return res.status(400).json({ error: 'Alamat kontrak token tidak valid' });
    res.json({ contract, count: store.countTrackWallets(contract) });
  });
}
