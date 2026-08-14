# Deploy RIMS API — production (Bun + Postgres + Redis, tanpa Docker)

Panduan deploy API di server Linux dengan **Bun, Postgres, dan Redis** (tanpa Docker). Web statis di-serve Apache — lihat `web/DEPLOYMENT.md`.

## Prerequisite

| Komponen | Versi minimal | Catatan |
| --- | --- | --- |
| Bun | 1.3+ | runtime & package manager |
| Postgres | 14+ | lokal di server |
| Redis | 6+ | **wajib** — sesi, rate limit, pub/sub SSE, dan cache statistik semuanya memakai Redis (`Bun.redis`). Tanpa Redis API tidak bisa jalan. |
| Apache | 2.4+ | `mod_proxy`, `mod_proxy_http`, `mod_headers`, `mod_ssl` |

> ⚠️ **Zona waktu server penting.** "Hari ini", statistik, filter tanggal, dan validasi tanggal nota semuanya berbasis **zona waktu lokal server** (`dates.ts`). Jika server di UTC sedangkan pengguna di WIB, angka harian akan salah mulai jam 00.00–07.00 WIB. Pastikan:
>
> ```bash
> sudo timedatectl set-timezone Asia/Jakarta   # atau zona operasional yang benar
> timedatectl                                  # verifikasi
> ```

Buat user sistem khusus:

```bash
sudo useradd --system --create-home --shell /bin/bash rims
```

## 1. Letakkan kode & install

```bash
# layout disamakan dengan qms
sudo mkdir -p /var/www/rims
sudo chown -R rims:rims /var/www/rims

sudo -u rims bash
cd /var/www/rims
git clone <repo-api> api     # repo api/ (pakai repo kamu)
cd api
bun install
cp .env.example .env
```

## 2. Database

```bash
sudo -u postgres psql -c "CREATE USER rims WITH PASSWORD 'ganti-password';"
sudo -u postgres psql -c "CREATE DATABASE rims OWNER rims;"
```

Migrasi (wajib dijalankan sekali saat setup dan setelah `git pull` yang mengubah schema):

```bash
cd /var/www/rims/api
bun run db:migrate
```

> Admin pertama dibuat **otomatis** saat API start (`ensureAdminUser()`) dari `ADMIN_USERNAME`/`ADMIN_PASSWORD`. Jika sudah ada, permission-nya selalu disinkronkan ke set penuh.
>
> ⚠️ **`ADMIN_PASSWORD` env HANYA berlaku untuk pembuatan pertama.** Mengubah `ADMIN_PASSWORD` di `.env` **tidak** mengubah hash admin yang sudah ada. Untuk reset password admin produksi: hapus baris user bootstrap dari DB lalu restart API (akan dibuat ulang dari env), atau reset lewat halaman Pengguna (users:manage).

## Checklist sebelum live

- [ ] `timedatectl set-timezone` sesuai zona operasional (lihat catatan di atas)
- [ ] HTTPS aktif; login menghasilkan cookie `__Host-` dengan `Secure`
- [ ] `bun run db:migrate` tanpa error; data seed/uji tidak ada
- [ ] Realtime: buka 2 tab → transaksi di satu tab tampil di tab lain
- [ ] Backup `pg_dump` diuji restore minimal sekali
- [ ] `.env` production: `COOKIE_DOMAIN` kosong, `WEB_ORIGIN` = https domain, password admin kuat

## 3. Konfigurasi `.env`

Buka `/var/www/rims/api/.env`:

| Variabel | Nilai produksi | Catatan |
| --- | --- | --- |
| `NODE_ENV` | `production` | mengaktifkan cookie `__Host-` + bind `127.0.0.1` |
| `PORT` | `3001` | jangan diubah tanpa mengubah Apache conf |
| `DATABASE_URL` | `postgres://rims:<pass>@127.0.0.1:5432/rims` | |
| `REDIS_URL` | `redis://127.0.0.1:6379` | default `Bun.redis` |
| `ADMIN_USERNAME` | username admin | |
| `ADMIN_PASSWORD` | password kuat (min. 12) | |
| `COOKIE_DOMAIN` | **biarkan kosong** | ⚠️ lihat cookie `__Host-` di bawah |
| `WEB_ORIGIN` | `https://rims.devmoon.net` | origin publik web |

### Cookie `__Host-` (penting!)

Saat `NODE_ENV=production`, cookie sesi bernama **`__Host-rims_session`**. Prefix `__Host-` diwajibkan browser hanya jika **semua** ini terpenuhi:

- `Secure` → koneksi harus **HTTPS** (Apache SSL)
- `Path=/` → sudah otomatis
- **tanpa atribut `Domain`** → karena itu `COOKIE_DOMAIN` harus **kosong**

Jika `COOKIE_DOMAIN` diisi, browser menolak cookie dan login tidak pernah "melekat".

## 4. Systemd service

Buat `/etc/systemd/system/rims-api.service`:

```ini
[Unit]
Description=RIMS API (Bun/Elysia)
After=network.target postgresql.service redis-server.service

[Service]
Type=simple
User=rims
WorkingDirectory=/var/www/rims/api
EnvironmentFile=/var/www/rims/api/.env
ExecStart=/home/rims/.bun/bin/bun run start
Restart=always
RestartSec=3

# Hardening — API tidak menulis file saat runtime
ProtectSystem=strict
PrivateTmp=true
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

> Sesuaikan `ExecStart` dengan lokasi bun kamu (`which bun`). Jika bun terpasang di `/usr/local/bin/bun`, pakai itu.
>
> `ProtectSystem=strict` membuat filesystem read-only saat runtime — aman karena API tidak menulis file. Jika suatu saat perlu menulis (mis. log ke disk), tambahkan `ReadWritePaths=` dengan path yang dimaksud.

Aktifkan & jalankan:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now rims-api
sudo systemctl status rims-api
```

API kini listen **`127.0.0.1:3001`** saja (tidak terekspos publik) — semua lalu lintas masuk lewat proxy Apache.

## 5. Verifikasi API

```bash
curl -s http://127.0.0.1:3001/api/auth/me        # → 401 {"error":"Belum login"} (normal)
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3001/api/stats   # → 401
journalctl -u rims-api -f                        # log API
```

Login/SSE/export baru bisa diuji penuh setelah Apache vhost aktif (lihat `web/DEPLOYMENT.md`).

## 6. Backup

Cron harian (`crontab -e`, user postgres atau sudo):

```cron
15 2 * * * pg_dump -U rims -h 127.0.0.1 rims | gzip > /var/backups/rims/rims-$(date +\%F).sql.gz && find /var/backups/rims -name '*.gz' -mtime +14 -delete
```

> Redis bersifat ephemeral: sesi/login-rate/cache boleh hilang — pengguna tinggal login ulang. Tidak perlu di-backup.

## Update / deploy berikutnya

```bash
cd /var/www/rims/api
git pull
bun install
bun run db:migrate          # hanya jika ada migrasi baru
sudo systemctl restart rims-api
```
