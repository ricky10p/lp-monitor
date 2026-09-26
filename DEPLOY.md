# Tutorial Deploy ke VPS Ubuntu

Panduan lengkap memasang **Meteora LP Monitor** di VPS Ubuntu (22.04 / 24.04), dari VPS kosong sampai dashboard bisa dibuka lewat `https://domain-anda.com` dengan login, berjalan 24 jam, dan hidup lagi otomatis setelah reboot.

**Kenapa VPS (bukan Vercel/serverless)?** Tracker harus berjalan terus setiap 5 detik, database-nya SQLite di disk, alert memakai koneksi live (SSE) yang panjang, dan scan GMGN butuh `curl`. Semua itu butuh server yang selalu menyala.

## Gambaran akhir

```
Browser ──HTTPS──▶ Nginx (port 443, SSL Let's Encrypt)
                     │  proxy
                     ▼
                  Node.js app (127.0.0.1:3000, dijalankan pm2)
                     │
                     ├─ data/monitor.db  (SQLite: wallet, alert, pengaturan RPC & Telegram)
                     └─ API Meteora, RPC Solana, Telegram, GMGN
```

Port 3000 **tidak** dibuka ke internet. Hanya Nginx (80/443) dan SSH (22) yang bisa diakses dari luar.

## Yang perlu disiapkan

