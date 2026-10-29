import { pool } from '../../src/config/database.ts'
import { hashPassword } from '../../src/services/auth.service.ts'

const username = process.env.ADMIN_USERNAME || 'admin'
const name = process.env.ADMIN_NAME || 'Administrator'
const email = process.env.ADMIN_EMAIL || 'admin@khrufai.local'
let password = process.env.ADMIN_INITIAL_PASSWORD

if (!password) throw new Error('Set ADMIN_INITIAL_PASSWORD di environment untuk menjalankan seed; jangan simpan password di file.')
if (password.length < 12) throw new Error('Password admin minimal 12 karakter.')

try {
  const existing = await pool.query('SELECT id FROM users WHERE LOWER(username) = LOWER($1) OR LOWER(email) = LOWER($2) LIMIT 1', [username, email])
  if (existing.rowCount) throw new Error('Username atau email sudah digunakan; seed tidak mengubah akun yang sudah ada.')
  const passwordHash = await hashPassword(password)
  await pool.query(
    `INSERT INTO users (username, nama_lengkap, email, role, password, email_verified_at)
     VALUES ($1, $2, $3, 'admin', $4, CURRENT_TIMESTAMP)`,
    [username, name, email, passwordHash],
  )
  console.log(`Akun admin ${username} berhasil dibuat. Simpan password yang dimasukkan di tempat aman.`)
} catch (error) {
  console.error(`Seed admin gagal${error.code ? ` (${error.code})` : ''}: ${error.message}`)
  process.exitCode = 1
} finally {
  password = ''
  await pool.end()
}
