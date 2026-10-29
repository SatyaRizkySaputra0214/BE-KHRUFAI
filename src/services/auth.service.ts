import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import type { Request, Response } from 'express'
import bcrypt from 'bcryptjs'
import { config } from '../config/env.ts'
import { pool } from '../config/database.ts'
import type { AuthSession } from '../types/session.ts'

const scrypt = promisify(scryptCallback)
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const token = () => randomBytes(32).toString('base64url')

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex')
  const derived = await scrypt(password, salt, 64) as Buffer
  return `scrypt$${salt}$${Buffer.from(derived).toString('hex')}`
}

export async function verifyPassword(password: string, encoded?: string | null): Promise<boolean> {
  const [scheme, salt, storedHex] = String(encoded || '').split('$')
  if (String(encoded || '').startsWith('$2')) {
    // PHP/Laravel may store bcrypt hashes with the $2y$ prefix.
    const compatibleHash = String(encoded).replace(/^\$2y\$/, '$2b$')
    return bcrypt.compare(password, compatibleHash)
  }
  if (scheme !== 'scrypt' || !salt || !/^[a-f0-9]{128}$/i.test(storedHex || '')) return false
  const actual = Buffer.from(await scrypt(password, salt, 64) as Buffer)
  const expected = Buffer.from(storedHex, 'hex')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

function cookie(name: string, value: string, maxAge: number | null): string {
  const sameSite = config.cookieSameSite[0].toUpperCase() + config.cookieSameSite.slice(1)
  return `${name}=${value}; Path=/; HttpOnly; SameSite=${sameSite}${config.secureCookie ? '; Secure' : ''}${maxAge === null ? '' : `; Max-Age=${maxAge}`}`
}

export function clearSessionCookie(): string {
  const sameSite = config.cookieSameSite[0].toUpperCase() + config.cookieSameSite.slice(1)
  return `${config.cookieName}=; Path=/; HttpOnly; SameSite=${sameSite}${config.secureCookie ? '; Secure' : ''}; Max-Age=0`
}

export function parseCookies(header = ''): Record<string, string> {
  return Object.fromEntries(header.split(';').map((part) => part.trim().split(/=(.*)/s).slice(0, 2)).filter(([key, value]) => key && value !== undefined)) as Record<string, string>
}

export async function loadSession(req: Request): Promise<AuthSession | null> {
  const raw = parseCookies(req.headers.cookie)[config.cookieName]
  if (!raw) return null
  const result = await pool.query(
    `SELECT s.session_hash, s.csrf_hash, s.user_id, s.expires_at,
            u.username, u.nama_lengkap, u.email, u.role
       FROM auth_sessions s LEFT JOIN users u ON u.id = s.user_id
      WHERE s.session_hash = $1 AND s.expires_at > CURRENT_TIMESTAMP`,
    [digest(raw)],
  )
  return result.rows[0] ? { ...result.rows[0], rawToken: raw } : null
}

export async function createAnonymousSession(res: Response): Promise<string> {
  const sessionToken = token()
  const csrfToken = token()
  const ttlSeconds = config.sessionTtlHours * 3600
  await pool.query(
    `INSERT INTO auth_sessions (session_hash, user_id, csrf_hash, expires_at)
     VALUES ($1, NULL, $2, CURRENT_TIMESTAMP + ($3::double precision * INTERVAL '1 second'))`,
    [digest(sessionToken), digest(csrfToken), ttlSeconds],
  )
  res.setHeader('Set-Cookie', cookie(config.cookieName, sessionToken, null))
  return csrfToken
}

export async function refreshCsrf(session: AuthSession): Promise<string> {
  const csrfToken = token()
  await pool.query('UPDATE auth_sessions SET csrf_hash = $1 WHERE session_hash = $2', [digest(csrfToken), session.session_hash])
  return csrfToken
}

export async function rotateSession(res: Response, oldSession: AuthSession | null, userId: string, remember: boolean): Promise<string> {
  const sessionToken = token()
  const csrfToken = token()
  const ttlSeconds = remember ? config.rememberTtlDays * 86400 : config.sessionTtlHours * 3600
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    if (oldSession) await client.query('DELETE FROM auth_sessions WHERE session_hash = $1', [oldSession.session_hash])
    await client.query(
      `INSERT INTO auth_sessions (session_hash, user_id, csrf_hash, expires_at)
       VALUES ($1, $2, $3, CURRENT_TIMESTAMP + ($4::double precision * INTERVAL '1 second'))`,
      [digest(sessionToken), userId, digest(csrfToken), ttlSeconds],
    )
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
  res.setHeader('Set-Cookie', cookie(config.cookieName, sessionToken, remember ? ttlSeconds : null))
  return csrfToken
}

export async function validateCsrf(req: Request, session: AuthSession | null): Promise<boolean> {
  const supplied = req.headers['x-csrf-token']
  if (!session || typeof supplied !== 'string') return false
  const suppliedHash = Buffer.from(digest(supplied))
  const expectedHash = Buffer.from(session.csrf_hash)
  return suppliedHash.length === expectedHash.length && timingSafeEqual(suppliedHash, expectedHash)
}

export function publicUser(user: any) {
  return { id: user.id, username: user.username, nama_lengkap: user.nama_lengkap, email: user.email, role: user.role }
}
