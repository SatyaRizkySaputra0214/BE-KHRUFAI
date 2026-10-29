# Deploy backend ke Vercel dengan Aiven PostgreSQL

## Persiapan Aiven

1. Pastikan service PostgreSQL aktif dan kredensial `DATABASE_URL` memiliki izin membuat tabel, index, serta menjalankan migrasi.
2. Unduh **CA Certificate** dari halaman service Aiven. Jangan gunakan client certificate atau private key.
3. Untuk Vercel, encode file CA sebagai satu baris base64 di PowerShell:

   ```powershell
   [Convert]::ToBase64String([IO.File]::ReadAllBytes('.\certs\ca.pem'))
   ```

4. Pastikan koneksi dari egress Vercel dapat mencapai Aiven. Jika service memakai IP allowlist, gunakan egress IP Vercel yang stabil dan daftarkan alamatnya di Aiven. Pastikan juga service tidak sedang paused dan kuota koneksinya memadai.

## Persiapan database

Jalankan migrasi dari terminal lokal dengan `DATABASE_URL` dan `PGSSLROOTCERT` diarahkan ke database Aiven:

```powershell
npm run db:apply
```

Perintah ini menerapkan baseline schema, migration `002_persistent_file_storage`, dan data referensi kursus/skill. Jalankan sebelum deployment menerima trafik. Jika Aiven sudah berisi tabel Khrufai tanpa marker migrasi, runner sengaja berhenti; tinjau skema dan data sebelum melakukan adopsi.

## Pengaturan proyek Vercel

1. Import repository dan set **Root Directory** ke folder `backend`.
2. Gunakan Node.js 22 atau lebih baru. Vercel akan mendeteksi Express dari `src/app.ts`; aplikasi mengekspor instance Express sebagai default.
3. Isi environment variables pada **Production**, **Preview**, dan **Development** sesuai kebutuhan:

   | Variable | Nilai |
   | --- | --- |
   | `NODE_ENV` | `production` |
   | `DATABASE_URL` | Connection string Aiven PostgreSQL, simpan sebagai secret |
   | `PGSSLROOTCERT_BASE64` | Isi base64 CA Aiven dari langkah persiapan |
   | `FRONTEND_ORIGIN` | Origin frontend lengkap, misalnya `https://app.example.com`, tanpa slash akhir |
   | `COOKIE_SECURE` | `true` |
   | `COOKIE_SAME_SITE` | Default production `none` agar cookie dapat dikirim lintas origin; bisa disetel `lax` jika frontend dan API berada pada site yang sama |
   | `PGPOOL_MAX` | `3` |
   | `PGCONNECT_TIMEOUT_MS` | `10000` |
   | `SESSION_COOKIE_NAME` | Nama cookie sesi yang unik untuk aplikasi |
   | `SESSION_TTL_HOURS` | `12` |
   | `REMEMBER_TTL_DAYS` | `30` |

   Jika menggunakan `COOKIE_SAME_SITE=none`, `COOKIE_SECURE=true` wajib. Frontend harus mengirim request dengan credentials dan menggunakan URL API yang benar.
4. Deploy Preview terlebih dahulu. Periksa `/api/health`, login, unggah/unduh materi, serta unggah/unduh tugas. Setelah semuanya lolos, promosikan deployment ke Production.

## File dan batas unggahan

Unggahan materi dan tugas baru disimpan di tabel `stored_files` pada Aiven, bukan filesystem instance Vercel. Batas ukuran file adalah 3 MiB agar request tetap di bawah batas payload function Vercel. Ini menambah pemakaian storage dan backup database; siapkan retensi/backup Aiven yang sesuai.

File lama yang hanya berada di folder `uploads/` atau storage Laravel lokal tidak ikut dipindahkan ke Vercel. Pindahkan file lama ke penyimpanan yang persisten sebelum cutover, atau pertahankan legacy storage yang dapat diakses jaringan dan atur `LEGACY_STORAGE_PUBLIC_DIR` jika berkas lama masih harus dibaca.
