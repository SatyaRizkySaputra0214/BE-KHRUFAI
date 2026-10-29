import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const backendRoot = fileURLToPath(new URL('../../', import.meta.url))

// Load a local .env without adding a runtime dependency. Existing process variables win.
try {
  for (const line of readFileSync(new URL('../../.env', import.meta.url), 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (match && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2')
    }
  }
} catch {}

export const config = {
  host: process.env.API_HOST || '127.0.0.1',
  port: Number(process.env.API_PORT || 3000),
  frontendOrigin: process.env.FRONTEND_ORIGIN || 'http://localhost:5173',
  databaseUrl: process.env.DATABASE_URL as string,
  pgSslRootCert: process.env.PGSSLROOTCERT || '',
  pgSslRootCertBase64: process.env.PGSSLROOTCERT_BASE64 || '',
  backendRoot,
  cookieName: process.env.SESSION_COOKIE_NAME || 'khrufai.sid',
  sessionTtlHours: Number(process.env.SESSION_TTL_HOURS || 12),
  rememberTtlDays: Number(process.env.REMEMBER_TTL_DAYS || 30),
  secureCookie: process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === 'true' : process.env.NODE_ENV === 'production',
  cookieSameSite: (process.env.COOKIE_SAME_SITE || (process.env.NODE_ENV === 'production' ? 'none' : 'lax')).toLowerCase(),
  legacyStoragePublicDir: process.env.LEGACY_STORAGE_PUBLIC_DIR || '',
  databasePoolMax: Number(process.env.PGPOOL_MAX || (process.env.VERCEL ? 3 : 10)),
  databaseConnectTimeoutMs: Number(process.env.PGCONNECT_TIMEOUT_MS || 10000),
  materialUploadDir: process.env.MATERIAL_UPLOAD_DIR || path.join(backendRoot, 'uploads', 'materials'),
  nodeEnv: process.env.NODE_ENV || 'development',
}

if (!config.databaseUrl) throw new Error('DATABASE_URL harus diatur pada backend/.env')
if (process.env.NODE_ENV === 'production' && !process.env.FRONTEND_ORIGIN) {
  throw new Error('FRONTEND_ORIGIN wajib diatur pada environment production.')
}
try {
  const frontendUrl = new URL(config.frontendOrigin)
  if (!['http:', 'https:'].includes(frontendUrl.protocol) || frontendUrl.origin !== config.frontendOrigin) {
    throw new Error()
  }
} catch {
  throw new Error('FRONTEND_ORIGIN harus berupa origin lengkap tanpa path atau slash akhir.')
}
if (!['lax', 'strict', 'none'].includes(config.cookieSameSite)) {
  throw new Error('COOKIE_SAME_SITE harus bernilai lax, strict, atau none.')
}
if (config.cookieSameSite === 'none' && !config.secureCookie) {
  throw new Error('COOKIE_SECURE=true wajib digunakan saat COOKIE_SAME_SITE=none.')
}
if (!Number.isInteger(config.databasePoolMax) || config.databasePoolMax < 1 || config.databasePoolMax > 20) {
  throw new Error('PGPOOL_MAX harus berupa bilangan bulat antara 1 dan 20.')
}
if (!Number.isInteger(config.databaseConnectTimeoutMs) || config.databaseConnectTimeoutMs < 1000) {
  throw new Error('PGCONNECT_TIMEOUT_MS minimal 1000.')
}
