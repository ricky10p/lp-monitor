import { config, isLocalHost } from './config.js';
import * as store from './db.js';
import { Tracker } from './tracker.js';
import { syncRpcPool } from './services/rpcSettings.js';
import { notifyTelegram } from './services/telegram.js';
import { curlAvailable } from './track/curl.js';
import { onTrackUpdate } from './track/job.js';
import { broadcast, createServer, statusJson } from './web/server.js';

// Di VPS dashboard tetap di 127.0.0.1 tapi dibuka ke internet lewat Nginx, jadi production juga wajib password.
if (!config.password && (!isLocalHost(config.host) || config.production)) {
  throw new Error(
    config.production
      ? 'NODE_ENV=production: dashboard bisa diakses dari luar lewat proxy. Isi DASHBOARD_PASSWORD di .env terlebih dahulu.'
      : `HOST=${config.host} membuat dashboard bisa diakses dari luar. Isi DASHBOARD_PASSWORD di .env terlebih dahulu.`,
  );
}

const seeded = store.seedWallets(config.seedPath);
if (seeded) console.log(`[db] ${seeded} wallet dari ${config.seedPath} ditambahkan`);

// Daftar RPC dikelola di halaman Pengaturan; SOLANA_RPC_URL hanya dipakai sebagai isian awal.
store.seedRpcEndpoint(config.solanaRpcUrl);
syncRpcPool();

const tracker: Tracker = new Tracker(
  async ({ wallet, opened, closed }) => {
    const events = [
      ...store.saveEvents(wallet, 'open', opened, config.eventsKeep),
      ...store.saveEvents(wallet, 'close', closed, config.eventsKeep),
    ];
    broadcast('alert', events);
    // Telegram dikirim di latar belakang agar tidak menahan siklus tracker.
    void notifyTelegram(events);
    console.log(`[alert] ${wallet.label}: +${opened.length} open, ${closed.length} close`);
  },
  // Kirim status ke browser setiap selesai satu siklus pengecekan.
  () => broadcast('status', statusJson(tracker)),
);

// Progress Track Wallet dikirim ke browser lewat SSE yang sama dengan alert.
onTrackUpdate((job) => broadcast('track', job));
void curlAvailable().then((ok) => {
  if (!ok) console.warn(`[track] ${config.gmgnCurl} tidak ditemukan — scan GMGN tidak bisa dipakai (cek GMGN_CURL / sudo apt install curl)`);
});

const server = createServer(tracker).listen(config.port, config.host, () => {
  const url = `http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`;
  console.log(`[web] dashboard: ${url} · ${store.listWallets().length} wallet · interval ${config.pollIntervalSec}s`);
  if (!config.password) console.log('[web] tanpa password (hanya bisa dibuka dari PC ini)');
  tracker.start();
});

// Port bentrok (mis. aplikasi lain sudah memakai port 3000): beri pesan jelas lalu berhenti,
// supaya pm2 menampilkan status error — bukan terlihat "online" padahal dashboard tidak bisa dibuka.
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `[web] Port ${config.port} sudah dipakai program lain. Cek dengan: sudo ss -ltnp | grep :${config.port}\n` +
        `      Hentikan program itu, atau ganti PORT di .env (dan proxy_pass di konfigurasi Nginx) ke port lain.`,
    );
  } else {
    console.error('[web] server gagal start:', err);
  }
  process.exit(1);
});

function shutdown(signal: string) {
  console.log(`[web] ${signal}, berhenti…`);
  tracker.stop();
  server.close();
  store.closeDb();
  process.exit(0);
}
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
