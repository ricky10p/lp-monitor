// Route portfolio (alamat apa pun, tidak harus dipantau) dan detail posisi (strategi, grafik bin).
import type { Express, Request, Response } from 'express';
import { describeError } from '../api/http.js';
import * as store from '../db.js';
import { PROTOCOLS } from '../providers/types.js';
import { loadPoolMeta, loadPositionBins } from '../services/bins.js';
import { loadCalendar, loadOpen, loadOverview } from '../services/data.js';
import { historyPage, type HistoryFilter } from '../services/history.js';
import { detectStrategy, openRangeOf } from '../services/strategy.js';
import { fresh, isAddress, wrap } from './util.js';
import { walletJson } from './walletRoutes.js';

/** Batas nomor halaman riwayat (100 posisi / halaman), pengaman dari permintaan berlebihan. */
const MAX_HISTORY_PAGE = 10_000;

export function registerPortfolioRoutes(app: Express) {
  const portfolio = (sub: string, fn: (address: string, req: Request, res: Response) => Promise<unknown>) =>
    app.get(
      `/api/portfolio/:address${sub}`,
      wrap(async (req, res) => {
        const address = String(req.params.address);
        if (!isAddress(address)) return res.status(400).json({ error: 'Alamat wallet tidak valid' });
        const data = await fn(address, req, res);
        if (!res.headersSent) res.json(data);
      }),
    );

  portfolio('', async (address) => {
    const w = store.getWallet(address);
    return { address, tracked: w ? walletJson(w) : null };
  });
  portfolio('/overview', (address, req) => loadOverview(address, fresh(req)));
  portfolio('/open', (address, req) => loadOpen(address, fresh(req)));
  portfolio('/history', (address, req) => {
    const protocol = String(req.query.protocol);
    const filter: HistoryFilter = (PROTOCOLS as string[]).includes(protocol) ? (protocol as HistoryFilter) : 'all';
    const page = Math.min(MAX_HISTORY_PAGE, Math.max(0, Math.trunc(Number(req.query.page)) || 0));
    return historyPage(address, filter, page, fresh(req));
  });
  portfolio('/calendar', async (address, req, res) => {
    const month = String(req.query.month ?? '');
    if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'Format bulan: YYYY-MM' });
    return loadCalendar(address, month, fresh(req));
  });

  // ---------- strategi posisi (Spot / Curve / BidAsk) ----------
  app.get(
    '/api/positions/:position/strategy',
    wrap(async (req, res) => {
      const position = String(req.params.position);
      if (!isAddress(position)) return res.status(400).json({ error: 'Alamat posisi tidak valid' });
      if (req.query.protocol === 'dammv2') {
        return res.json({
          label: null,
          adds: [],
          note: 'Tidak berlaku untuk DAMM V2: likuiditas tersebar rata di dalam range, tanpa strategi distribusi bin.',
        });
      }
      const pool = isAddress(req.query.pool) ? req.query.pool : '';
      try {
        const [result, meta] = await Promise.all([detectStrategy(position), pool ? loadPoolMeta(pool).catch(() => undefined) : undefined]);
        res.json({
          ...result,
          openRange: meta ? openRangeOf(result, meta.binStep) : null,
          pool: meta ? { binStep: meta.binStep, baseFeePct: meta.baseFeePct } : null,
        });
      } catch (err) {
        res.status(502).json({ error: `Strategi gagal dibaca: ${describeError(err)}` });
      }
    }),
  );

  // ---------- distribusi likuiditas per bin (grafik bin) ----------
  app.get(
    '/api/positions/:position/bins',
    wrap(async (req, res) => {
      const position = String(req.params.position);
      const pool = String(req.query.pool ?? '');
      if (!isAddress(position) || !isAddress(pool)) return res.status(400).json({ error: 'Alamat posisi / pool tidak valid' });
      try {
        res.json(await loadPositionBins(position, pool));
      } catch (err) {
        res.status(502).json({ error: `Data bin gagal dibaca: ${describeError(err)}` });
      }
    }),
  );
}
