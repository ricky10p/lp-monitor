# Tutorial Deploy ke VPS Ubuntu

Panduan lengkap memasang **Meteora LP Monitor** di VPS Ubuntu (22.04 / 24.04): dari VPS kosong, `git clone` dari GitHub, sampai dashboard bisa dibuka di **https://lp-monitor.duckdns.org** dengan login, berjalan 24 jam, dan hidup lagi otomatis setelah reboot.

- Repo: **https://github.com/ricky10p/lp-monitor**
- Domain: **lp-monitor.duckdns.org** (subdomain gratis DuckDNS)

**Kenapa VPS (bukan Vercel/serverless)?** Tracker harus berjalan terus setiap 5 detik, database-nya SQLite di disk, alert memakai koneksi live (SSE) yang panjang, dan scan GMGN butuh `curl`. Semua itu butuh server yang selalu menyala.

## Gambaran akhir

```
Browser ──HTTPS──▶ lp-monitor.duckdns.org ──▶ Nginx di VPS (port 443, SSL Let's Encrypt)
                                                 │  proxy
                                                 ▼
                                              Node.js app (127.0.0.1:3000, dijalankan pm2)
                                                 │
                                                 ├─ data/monitor.db  (wallet, alert, pengaturan RPC & Telegram)
                                                 └─ API Meteora, RPC Solana, Telegram, GMGN
```

Port 3000 **tidak** dibuka ke internet. Hanya Nginx (80/443) dan SSH (22) yang bisa diakses dari luar.

## Yang perlu disiapkan

| Kebutuhan | Keterangan |
|---|---|
| VPS Ubuntu 22.04 / 24.04 | Minimal **1 vCPU, 1 GB RAM**, 10 GB disk. 2 GB RAM lebih lega jika memantau banyak wallet |
| IP VPS + akses SSH | Dari penyedia VPS (user `root` + password / SSH key) |
| Akun DuckDNS | Domain `lp-monitor.duckdns.org` (Langkah 0) |
| RPC Solana (disarankan) | Mis. Helius (gratis). RPC publik cepat kena limit |
| Bot Telegram (opsional) | Diatur belakangan dari halaman **Pengaturan** |

Di tutorial ini ada dua nilai yang **harus Anda ganti** dengan milik Anda:

- `IP-VPS` → IP VPS Anda, mis. `203.0.113.10`
- `lpmon` → nama user Linux yang akan dibuat (boleh dibiarkan `lpmon`)

---

## Langkah 0 — Arahkan lp-monitor.duckdns.org ke VPS

1. Buka **https://www.duckdns.org**, login (GitHub / Google).
2. Pastikan subdomain **lp-monitor** sudah ada di daftar domain Anda (jika belum: isi `lp-monitor` di kolom *sub domain*, klik **add domain**).
3. Di baris `lp-monitor`, isi kolom **current ip** dengan **IP VPS** (bukan IP rumah / PC), lalu klik **update ip**.
4. Tunggu 1–2 menit, lalu cek dari PC (PowerShell):

   ```powershell
   nslookup lp-monitor.duckdns.org
   ```

   Hasil `Address:` harus sama dengan IP VPS. Jika belum, tunggu sebentar dan cek lagi. **Jangan lanjut ke Langkah 8 sebelum ini benar**, karena sertifikat HTTPS gagal dibuat jika domain belum mengarah ke VPS.

> IP VPS biasanya tetap, jadi cukup diatur sekali. Jika penyedia VPS mengganti IP (mis. setelah rebuild), ulangi langkah ini.

## Langkah 1 — Masuk ke VPS dan buat user khusus

Jangan menjalankan aplikasi sebagai `root`. Dari PC (PowerShell):

```powershell
ssh root@IP-VPS
```

Di VPS:

```bash
# Update sistem
apt update && apt upgrade -y

# Buat user baru (isi password saat diminta; pertanyaan lain boleh Enter saja), beri akses sudo
adduser lpmon
usermod -aG sudo lpmon

# Zona waktu WIB (supaya jam di log sesuai)
timedatectl set-timezone Asia/Jakarta

exit
```

