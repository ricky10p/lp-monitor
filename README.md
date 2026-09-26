# Meteora LP Monitor + Track Wallet (Dashboard Web)

Dashboard web untuk memantau beberapa wallet Solana: posisi LP **DLMM** dan **DAMM v2** di Meteora, riwayat posisi yang sudah ditutup, performa, dan **alert live** setiap wallet membuka / menutup posisi. Data diambil dari API publik yang dipakai app.meteora.ag (tanpa API key).

## Menjalankan di Windows

```powershell
npm install
npm run dev
```

Buka **http://127.0.0.1:3000**. Pada run pertama, wallet dari `wallets.seed.json` dimasukkan ke database (`data/monitor.db`); setelah itu kelola wallet dari halaman **Wallet**. File ini berisi alamat & nama pribadi sehingga tidak ikut di-commit (`.gitignore`); salin `wallets.seed.example.json` menjadi `wallets.seed.json` untuk memulai.

## Fitur

| Halaman | Isi |
|---|---|
| **Dashboard** | Total nilai & PnL posisi open semua wallet, tabel wallet (urut nilai), feed aktivitas terbaru |
| **Wallet** | Tambah wallet, ganti nama, nyala/matikan alert per protokol (DLMM / DAMM v2), hapus |
| **Portfolio** (`#/portfolio/<alamat>`) | Tampilan ala LP Agent untuk alamat apa pun (cari lewat kotak pencarian, tekan `/`): net worth, total closed, win rate, avg invested, fee, profit; **kalender / grafik profit harian** (filter DLMM / DAMM V2); tabel **posisi open** (Umur, Modal, Nilai, Total fee, uPnL, DPR, mini-bar Range + jumlah bin) dan **posisi historis** (semua posisi closed, dimuat 100 per halaman — halaman berikutnya baru diambil dari API saat klik Berikutnya) dengan sort, filter, cari, mode Kartu/Tabel (default Kartu di layar HP); klik baris untuk **panel detail** (likuiditas & fee per token, range, deposit/withdraw). Alamat yang belum dipantau bisa langsung di-*Pantau* |
| **Aktivitas** | Semua event open/close (tersimpan di database), filter per wallet & jenis, update live |
| **Track Wallet** (`#/track`) | Cari wallet LP yang PnL / fee-nya cocok dengan kriteria: (1) daftar wallet yang *remove liquidity* sebuah token diambil dari GMGN (atau ditempel manual), (2) pool DLMM berisi token itu dicari di portfolio tiap wallet (saring binStep / baseFee / tanggal), (3) pilih pool, (4) dicocokkan dengan salah satu mode: **PNL** (PnL tiap posisi: USD / SOL / %), **PNL PER POOL** (total wallet di satu pool: PnL USD / SOL / %, total deposit, total withdraw, total fee — USD dan SOL; langsung dari data portfolio tanpa request tambahan), atau **FEES** (total fee & PnL semua posisi open + closed). Semua target boleh dikosongkan / diisi sebagian — yang diisi harus cocok semua. Progress live, bisa dihentikan, hasil tersimpan di riwayat, bisa diunduh (`wallet_cocok.json`), dan wallet yang cocok bisa langsung **Tambahkan** ke daftar wallet (dengan nama) |

**Pengaturan** (`#/settings`):
- **RPC Solana**: tambah, hapus, tes, dan ubah urutan beberapa RPC. Dipakai berurutan dari atas; jika satu mati / kena limit (429, 5xx, timeout), otomatis pindah ke berikutnya dan RPC yang gagal dilewati 30 detik. RPC dites sebelum disimpan. `SOLANA_RPC_URL` di `.env` hanya menjadi isian awal. API key tidak pernah dikirim ke browser (ditampilkan tersamar).
- **Notifikasi Telegram**: token bot (dari @BotFather), chat ID (tombol *Deteksi* membaca chat yang sudah mengirim `/start` ke bot), pilihan alert posisi dibuka / ditutup, switch aktif / nonaktif, dan tombol kirim pesan tes. Alert yang dimatikan per wallet juga tidak dikirim ke Telegram.