| Kebutuhan | Keterangan |
|---|---|
| VPS Ubuntu 22.04 / 24.04 | Minimal **1 vCPU, 1 GB RAM**, 10 GB disk. 2 GB RAM lebih lega jika memantau banyak wallet |
| Akses SSH | IP VPS + user `root` (atau user dengan sudo) dari penyedia VPS |
| Domain (disarankan) | Mis. `monitor.domainanda.com`. Tanpa domain tetap bisa, lihat [Akses tanpa domain](#akses-tanpa-domain-ssh-tunnel) |
| RPC Solana (disarankan) | Mis. Helius (gratis). RPC publik cepat kena limit |
| Bot Telegram (opsional) | Diatur belakangan dari halaman **Pengaturan** |

Di tutorial ini: IP VPS = `203.0.113.10`, domain = `monitor.domainanda.com`, user = `lpmon`. Ganti dengan milik Anda.

---

## Langkah 1 — Masuk ke VPS dan buat user khusus

Jangan menjalankan aplikasi sebagai `root`. Dari PC (PowerShell / Terminal):

```bash
ssh root@203.0.113.10
```

Di VPS:

```bash
# Update sistem
apt update && apt upgrade -y

# Buat user baru (isi password saat diminta), beri akses sudo
adduser lpmon
usermod -aG sudo lpmon

# (Opsional) samakan zona waktu log dengan WIB
timedatectl set-timezone Asia/Jakarta

exit
```

Mulai sekarang login sebagai user baru:

```bash
ssh lpmon@203.0.113.10
```

## Langkah 2 — Pasang paket yang dibutuhkan

```bash
# Node.js 22 (dari NodeSource)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# Compiler (cadangan jika better-sqlite3 perlu di-build), curl untuk GMGN, Nginx, sqlite3 untuk backup
sudo apt-get install -y build-essential python3 curl nginx sqlite3

# pm2: menjalankan aplikasi di latar belakang, restart otomatis, hidup lagi setelah reboot
sudo npm install -g pm2

# Cek versi
node -v    # harus v20 atau lebih baru (v22.x)
npm -v
pm2 -v
```

> **VPS RAM 1 GB?** Tambahkan swap supaya `npm ci` tidak kehabisan memori:
> ```bash
> sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
> sudo mkswap /swapfile && sudo swapon /swapfile
> echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
> ```

## Langkah 3 — Ambil kode dari GitHub

Kode ada di GitHub: **https://github.com/ricky10p/lp-monitor** (repo publik, clone tanpa login). Di **VPS**:

```bash
sudo apt-get install -y git
cd ~
git clone https://github.com/ricky10p/lp-monitor.git
cd ~/lp-monitor
ls   # harus terlihat: src public package.json ecosystem.config.cjs deploy DEPLOY.md ...
```

File rahasia & data **tidak ada** di GitHub (`.env`, `data/`, `wallets.seed.json`), jadi dibuat / disalin terpisah di langkah berikutnya.

> Ingin wallet langsung terisi saat pertama jalan? Salin `wallets.seed.json` dari PC (PowerShell di folder proyek):
> `scp wallets.seed.json lpmon@203.0.113.10:~/lp-monitor/`. File ini hanya dibaca sekali saat database masih kosong.

## Langkah 4 — Install dependensi dan build

```bash
cd ~/lp-monitor
npm ci          # install persis sesuai package-lock.json
npm run build   # compile TypeScript ke folder dist/
mkdir -p logs data
```

Jika `npm run build` selesai tanpa error, lanjut.

## Langkah 5 — Isi konfigurasi `.env`

```bash
cp .env.example .env

# Buat password dashboard & kunci sesi yang kuat (salin hasilnya)
openssl rand -base64 18
openssl rand -hex 32

nano .env
```

Isi minimal seperti ini:

```ini
PORT=3000
HOST=127.0.0.1
DASHBOARD_PASSWORD=isi-dengan-password-kuat
SESSION_SECRET=isi-dengan-hasil-openssl-rand-hex-32
SECURE_COOKIE=false          # ubah ke true setelah HTTPS aktif (Langkah 8)
POLL_INTERVAL_SEC=5
TRACKER_CONCURRENCY=4
CLOSE_CONFIRM_POLLS=3
SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=API_KEY_ANDA
DB_PATH=data/monitor.db
```

Simpan: `Ctrl+O`, `Enter`, `Ctrl+X`.

Catatan penting:

- **`DASHBOARD_PASSWORD` wajib.** pm2 menjalankan aplikasi dengan `NODE_ENV=production`, dan di mode itu server **menolak start** tanpa password. Ini sengaja: lewat Nginx dashboard bisa dibuka dari internet.
- **`HOST` tetap `127.0.0.1`.** Yang menghadap internet adalah Nginx, bukan aplikasi.
- **`SOLANA_RPC_URL`** hanya dipakai sekali sebagai RPC awal. Setelah itu RPC (bisa lebih dari satu, dengan failover otomatis) diatur dari halaman **Pengaturan**.
- **Jaga kerahasiaan file `.env`**: `chmod 600 .env`.

## Langkah 6 — (Opsional) Pindahkan database dari PC

Lewati langkah ini jika ingin mulai dari database kosong.

1. **Hentikan server di PC** dulu supaya database tidak sedang ditulis.
2. Dari PowerShell di folder proyek PC:

   ```powershell
   scp data/monitor.db lpmon@203.0.113.10:~/lp-monitor/data/
   # jika ada, salin juga: data/monitor.db-wal dan data/monitor.db-shm
   ```

Database membawa semua wallet, riwayat alert, hasil Track Wallet, serta pengaturan RPC & Telegram. **Sesi login tidak ikut berlaku**: login ulang di VPS.

## Langkah 7 — Jalankan dengan pm2

```bash
cd ~/lp-monitor
pm2 start ecosystem.config.cjs
pm2 status                 # lp-monitor harus "online"
pm2 logs lp-monitor --lines 30
```

Log yang benar kira-kira:

```
[web] dashboard: http://127.0.0.1:3000 · 10 wallet · interval 5s
```

Cek dari VPS sendiri:

```bash
curl -s http://127.0.0.1:3000/api/me
# {"authEnabled":true,"authenticated":false}
```

Aktifkan start otomatis setelah reboot:

```bash
pm2 startup systemd
# pm2 mencetak satu perintah "sudo env PATH=... pm2 startup ..." — SALIN & JALANKAN perintah itu
pm2 save
```

Rotasi log supaya disk tidak penuh:

```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 7
```

## Langkah 8 — Domain, Nginx, dan HTTPS

### 8a. Arahkan domain ke VPS

Di panel DNS domain Anda, buat record:

| Tipe | Nama | Nilai |
|---|---|---|
| A | `monitor` | `203.0.113.10` |

Tunggu beberapa menit, lalu cek dari PC: `ping monitor.domainanda.com` harus menampilkan IP VPS.

### 8b. Pasang konfigurasi Nginx

Proyek sudah menyertakan contoh konfigurasi, termasuk pengaturan khusus untuk alert live (SSE) supaya koneksinya tidak diputus Nginx.

```bash
sudo cp ~/lp-monitor/deploy/nginx.conf.example /etc/nginx/sites-available/lp-monitor
sudo sed -i 's/monitor.domainanda.com/DOMAIN-ANDA-DI-SINI/' /etc/nginx/sites-available/lp-monitor
sudo ln -s /etc/nginx/sites-available/lp-monitor /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default     # matikan halaman default Nginx
sudo nginx -t                                   # harus "syntax is ok" dan "test is successful"
sudo systemctl reload nginx
```

### 8c. Buka firewall

```bash
sudo ufw allow OpenSSH        # PENTING: buka SSH dulu supaya tidak terkunci
sudo ufw allow 'Nginx Full'   # port 80 & 443
sudo ufw enable
sudo ufw status
```

Port 3000 sengaja **tidak** dibuka.

### 8d. SSL gratis (Let's Encrypt)

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d monitor.domainanda.com
# isi email, setujui syarat, pilih redirect HTTP → HTTPS jika ditanya
```

Certbot memperpanjang sertifikat otomatis. Tes perpanjangan: `sudo certbot renew --dry-run`.

### 8e. Aktifkan cookie aman

Setelah HTTPS jalan, ubah `.env`:

```bash
cd ~/lp-monitor
sed -i 's/^SECURE_COOKIE=.*/SECURE_COOKIE=true/' .env
pm2 restart lp-monitor
```

Buka **https://monitor.domainanda.com**. Halaman login harus muncul; masuk dengan `DASHBOARD_PASSWORD`.

## Langkah 9 — Pengaturan awal di dashboard

1. **Pengaturan → RPC Solana**: pastikan RPC dari `.env` berstatus **Aktif** (klik **Tes**). Tambahkan RPC cadangan (mis. Helius kedua, QuickNode, atau RPC publik) supaya tetap jalan jika satu mati / kena limit.
2. **Pengaturan → Notifikasi Telegram** (opsional):
   1. Buat bot lewat **@BotFather** (`/newbot`), salin tokennya.
   2. Kirim `/start` ke bot Anda.
   3. Tempel token, klik **Deteksi** untuk mengisi chat ID, klik **Simpan**.
   4. Klik **Kirim pesan tes**, lalu nyalakan switch **Aktif**.
3. **Wallet**: tambahkan wallet yang ingin dipantau (jika belum dipindah dari database lama).
4. Klik tombol 🔔 di kanan atas untuk suara & notifikasi browser (butuh HTTPS).

Selesai. Dashboard sekarang berjalan 24 jam.

---

## Update ke versi baru

Data (`data/`), konfigurasi (`.env`), dan log tidak ikut tersentuh.

Di **PC** (setelah mengubah kode): kirim perubahan ke GitHub dari folder proyek:

```powershell
git add -A
git commit -m "Jelaskan perubahan di sini"
git push
```

Di **VPS**:

```bash
cd ~/lp-monitor

# Cadangkan database dulu (jaga-jaga)
sqlite3 data/monitor.db ".backup 'data/monitor-sebelum-update.db'"

git pull          # ambil versi terbaru (file yang dihapus di versi baru ikut terhapus)
rm -rf dist       # buang hasil build lama supaya tidak ada file basi
npm ci
npm run build
pm2 restart lp-monitor
pm2 logs lp-monitor --lines 30
```

Lalu buka dashboard dan tekan **Ctrl+F5** (muat ulang tanpa cache).

> Jika `npm run build` gagal, aplikasi lama tetap berjalan (pm2 belum di-restart). Kembali ke versi sebelumnya dengan `git log --oneline` lalu `git checkout <kode-commit>`, build ulang, dan restart.

## Backup database otomatis

Backup harian jam 03.00, simpan 14 hari terakhir:

```bash
mkdir -p ~/backup
crontab -e
```

Tambahkan baris ini (satu baris):

```cron
0 3 * * * sqlite3 /home/lpmon/lp-monitor/data/monitor.db ".backup '/home/lpmon/backup/monitor-$(date +\%F).db'" && find /home/lpmon/backup -name 'monitor-*.db' -mtime +14 -delete
```

`.backup` aman dijalankan saat aplikasi hidup. Sesekali salin folder `~/backup` ke PC: `scp -r lpmon@203.0.113.10:~/backup .`

**Memulihkan** backup:

```bash
pm2 stop lp-monitor
cp ~/backup/monitor-2026-09-26.db ~/lp-monitor/data/monitor.db
rm -f ~/lp-monitor/data/monitor.db-wal ~/lp-monitor/data/monitor.db-shm
pm2 start lp-monitor
```

## Akses tanpa domain (SSH tunnel)

Tidak punya domain? Jangan buka port 3000 ke internet. Lewati Langkah 8, lalu buka dashboard lewat tunnel SSH dari PC:

```powershell
ssh -L 3000:127.0.0.1:3000 lpmon@203.0.113.10
```

Selama jendela itu terbuka, dashboard bisa dibuka di **http://localhost:3000** di PC. Biarkan `SECURE_COOKIE=false`. Notifikasi browser juga jalan karena alamatnya `localhost`.

## Perintah sehari-hari

| Keperluan | Perintah |
|---|---|
| Status aplikasi | `pm2 status` |
| Lihat log live | `pm2 logs lp-monitor` |
| 100 baris log terakhir | `pm2 logs lp-monitor --lines 100 --nostream` |
| Restart (mis. setelah ubah `.env`) | `pm2 restart lp-monitor` |
| Stop / start | `pm2 stop lp-monitor` / `pm2 start lp-monitor` |
| Pemakaian CPU & RAM | `pm2 monit` |
| Cek Nginx | `sudo nginx -t && sudo systemctl status nginx` |
| Log error Nginx | `sudo tail -f /var/log/nginx/error.log` |

## Mengatasi masalah

| Gejala | Penyebab & solusi |
|---|---|
| pm2 status `errored`, log: *"NODE_ENV=production … Isi DASHBOARD_PASSWORD"* | `DASHBOARD_PASSWORD` di `.env` masih kosong. Isi, lalu `pm2 restart lp-monitor` |
| Browser: **502 Bad Gateway** | Aplikasi tidak jalan. Cek `pm2 status` dan `pm2 logs lp-monitor`. Pastikan `PORT` di `.env` sama dengan `proxy_pass` di Nginx (3000) |
| Tidak bisa login padahal password benar | Jika masih HTTP (belum SSL), `SECURE_COOKIE` harus `false`. Setelah HTTPS aktif baru `true` |
| Status kanan atas terus *"Terputus, menyambung ulang…"* | Blok `location /api/stream` di Nginx hilang / berbeda. Salin ulang dari `deploy/nginx.conf.example`, lalu `sudo nginx -t && sudo systemctl reload nginx` |
| Saldo SOL/USDC "gagal dibaca", strategi / grafik bin gagal | RPC mati atau kena limit (429). Buka **Pengaturan → RPC**, klik **Tes**, tambahkan RPC cadangan |
| Log sering berisi `rate limit (HTTP 429)` dari Meteora | Terlalu banyak wallet per siklus. Naikkan `POLL_INTERVAL_SEC` (mis. 10) atau turunkan `TRACKER_CONCURRENCY` (mis. 2) |
| Track Wallet: *"Scan GMGN gagal"* | IP VPS diblokir GMGN / konstanta GMGN kedaluwarsa. Jalankan scan di PC, lalu tempel daftar wallet di **Tempel daftar wallet manual** |
| Log: *"curl tidak ditemukan"* | `sudo apt-get install -y curl` lalu `pm2 restart lp-monitor` |
| Pesan tes Telegram gagal: *"chat ID tidak ditemukan"* | Kirim `/start` ke bot dulu (untuk grup: tambahkan bot ke grup), lalu klik **Deteksi** lagi |
| `npm ci` berhenti / *"Killed"* | RAM habis. Tambahkan swap (lihat Langkah 2) |
| `git pull` menolak: *"Your local changes would be overwritten"* | Ada file kode yang diubah langsung di VPS. Buang perubahan itu: `git checkout -- .` lalu `git pull` lagi (`.env` dan `data/` aman, tidak dilacak git) |
| Setelah update tampilan tidak berubah | Tekan **Ctrl+F5** di browser |
| Aplikasi restart sendiri berulang | Cek `pm2 logs`. Batas memori 512 MB (`ecosystem.config.cjs`); jika memang perlu lebih, naikkan `max_memory_restart` |

## Catatan keamanan

- Pakai password dashboard yang panjang dan acak, dan jangan bagikan file `.env`.
- Login dibatasi 10 percobaan / 15 menit per IP. Logout langsung mencabut sesi di server.
- Hanya port 22, 80, dan 443 yang terbuka (`sudo ufw status`).
- Lebih aman lagi: login SSH pakai SSH key dan matikan login password SSH (`PasswordAuthentication no` di `/etc/ssh/sshd_config`), lalu `sudo apt install -y fail2ban`.
- Jalankan `sudo apt update && sudo apt upgrade -y` secara berkala.
- Aplikasi wajib berjalan **1 instance** saja (`instances: 1` di `ecosystem.config.cjs`): tracker dan job Track Wallet menyimpan state di memori. Jangan pakai mode cluster pm2.