Mulai sekarang login sebagai user baru:

```powershell
ssh lpmon@IP-VPS
```

## Langkah 2 — Pasang paket yang dibutuhkan

```bash
# Node.js 22 (dari NodeSource)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# git (ambil kode), compiler (cadangan untuk better-sqlite3), curl (scan GMGN), Nginx, sqlite3 (backup)
sudo apt-get install -y git build-essential python3 curl nginx sqlite3

# pm2: menjalankan aplikasi di latar belakang, restart otomatis, hidup lagi setelah reboot
sudo npm install -g pm2

# Cek versi
node -v    # harus v22.x
npm -v
pm2 -v
```

**curl-impersonate (untuk scan GMGN di Track Wallet).** Cloudflare GMGN memblokir curl bawaan Linux karena fingerprint TLS-nya (lewat proxy pun tetap diblokir). curl-impersonate meniru fingerprint Chrome:

```bash
cd /tmp
URL=$(curl -s https://api.github.com/repos/lexiforest/curl-impersonate/releases/latest \
  | grep -o 'https://[^"]*x86_64-linux-gnu\.tar\.gz' | grep -v libcurl | head -1)
echo "$URL"
curl -L "$URL" -o ci.tar.gz && mkdir -p ci && tar xzf ci.tar.gz -C ci
sudo cp ci/* /usr/local/bin/
ls /usr/local/bin | grep curl_chrome   # pilih versi tertinggi, mis. curl_chrome131

# Tes: harus diakhiri 200 dan berisi "code":0
/usr/local/bin/curl_chrome131 -s --compressed -w '\n%{http_code}\n' \
  'https://gmgn.ai/vas/api/mul-region/token_trades_v2/sol/So11111111111111111111111111111111111111112?event=remove&limit=2'
```

Path wrapper itu nanti diisi ke `GMGN_CURL` di `.env` (Langkah 5).

> **VPS RAM 1 GB?** Tambahkan swap supaya `npm ci` tidak kehabisan memori:
> ```bash
> sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
> sudo mkswap /swapfile && sudo swapon /swapfile
> echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
> ```

## Langkah 3 — Ambil kode dari GitHub

```bash
cd ~
git clone https://github.com/ricky10p/lp-monitor.git
cd ~/lp-monitor
ls   # harus terlihat: DEPLOY.md README.md deploy ecosystem.config.cjs package.json public src ...
```

File rahasia & data **tidak ada** di GitHub (`.env`, `data/`, `wallets.seed.json`), jadi dibuat / disalin terpisah di langkah berikutnya.

> Ingin wallet langsung terisi saat pertama jalan? Dari PowerShell di folder proyek PC (`Documents\Gabungan`):
> `scp wallets.seed.json lpmon@IP-VPS:~/lp-monitor/`
> File ini hanya dibaca sekali saat database masih kosong. Lewati jika Anda memindahkan database lama (Langkah 6).

## Langkah 4 — Install dependensi dan build

```bash
cd ~/lp-monitor
npm ci          # install persis sesuai package-lock.json (1–3 menit)
npm run build   # compile TypeScript ke folder dist/
mkdir -p logs data
```

Jika `npm run build` selesai tanpa error, lanjut.

## Langkah 5 — Isi konfigurasi `.env`

```bash
cp .env.example .env

# Buat password dashboard & kunci sesi yang kuat — SALIN kedua hasilnya
openssl rand -base64 18
openssl rand -hex 32

nano .env
```

Ubah isinya menjadi seperti ini (ganti tiga nilai yang ditandai):

```ini
PORT=3000
HOST=127.0.0.1
DASHBOARD_PASSWORD=HASIL-openssl-rand-base64-18
SESSION_SECRET=HASIL-openssl-rand-hex-32
SECURE_COOKIE=false
POLL_INTERVAL_SEC=5
TRACKER_CONCURRENCY=4
CLOSE_CONFIRM_POLLS=3
SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=API-KEY-HELIUS-ANDA
DB_PATH=data/monitor.db
GMGN_CURL=/usr/local/bin/curl_chrome131
```