**Alert live**: setiap open/close langsung muncul di feed, toast di pojok layar, badge di menu Aktivitas, suara, dan notifikasi browser (tombol 🔔 di kanan atas). Notifikasi browser butuh izin dan hanya jalan di `localhost` atau HTTPS; suara & toast tetap jalan di HTTP biasa.

**Strategi posisi (DLMM)**: panel detail posisi dan alert open menampilkan strategi likuiditas — **Spot**, **Curve**, **BidAsk**, gabungannya (mis. *Spot + BidAsk*), atau **Custom**. API Meteora tidak menyimpan strategi, jadi strategi dibaca dari transaksi *add liquidity* on-chain lewat RPC Solana (`SOLANA_RPC_URL`, disarankan Helius): parameter `strategyType` untuk `add_liquidity_by_strategy*`, dan bentuk distribusi (delta per bin) untuk `rebalance_liquidity`. Hasil disimpan di database dan hanya dibaca ulang jika posisi mendapat add baru. Tidak berlaku untuk DAMM v2. Untuk strategi campuran ditampilkan **porsi %** tiap strategi (bagian nilai USD yang di-deposit lewat strategi itu, mis. *BidAsk 86% + Spot 14%*), dan untuk setiap posisi ditampilkan **sisi deposit saat open**: *Single side SOL*, *Single side &lt;token&gt;*, atau *Double side &lt;token&gt; + SOL* (dari transaksi add pertama).

**Likuiditas per bin (DLMM)**: panel detail posisi menampilkan grafik bin ala Meteora — batang per bin (warna token X & Y), garis harga sekarang, sumbu harga, dan tooltip per bin. Posisi **open** dibaca langsung dari akun posisi & bin array on-chain (hasilnya sama persis dengan data Meteora). Posisi **closed** sudah dihapus dari chain, jadi distribusinya **diperkirakan** dari transaksi add (range, strategi, jumlah token) dan diberi label *Perkiraan saat open*. Butuh `SOLANA_RPC_URL`.

**Range dalam %**: harga bin DLMM = (1 + binStep/10000)^binId, jadi % batas range terhadap harga = (1 + binStep/10000)^(selisih bin) − 1 (sama persis dengan minPrice/maxPrice API Meteora). Ditampilkan di panel detail (**Range saat open** dari active bin saat transaksi add pertama, plus perbandingan dengan **default Meteora 69 bin** untuk bin step yang sama — mis. binStep 100 × 69 bin di bawah harga = −49,67%), dan di alert open.

**Visual range**: garis biru = range min → max, penanda oranye = harga sekarang (merah jika di luar range). **DPR** = fee ÷ modal ÷ umur posisi (hari), dihitung oleh dashboard ini. Untuk posisi yang sudah ditutup, titik oranye = *perkiraan* letak harga saat close, dihitung dari komposisi token hasil withdraw (100% token quote = di atas range, 100% token base = di bawah range).

## Cara kerja deteksi

- Setiap `POLL_INTERVAL_SEC` detik, posisi open tiap wallet dibandingkan dengan snapshot di SQLite.
- Posisi baru → event **open**; posisi hilang → dicari di riwayat closed untuk PnL → event **close** (menunggu hingga `CLOSE_CONFIRM_POLLS` kali jika data close belum tersedia).
- Jika API error, siklus dilewati (posisi tidak dianggap tertutup).
- Pengecekan pertama wallet baru hanya menyimpan snapshot (tanpa alert).

## Konfigurasi (`.env`)

| Variabel | Default | Keterangan |
|---|---|---|
| `PORT` | `3000` | Port dashboard |
| `HOST` | `127.0.0.1` | `127.0.0.1` = hanya bisa dibuka dari komputer ini; `0.0.0.0` = bisa dari luar |
| `DASHBOARD_PASSWORD` | – | Password login. **Wajib** jika `HOST` bukan localhost **atau** `NODE_ENV=production` (pm2 di VPS), server menolak start tanpa ini |
| `SECURE_COOKIE` | `false` | `true` jika diakses lewat HTTPS |
| `POLL_INTERVAL_SEC` | `5` | Interval pengecekan (detik, minimal 5) |
| `TRACKER_CONCURRENCY` | `4` | Jumlah wallet yang dicek bersamaan per siklus (1–16) |
| `CLOSE_CONFIRM_POLLS` | `3` | Konfirmasi close |
| `DB_PATH` | `data/monitor.db` | Lokasi database |

