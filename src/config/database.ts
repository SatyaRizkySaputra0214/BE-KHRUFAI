import pg from 'pg'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { config } from './env.ts'

const connectionUrl = new URL(config.databaseUrl)
const requestedSslMode = connectionUrl.searchParams.get('sslmode')
let ssl: { ca: string; rejectUnauthorized: boolean } | undefined

if (config.pgSslRootCert || config.pgSslRootCertBase64) {
  const configuredCa = config.pgSslRootCertBase64
    ? Buffer.from(config.pgSslRootCertBase64, 'base64').toString('utf8')
    : config.pgSslRootCert.trim()
  if (config.pgSslRootCertBase64 && !configuredCa.includes('-----BEGIN CERTIFICATE-----')) {
    throw new Error('PGSSLROOTCERT_BASE64 tidak berisi sertifikat PEM Aiven yang valid.')
  }
  const ca = configuredCa.includes('-----BEGIN CERTIFICATE-----')
    ? configuredCa
    : (() => {
        const caPath = path.resolve(config.backendRoot, configuredCa)
        if (!existsSync(caPath)) throw new Error(`CA PostgreSQL tidak ditemukan: ${caPath}. Isi PGSSLROOTCERT dengan isi PEM CA Aiven atau sediakan file certs/ca.pem.`)
        return readFileSync(caPath, 'utf8')
      })()
  // Supplying explicit SSL options alongside sslmode in the URL can cause pg-connection-string
  // to replace the options. Use the Aiven CA and strict hostname verification explicitly.
  connectionUrl.searchParams.delete('sslmode')
  connectionUrl.searchParams.delete('sslrootcert')
  ssl = { ca, rejectUnauthorized: true }
} else if ((requestedSslMode && requestedSslMode !== 'disable') || connectionUrl.hostname.endsWith('.aivencloud.com')) {
  throw new Error('PGSSLROOTCERT wajib diatur untuk koneksi PostgreSQL TLS. Unduh CA Aiven ke backend/certs/ca.pem.')
}

export const pool = new pg.Pool({
  connectionString: connectionUrl.toString(),
  max: config.databasePoolMax,
  connectionTimeoutMillis: config.databaseConnectTimeoutMs,
  idleTimeoutMillis: 10000,
  ...(ssl ? { ssl } : {}),
})
pool.on('error', (error) => console.error('Unexpected PostgreSQL pool error:', error))