Simpan: `Ctrl+O`, `Enter`, `Ctrl+X`. Lalu kunci aksesnya:

```bash
chmod 600 .env
```

Catatan penting:

- **Catat `DASHBOARD_PASSWORD`**: ini password untuk login ke dashboard.
- **`DASHBOARD_PASSWORD` wajib.** pm2 menjalankan aplikasi dengan `NODE_ENV=production`, dan di mode itu server **menolak start** tanpa password.
- **`HOST` tetap `127.0.0.1`.** Yang menghadap internet adalah Nginx, bukan aplikasi.
- **`SECURE_COOKIE=false` dulu**; diubah ke `true` setelah HTTPS aktif (Langkah 8e).
- **`SOLANA_RPC_URL`** hanya dipakai sekali sebagai RPC awal. Setelah itu RPC (bisa lebih dari satu, failover otomatis) diatur dari halaman **Pengaturan**.

## Langkah 6 — (Opsional) Pindahkan database dari PC

Lewati langkah ini jika ingin mulai dari database kosong.

1. **Hentikan server di PC** dulu (tutup jendela `npm run dev`) supaya database tidak sedang ditulis.
2. Dari PowerShell di folder proyek PC (`Documents\Gabungan`):

   ```powershell
   scp data/monitor.db lpmon@IP-VPS:~/lp-monitor/data/
   ```

   Jika di folder `data` PC ada `monitor.db-wal` dan `monitor.db-shm`, salin juga keduanya dengan cara yang sama.

Database membawa semua wallet, riwayat alert, hasil Track Wallet, serta pengaturan RPC & Telegram. Sesi login tidak ikut: login ulang di VPS.

## Langkah 7 — Jalankan dengan pm2

```bash
cd ~/lp-monitor
pm2 start ecosystem.config.cjs
pm2 status                              # lp-monitor harus "online"
pm2 logs lp-monitor --lines 30 --nostream
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
# pm2 mencetak satu perintah yang diawali "sudo env PATH=..." — SALIN & JALANKAN perintah itu
pm2 save
```

Rotasi log supaya disk tidak penuh:

```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 7
```

## Langkah 8 — Nginx, firewall, dan HTTPS untuk lp-monitor.duckdns.org

Pastikan Langkah 0 sudah benar (`nslookup lp-monitor.duckdns.org` = IP VPS).

### 8a. Pasang konfigurasi Nginx

Proyek sudah menyertakan contoh konfigurasi, termasuk pengaturan khusus untuk alert live (SSE) supaya koneksinya tidak diputus Nginx.

```bash
sudo cp ~/lp-monitor/deploy/nginx.conf.example /etc/nginx/sites-available/lp-monitor
sudo sed -i 's/monitor.domainanda.com/lp-monitor.duckdns.org/' /etc/nginx/sites-available/lp-monitor
sudo ln -s /etc/nginx/sites-available/lp-monitor /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default     # matikan halaman default Nginx
grep server_name /etc/nginx/sites-available/lp-monitor   # harus: server_name lp-monitor.duckdns.org;
sudo nginx -t                                   # harus "syntax is ok" dan "test is successful"
sudo systemctl reload nginx
```

### 8b. Buka firewall

```bash
sudo ufw allow OpenSSH        # PENTING: buka SSH dulu supaya tidak terkunci dari VPS
sudo ufw allow 'Nginx Full'   # port 80 & 443
sudo ufw enable               # jawab y
sudo ufw status
```

Port 3000 sengaja **tidak** dibuka.

> Beberapa penyedia VPS (mis. AWS, Google Cloud, Oracle, Alibaba) juga punya firewall di panel web (*security group*). Pastikan port **80** dan **443** dibuka di sana juga.

Sekarang **http://lp-monitor.duckdns.org** harus sudah menampilkan halaman login (masih HTTP, belum aman — jangan login dulu).

