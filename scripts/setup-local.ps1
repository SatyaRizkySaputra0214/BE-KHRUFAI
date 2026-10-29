$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$backendPath = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $backendPath '.env'
$postgresEnvPath = Join-Path $backendPath '.postgres.env'
$templatePath = Join-Path $backendPath '.env.example'
Push-Location $backendPath
try {
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        throw 'Docker CLI tidak ditemukan. Pasang Docker Desktop, buka aplikasinya, lalu jalankan skrip ini lagi.'
    }

    if (Test-Path -LiteralPath $envPath) {
        $databaseLine = Get-Content -LiteralPath $envPath | Where-Object { $_ -match '^DATABASE_URL=' } | Select-Object -First 1
        if ($databaseLine) {
            $configuredUri = [Uri]($databaseLine.Substring('DATABASE_URL='.Length))
            if ($configuredUri.Host -notin @('localhost','127.0.0.1')) {
                throw 'backend/.env menunjuk ke database remote. Skrip lokal dihentikan agar tidak mengubah DB remote. Gunakan npm run db:apply hanya jika memang ingin menerapkan skema ke DB tersebut.'
            }
        }
    }

    docker info *> $null
    if ($LASTEXITCODE -ne 0) {
        throw 'Docker Engine belum aktif. Buka Docker Desktop, tunggu sampai statusnya Running, lalu jalankan skrip ini lagi.'
    }

    if (-not (Test-Path -LiteralPath $envPath)) {
        $bytes = New-Object byte[] 32
        $random = [System.Security.Cryptography.RandomNumberGenerator]::Create()
        try { $random.GetBytes($bytes) } finally { $random.Dispose() }
        $dbPassword = [BitConverter]::ToString($bytes).Replace('-', '')
        $envText = Get-Content -LiteralPath $templatePath -Raw
        $envText = $envText.Replace('postgresql://khrufai_app:change-this@localhost:5432/khrufai_dev', "postgresql://khrufai_app:$dbPassword@127.0.0.1:5432/khrufai_dev")
        $envText = $envText.Replace('POSTGRES_PASSWORD=replace-with-random-local-secret', "POSTGRES_PASSWORD=$dbPassword")
        [System.IO.File]::WriteAllText($envPath, $envText, [System.Text.UTF8Encoding]::new($false))
        [System.IO.File]::WriteAllText($postgresEnvPath, "POSTGRES_DB=khrufai_dev`nPOSTGRES_USER=khrufai_app`nPOSTGRES_PASSWORD=$dbPassword`n", [System.Text.UTF8Encoding]::new($false))
        Write-Host 'Membuat backend/.env dengan password database acak lokal.'
    } else {
        Write-Host 'Menggunakan backend/.env yang sudah ada; konfigurasi tidak diubah.'
        if (-not (Test-Path -LiteralPath $postgresEnvPath)) { throw 'backend/.postgres.env belum ada. Jalankan setup ini tanpa backend/.env remote atau buat konfigurasi PostgreSQL lokal terpisah.' }
    }

    docker compose up -d postgres
    if ($LASTEXITCODE -ne 0) { throw 'Container PostgreSQL gagal dijalankan.' }

    $ready = $false
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        docker compose exec -T postgres pg_isready -U khrufai_app -d khrufai_dev *> $null
        if ($LASTEXITCODE -eq 0) { $ready = $true; break }
        Start-Sleep -Seconds 2
    }
    if (-not $ready) { throw 'PostgreSQL belum siap setelah 120 detik. Periksa `docker compose logs postgres`.' }

    npm.cmd install
    if ($LASTEXITCODE -ne 0) { throw 'Dependensi backend gagal dipasang. Periksa koneksi npm lalu ulangi.' }

    npm.cmd run db:apply
    if ($LASTEXITCODE -ne 0) { throw 'Skema awal gagal diterapkan. Database tidak dihapus; periksa error PostgreSQL.' }

    $adminCount = docker compose exec -T postgres psql -At -U khrufai_app -d khrufai_dev -c "SELECT COUNT(*) FROM users WHERE username = 'admin' OR email = 'admin@khrufai.local'"
    if ($LASTEXITCODE -ne 0) { throw 'Tidak dapat memeriksa akun admin pada PostgreSQL.' }
    if ([int]($adminCount | Select-Object -Last 1) -eq 0) {
        $securePassword = Read-Host 'Password admin awal (min. 12 karakter)' -AsSecureString
        $passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
        try {
            $env:ADMIN_INITIAL_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)
            npm.cmd run seed:admin
            if ($LASTEXITCODE -ne 0) { throw 'Seed admin gagal.' }
        } finally {
            Remove-Item Env:\ADMIN_INITIAL_PASSWORD -ErrorAction SilentlyContinue
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
        }
    } else {
        Write-Host 'Akun admin sudah ada; seed dilewati dan password tidak diubah.'
    }

    Write-Host ''
    Write-Host 'PostgreSQL development siap di 127.0.0.1:5432.'
    Write-Host 'Jalankan API: npm run dev (folder backend)'
    Write-Host 'Jalankan Vue: npm run dev (folder frontend)'
} finally {
    Pop-Location
}