## Deploy ke VPS (Ubuntu)

Panduan lengkap langkah demi langkah ada di **[DEPLOY.md](DEPLOY.md)**: persiapan VPS, Node.js + pm2, konfigurasi `.env`, pindah database dari PC, Nginx + HTTPS, firewall, pengaturan RPC & Telegram, cara update, backup otomatis, akses tanpa domain, dan tabel mengatasi masalah.

VPS dipilih (bukan Vercel/serverless) karena tracker harus berjalan terus setiap 5 detik, database-nya SQLite di disk, alert memakai koneksi SSE panjang, dan scan GMGN butuh `curl`.

Update versi: salin file baru → `npm ci && npm run build && pm2 restart lp-monitor`.

Catatan:
- **pm2 harus 1 instance** (sudah diatur di `ecosystem.config.cjs`): tracker dan job Track Wallet menyimpan state di memori.
- **Interval 5 detik**: `POLL_INTERVAL_SEC=5`, wallet dicek paralel sebanyak `TRACKER_CONCURRENCY` (default 4). Lihat durasi siklus di tooltip indikator *Live* (kanan atas). Kalau log sering berisi error 429 (rate limit Meteora), turunkan `TRACKER_CONCURRENCY` atau naikkan interval.
- **GMGN**: konstanta `CLIENT_ID` / `APP_VER` di `src/track/gmgn.ts` ikut berubah tiap GMGN update web-nya — kalau scan ditolak (403 / `code != 0`), ambil nilai baru dari Network tab browser. Kalau IP VPS diblokir GMGN, jalankan scan di PC lokal lalu tempel daftar wallet-nya di kolom **Tempel daftar wallet manual** (tahap 1 dilewati).

## Endpoint yang dipakai

- DLMM `https://dlmm.datapi.meteora.ag`: `/portfolio/open`, `/portfolio`, `/positions/{pool}/pnl?status=open|closed`, `/pools/{pool}`
- DAMM v2 `https://damm-v2.datapi.meteora.ag`: `/wallets/{w}/open_positions`, `/open_positions/total`, `/closed_positions`
- Portfolio `https://portfolio.datapi.meteora.ag`: `/performances/{w}?time_range=`
- Track Wallet: GMGN `https://gmgn.ai/vas/api/mul-region/token_trades_v2/sol/{token}?event=remove` (lewat `curl`), DLMM `/portfolio?user=&days_back=`, `/positions/{pool}/pnl?status=closed|all`

Menambah protokol lain: buat provider di `src/providers/` (lihat `types.ts`), daftarkan di `src/providers/index.ts`, dan tambahkan id-nya ke `PROTOCOLS` di `types.ts`.

## Struktur kode

| Folder | Isi |
|---|---|
| `src/lib/` | Utilitas umum tanpa ketergantungan: retry + backoff (`retry.ts`), cache ber-TTL dengan batas entri (`cache.ts`), paralel terbatas `mapLimit` (`concurrent.ts`), parsing angka API (`num.ts`) |
| `src/api/` | Klien API eksternal saja (Meteora DLMM / DAMM v2 / Portfolio, RPC Solana + failover). Semua URL API ada di sini |
| `src/providers/` | Ubah data API per protokol menjadi `PositionInfo` yang seragam |
| `src/services/` | Logika dashboard: data portfolio, riwayat, strategi, grafik bin, pengaturan RPC, Telegram |
| `src/track/` | Track Wallet (GMGN, kriteria, job) |
| `src/web/` | Server HTTP, dipecah per domain: `walletRoutes`, `portfolioRoutes`, `trackRoutes`, `settingsRoutes`, `sse`, `auth` |

**Sesi login** disimpan di database: logout langsung mencabut cookie tersebut (bukan hanya menghapusnya di browser). Setelah update ini semua perangkat perlu login ulang sekali.