### 8c. HTTPS gratis (Let's Encrypt)

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d lp-monitor.duckdns.org
# isi email, setujui syarat (Y); jika ditanya redirect, pilih redirect HTTP → HTTPS
```

Jika berhasil, muncul *"Successfully deployed certificate"*. Certbot memperpanjang sertifikat otomatis; tes perpanjangan:

```bash
sudo certbot renew --dry-run
```

### 8d. Aktifkan cookie aman

```bash
cd ~/lp-monitor
sed -i 's/^SECURE_COOKIE=.*/SECURE_COOKIE=true/' .env
pm2 restart lp-monitor
```

### 8e. Buka dashboard

Buka **https://lp-monitor.duckdns.org** (ada ikon gembok di browser). Login dengan `DASHBOARD_PASSWORD` dari Langkah 5.

## Langkah 9 — Pengaturan awal di dashboard

1. **Pengaturan → RPC Solana**: pastikan RPC dari `.env` berstatus **Aktif** (klik **Tes**). Tambahkan RPC cadangan (mis. Helius kedua, QuickNode, atau RPC publik) supaya tetap jalan jika satu mati / kena limit.
2. **Pengaturan → Notifikasi Telegram** (opsional):
   1. Buat bot lewat **@BotFather** (`/newbot`), salin tokennya.
   2. Kirim `/start` ke bot Anda.
   3. Tempel token, klik **Deteksi** untuk mengisi chat ID, klik **Simpan**.
   4. Klik **Kirim pesan tes**, lalu nyalakan switch **Aktif**.
3. **Wallet**: tambahkan wallet yang ingin dipantau (jika belum dipindah dari database lama).
4. Klik tombol 🔔 di kanan atas untuk suara & notifikasi browser.

**Selesai.** Dashboard berjalan 24 jam di https://lp-monitor.duckdns.org. PC boleh dimatikan.

### Cek cepat semuanya berjalan

```bash
pm2 status                                          # lp-monitor: online
curl -sI https://lp-monitor.duckdns.org | head -1   # HTTP/1.1 200 OK (atau HTTP/2 200)
sudo systemctl is-enabled pm2-lpmon                 # enabled → hidup lagi setelah reboot
```

Uji reboot (opsional): `sudo reboot`, tunggu 1 menit, buka lagi dashboard-nya.

---

## Update ke versi baru

Data (`data/`), konfigurasi (`.env`), dan log tidak ikut tersentuh.

Di **PC** (setelah mengubah kode), kirim perubahan ke GitHub dari folder proyek:

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
pm2 logs lp-monitor --lines 30 --nostream
```

Lalu buka dashboard dan tekan **Ctrl+F5** (muat ulang tanpa cache).

> Jika `npm run build` gagal, aplikasi lama tetap berjalan (pm2 belum di-restart). Kembali ke versi sebelumnya dengan `git log --oneline` lalu `git checkout <kode-commit>`, build ulang, dan restart. Setelah masalahnya diperbaiki, kembali ke versi terbaru dengan `git checkout main`.

## Backup database otomatis

Backup harian jam 03.00, simpan 14 hari terakhir:

```bash
mkdir -p ~/backup
crontab -e        # jika ditanya editor, pilih 1 (nano)
```

Tambahkan baris ini di paling bawah (satu baris):

```cron
0 3 * * * sqlite3 /home/lpmon/lp-monitor/data/monitor.db ".backup '/home/lpmon/backup/monitor-$(date +\%F).db'" && find /home/lpmon/backup -name 'monitor-*.db' -mtime +14 -delete
```

`.backup` aman dijalankan saat aplikasi hidup. Sesekali salin backup ke PC (PowerShell): `scp -r lpmon@IP-VPS:~/backup .`

**Memulihkan** backup:

```bash
pm2 stop lp-monitor
cp ~/backup/monitor-2026-09-26.db ~/lp-monitor/data/monitor.db
rm -f ~/lp-monitor/data/monitor.db-wal ~/lp-monitor/data/monitor.db-shm
pm2 start lp-monitor
```

## Alternatif: akses lewat SSH tunnel

Jika suatu saat domain tidak bisa dipakai, dashboard tetap bisa dibuka lewat tunnel SSH dari PC tanpa membuka port apa pun:

```powershell
ssh -L 3000:127.0.0.1:3000 lpmon@IP-VPS
```

