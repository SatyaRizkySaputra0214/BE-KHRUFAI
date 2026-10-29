import type { Request, Response } from 'express'
import { pool } from '../config/database.ts'
import { clearSessionCookie, createAnonymousSession, publicUser, refreshCsrf, rotateSession, validateCsrf, verifyPassword } from '../services/auth.service.ts'
import { json } from '../utils/http.ts'
import { readJson } from '../utils/request.ts'

const attempts = new Map<string, number[]>()
function loginRateLimited(ip: string): boolean {
  const now = Date.now()
  const recent = (attempts.get(ip) || []).filter((time) => now - time < 60_000)
  attempts.set(ip, recent)
  return recent.length >= 10
}

export async function health(_req: Request, res: Response): Promise<void> {
  await pool.query('SELECT 1')
  return json(res, 200, { status: 'ok' })
}

export async function getCsrf(req: Request, res: Response): Promise<void> {
  const csrfToken = req.authSession ? await refreshCsrf(req.authSession) : await createAnonymousSession(res)
  return json(res, 200, { csrfToken })
}

export async function login(req: Request, res: Response): Promise<void> {
  const session = req.authSession
  const ip = req.socket.remoteAddress || 'unknown'
  if (loginRateLimited(ip)) return json(res, 429, { message: 'Terlalu banyak percobaan login. Coba lagi satu menit.' })
  attempts.set(ip, [...(attempts.get(ip) || []), Date.now()])
  if (!await validateCsrf(req, session)) return json(res, 419, { message: 'Sesi formulir berakhir. Muat ulang halaman login.' })
  const body = await readJson(req)
  const errors: Record<string, string[]> = {}
  if (typeof body.username !== 'string' || !body.username.trim()) errors.username = ['Username wajib diisi.']
  if (typeof body.password !== 'string' || !body.password) errors.password = ['Password wajib diisi.']
  if (Object.keys(errors).length) return json(res, 422, { message: 'Periksa kembali isian.', errors })
  const result = await pool.query('SELECT id, username, nama_lengkap, email, role, password FROM users WHERE LOWER(username) = LOWER($1)', [body.username.trim()])
  const user = result.rows[0]
  const valid = await verifyPassword(body.password, user?.password)
  if (!valid) return json(res, 401, { message: 'Username atau password salah.', errors: { username: ['Username atau password salah.'] } })
  const csrfToken = await rotateSession(res, session, user.id, body.remember === true)
  return json(res, 200, { user: publicUser(user), csrfToken })
}

export async function getSession(req: Request, res: Response): Promise<void> {
  const session = req.authSession
  if (!session?.user_id) return json(res, 200, { user: null })
  return json(res, 200, { user: publicUser(session) })
}

export async function logout(req: Request, res: Response): Promise<void> {
  const session = req.authSession
  if (!session?.user_id) return json(res, 401, { message: 'Sesi login tidak ditemukan.' })
  if (!await validateCsrf(req, session)) return json(res, 419, { message: 'Token keamanan tidak valid.' })
  await pool.query('DELETE FROM auth_sessions WHERE session_hash = $1', [session.session_hash])
  res.setHeader('Set-Cookie', clearSessionCookie())
  return json(res, 200, { user: null })
}