Selama jendela itu terbuka, buka **http://localhost:3000** di PC. (Login di sini membutuhkan `SECURE_COOKIE=false`; kembalikan ke `true` setelah selesai.)

## Perintah sehari-hari

| Keperluan | Perintah |
|---|---|
| Status aplikasi | `pm2 status` |
| Lihat log live | `pm2 logs lp-monitor` (keluar: `Ctrl+C`) |
| 100 baris log terakhir | `pm2 logs lp-monitor --lines 100 --nostream` |
| Restart (mis. setelah ubah `.env`) | `pm2 restart lp-monitor` |
| Stop / start | `pm2 stop lp-monitor` / `pm2 start lp-monitor` |
| Pemakaian CPU & RAM | `pm2 monit` |
| Cek Nginx | `sudo nginx -t && sudo systemctl status nginx` |
| Log error Nginx | `sudo tail -f /var/log/nginx/error.log` |
| Cek domain mengarah ke mana | `nslookup lp-monitor.duckdns.org` |

## Mengatasi masalah

| Gejala | Penyebab & solusi |
|---|---|
| `certbot` gagal: *"Timeout during connect"* / *"unauthorized"* | Domain belum mengarah ke VPS atau port 80 tertutup. Cek Langkah 0 (`nslookup` = IP VPS), `sudo ufw status` (Nginx Full), dan firewall di panel penyedia VPS |
| Browser tidak bisa membuka lp-monitor.duckdns.org sama sekali | IP di DuckDNS salah (mis. terisi IP rumah). Perbaiki di duckdns.org → **update ip** |
| pm2 status `errored`, log: *"NODE_ENV=production … Isi DASHBOARD_PASSWORD"* | `DASHBOARD_PASSWORD` di `.env` masih kosong. Isi, lalu `pm2 restart lp-monitor` |
| Domain menampilkan halaman lain (mis. *"server aktif"*), `curl http://127.0.0.1:3000/api/me` membalas *"Cannot GET /api/me"*, atau log: *"Port 3000 sudah dipakai program lain"* | Ada aplikasi lain di port 3000. Pindahkan lp-monitor ke port lain: `sed -i 's/^PORT=.*/PORT=3100/' .env`, lalu `sudo sed -i 's#127.0.0.1:3000#127.0.0.1:3100#' /etc/nginx/sites-available/lp-monitor`, `sudo nginx -t && sudo systemctl reload nginx`, `pm2 restart lp-monitor` |
| Browser: **502 Bad Gateway** | Aplikasi tidak jalan. Cek `pm2 status` dan `pm2 logs lp-monitor`. Pastikan `PORT=3000` di `.env` |
| Tidak bisa login padahal password benar | Masih HTTP tapi `SECURE_COOKIE=true`. Buka lewat **https://**, atau set `false` jika belum ada SSL |
| Status kanan atas terus *"Terputus, menyambung ulang…"* | Blok `location /api/stream` di Nginx hilang / berbeda. Ulangi Langkah 8a lalu jalankan lagi `sudo certbot --nginx -d lp-monitor.duckdns.org` |
| Saldo SOL/USDC "gagal dibaca", strategi / grafik bin gagal | RPC mati atau kena limit (429). **Pengaturan → RPC**, klik **Tes**, tambahkan RPC cadangan |
| Log sering berisi `rate limit (HTTP 429)` dari Meteora | Terlalu banyak wallet per siklus. Naikkan `POLL_INTERVAL_SEC` (mis. 10) atau turunkan `TRACKER_CONCURRENCY` (mis. 2), lalu restart |
| Track Wallet: *"Scan GMGN gagal (HTTP 403)"* | curl bawaan Linux diblokir Cloudflare GMGN. Pasang curl-impersonate (Langkah 2), isi `GMGN_CURL` di `.env`, `pm2 restart lp-monitor`. Jika wrapper-nya juga 403, konstanta `CLIENT_ID`/`APP_VER` mungkin kedaluwarsa. Darurat: scan di PC lalu tempel daftar wallet di **Tempel daftar wallet manual** |
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
