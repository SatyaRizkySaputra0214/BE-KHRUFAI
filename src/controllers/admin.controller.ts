import type { Response } from 'express'
import type { PoolClient } from 'pg'
import { pool } from '../config/database.ts'
import { hashPassword } from '../services/auth.service.ts'
import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import nodePath from 'node:path'
import { config } from '../config/env.ts'
import { fail, json } from '../utils/http.ts'
import { readJson } from '../utils/request.ts'
import type { AreaContext } from '../types/http.ts'
import type { AuthenticatedSession } from '../types/session.ts'

const roleValues = new Set(['admin', 'guru', 'murid'])
const courseValues = new Set(['eng', 'kor', 'th'])
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const pageValue = (value: any, fallback: number, max = 100) => Math.min(max, Math.max(1, Number.parseInt(value, 10) || fallback))
const send = (jsonFn: typeof json, res: Response, status: number, data: unknown) => jsonFn(res, status, data)
const validateText = (body: any, name: string, { required = true, max = 255 }: { required?: boolean; max?: number } = {}) => {
  const value = typeof body[name] === 'string' ? body[name].trim() : ''
  if (required && !value) return { error: `${name} wajib diisi.` }
  if (value.length > max) return { error: `${name} maksimal ${max} karakter.` }
  return { value: value || null }
}
const idValue = (value: any) => /^\d+$/.test(String(value || '')) ? String(value) : null
const paginate = async (sql: string, params: any[], page: number, perPage: number) => {
  const result = await pool.query(sql, [...params, perPage, (page - 1) * perPage])
  return result.rows
}
const pagination = (page: number, perPage: number, total: number) => ({
  page,
  per_page: perPage,
  total,
  last_page: Math.max(1, Math.ceil(total / perPage)),
})
const validateUserTextFields = (input: any) => {
  const errors: Record<string, string[]> = {}
  for (const field of ['nama_lengkap', 'username', 'email']) {
    const entry = validateText(input, field, { max: 255 })
    if (entry.error) errors[field] = [entry.error]
    else if (field === 'email' && !emailPattern.test(String(entry.value ?? ''))) errors.email = ['Format email tidak valid.']
    else input[field] = entry.value
  }
  return errors
}

async function transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await work(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally { client.release() }
}

async function dashboard() {
  const [totals, registrations, users, classes, courseStats] = await Promise.all([
    pool.query(`SELECT (SELECT COUNT(*) FROM registrations WHERE status='pending')::int AS pending_count,
                       (SELECT COUNT(*) FROM users WHERE role='murid')::int AS total_students,
                       (SELECT COUNT(*) FROM users WHERE role='guru')::int AS total_gurus,
                       (SELECT COUNT(*) FROM classes)::int AS total_classes`),
    pool.query('SELECT id,nama,email,kursus_pilihan,status,created_at FROM registrations ORDER BY created_at DESC LIMIT 5'),
    pool.query('SELECT id,nama_lengkap,username,email,role,created_at FROM users ORDER BY created_at DESC LIMIT 5'),
    pool.query(`SELECT c.id,c.nama_kelas,c.periode,c.status,c.created_at,co.nama_bahasa AS course_name,u.nama_lengkap AS teacher_name,
                       COUNT(cs.id)::int AS student_count
                  FROM classes c JOIN courses co ON co.id=c.id_course JOIN users u ON u.id=c.id_guru
                  LEFT JOIN class_students cs ON cs.id_class=c.id
                 WHERE c.status='aktif'
                 GROUP BY c.id,co.nama_bahasa,u.nama_lengkap ORDER BY c.created_at DESC LIMIT 5`),
    pool.query(`SELECT CASE kursus_pilihan WHEN 'eng' THEN 'English' WHEN 'kor' THEN 'Korean' ELSE 'Thai' END AS course,
                       COUNT(*)::int AS count FROM registrations GROUP BY kursus_pilihan`),
  ])
  return { ...totals.rows[0], recent_registrations: registrations.rows, recent_users: users.rows, active_classes: classes.rows,
    course_stats: { English: 0, Korean: 0, Thai: 0, ...Object.fromEntries(courseStats.rows.map((r) => [r.course, r.count])) } }
}

async function listUsers(url: URL, forcedRole: string | null = null) {
  const search = url.searchParams.get('search')?.trim() || ''
  const role = forcedRole || url.searchParams.get('role') || ''
  if (role && !roleValues.has(role)) throw fail(422, 'Role tidak valid.', { role: ['Pilih role yang tersedia.'] })
  const course = url.searchParams.get('kursus') || ''
  if (course && !courseValues.has(course)) throw fail(422, 'Kursus tidak valid.', { kursus: ['Pilih kursus yang tersedia.'] })
  const page = pageValue(url.searchParams.get('page'), 1)
  const perPage = 10
  const params: any[] = []
  const where: string[] = []
  if (role) {
    params.push(role)
    where.push(`u.role=$${params.length}`)
  }
  if (search) {
    params.push(`%${search}%`)
    where.push(`(u.nama_lengkap ILIKE $${params.length} OR u.username ILIKE $${params.length} OR u.email ILIKE $${params.length})`)
  }
  if (course) {
    params.push(course)
    where.push(`EXISTS (SELECT 1 FROM class_students cs JOIN classes c ON c.id=cs.id_class JOIN courses co ON co.id=c.id_course WHERE cs.id_student=u.id AND co.kode=$${params.length})`)
  }
  const predicate = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const [count, rows] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS total FROM users u ${predicate}`, params),
    paginate(`SELECT u.id,u.nama_lengkap,u.username,u.email,u.role,u.tingkat_bahasa,u.created_at,
                     COALESCE(json_agg(DISTINCT jsonb_build_object('id',c.id,'nama_kelas',c.nama_kelas,'course',co.nama_bahasa)) FILTER (WHERE c.id IS NOT NULL),'[]') AS classes
                FROM users u LEFT JOIN class_students cs ON cs.id_student=u.id LEFT JOIN classes c ON c.id=cs.id_class
                LEFT JOIN courses co ON co.id=c.id_course ${predicate}
               GROUP BY u.id ORDER BY ${role ? 'u.nama_lengkap' : 'u.role,u.nama_lengkap'} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      params, page, perPage),
  ])
  return { data: rows, pagination: pagination(page, perPage, count.rows[0].total), courses: await getCourses() }
}

async function getCourses() {
  const result = await pool.query('SELECT id,nama_bahasa,kode,deskripsi FROM courses ORDER BY nama_bahasa')
  return result.rows
}

async function getClassOptions() {
  const [courses, teachers, classes] = await Promise.all([
    getCourses(),
    pool.query("SELECT id,nama_lengkap,username FROM users WHERE role='guru' ORDER BY nama_lengkap"),
    pool.query(`SELECT c.id,c.id_course,c.id_guru,c.nama_kelas,c.periode,c.status,co.nama_bahasa AS course_name,u.nama_lengkap AS teacher_name
                  FROM classes c JOIN courses co ON co.id=c.id_course JOIN users u ON u.id=c.id_guru WHERE c.status='aktif' ORDER BY c.nama_kelas`),
  ])
  return { courses, teachers: teachers.rows, active_classes: classes.rows }
}

async function listRegistrations(url: URL) {
  const search = url.searchParams.get('search')?.trim() || ''
  const status = url.searchParams.get('status') || ''
  const course = url.searchParams.get('kursus') || ''
  if (status && !['pending', 'verified', 'rejected'].includes(status)) throw fail(422, 'Status tidak valid.', { status: ['Pilih status yang tersedia.'] })
  if (course && !courseValues.has(course)) throw fail(422, 'Kursus tidak valid.', { kursus: ['Pilih kursus yang tersedia.'] })
  const params: any[] = []
  const where: string[] = []
  if (search) {
    params.push(`%${search}%`)
    where.push(`(r.nama ILIKE $${params.length} OR r.email ILIKE $${params.length})`)
  }
  if (status) {
    params.push(status)
    where.push(`r.status=$${params.length}`)
  }
  if (course) {
    params.push(course)
    where.push(`r.kursus_pilihan=$${params.length}`)
  }
  const predicate = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const page = pageValue(url.searchParams.get('page'), 1)
  const perPage = 15
  const [count, rows] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS total FROM registrations r ${predicate}`, params),
    paginate(`SELECT r.*,u.nama_lengkap AS verifier_name FROM registrations r LEFT JOIN users u ON u.id=r.verified_by
               ${predicate} ORDER BY r.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      params, page, perPage),
  ])
  return { data: rows, pagination: pagination(page, perPage, count.rows[0].total) }
}

async function listClasses(url: URL) {
  const search = url.searchParams.get('search')?.trim() || ''
  const course = url.searchParams.get('kursus') || ''
  const status = url.searchParams.get('status') || ''
  if (course && !courseValues.has(course)) throw fail(422, 'Kursus tidak valid.', { kursus: ['Pilih kursus yang tersedia.'] })
  if (status && !['aktif', 'selesai'].includes(status)) throw fail(422, 'Status tidak valid.', { status: ['Pilih status yang tersedia.'] })
  const params: any[] = []
  const where: string[] = ['c.is_archived=false']
  if (search) {
    params.push(`%${search}%`)
    where.push(`(c.nama_kelas ILIKE $${params.length} OR c.periode ILIKE $${params.length} OR co.nama_bahasa ILIKE $${params.length} OR u.nama_lengkap ILIKE $${params.length})`)
  }
  if (course) {
    params.push(course)
    where.push(`co.kode=$${params.length}`)
  }
  if (status) {
    params.push(status)
    where.push(`c.status=$${params.length}`)
  }
  const predicate = `WHERE ${where.join(' AND ')}`
  const page = pageValue(url.searchParams.get('page'), 1)
  const perPage = 15
  const [count, rows, options] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS total FROM classes c JOIN courses co ON co.id=c.id_course JOIN users u ON u.id=c.id_guru ${predicate}`, params),
    paginate(`SELECT c.id,c.id_course,c.id_guru,c.nama_kelas,c.periode,c.status,c.jumlah_hari,c.created_at,
                     co.nama_bahasa AS course_name,co.kode AS course_code,u.nama_lengkap AS teacher_name,COUNT(cs.id)::int AS student_count
                FROM classes c JOIN courses co ON co.id=c.id_course JOIN users u ON u.id=c.id_guru
                LEFT JOIN class_students cs ON cs.id_class=c.id ${predicate}
               GROUP BY c.id,co.nama_bahasa,co.kode,u.nama_lengkap ORDER BY c.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      params, page, perPage),
    getClassOptions(),
  ])
  return { data: rows, pagination: pagination(page, perPage, count.rows[0].total), options }
}

async function validateClass(body: any, existingId: string | null = null) {
  const errors: Record<string, string[]> = {}
  const id_course = idValue(body.id_course)
  const id_guru = idValue(body.id_guru)
  if (!id_course || !(await pool.query('SELECT 1 FROM courses WHERE id=$1', [id_course])).rowCount) errors.id_course = ['Kursus wajib dipilih.']
  if (!id_guru || !(await pool.query('SELECT 1 FROM users WHERE id=$1', [id_guru])).rowCount) errors.id_guru = ['Guru pengampu wajib dipilih.']
  const nama = validateText(body, 'nama_kelas')
  const periode = validateText(body, 'periode')
  if (nama.error) errors.nama_kelas = [nama.error]
  if (periode.error) errors.periode = [periode.error]
  if (!['aktif', 'selesai'].includes(body.status)) errors.status = ['Status harus aktif atau selesai.']
  const days = Number(body.jumlah_hari)
  if (!Number.isInteger(days) || days < 1 || days > 100) errors.jumlah_hari = ['Jumlah hari harus antara 1 dan 100.']
  if (Object.keys(errors).length) throw fail(422, 'Periksa kembali isian.', errors)
  return { id_course, id_guru, nama_kelas: nama.value, periode: periode.value, status: body.status, jumlah_hari: days }
}

async function userDetails(id: string) {
  const user = await pool.query('SELECT id,nama_lengkap,username,email,role,tingkat_bahasa,created_at FROM users WHERE id=$1', [id])
  if (!user.rowCount) throw fail(404, 'User tidak ditemukan.')
  const [enrollments, registration] = await Promise.all([
    pool.query(`SELECT c.id AS id_class,c.nama_kelas,co.id AS id_course,co.kode AS kursus,co.nama_bahasa,g.nama_lengkap AS teacher_name
                  FROM class_students cs JOIN classes c ON c.id=cs.id_class JOIN courses co ON co.id=c.id_course JOIN users g ON g.id=c.id_guru WHERE cs.id_student=$1`, [id]),
    pool.query('SELECT id,kursus_pilihan,tingkat_bahasa FROM registrations WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1', [id]),
  ])
  return { ...user.rows[0], enrollments: enrollments.rows, registration: registration.rows[0] || null }
}

export async function handleAdminRequest({ req, res, path, session }: AreaContext): Promise<void> {
  const url = new URL(req.url, 'http://localhost')
  let body: any
  const getBody = async (): Promise<any> => body ||= await readJson(req)
  const method = req.method
  let result

  try {
    if (method === 'GET' && path === '/api/admin/dashboard') return send(json, res, 200, { data: await dashboard() })
    if (method === 'GET' && path === '/api/admin/options') return send(json, res, 200, { data: await getClassOptions() })

    if (path === '/api/admin/registrations' && method === 'GET') return send(json, res, 200, await listRegistrations(url))
    let match = path.match(/^\/api\/admin\/registrations\/(\d+)$/)
    if (match && method === 'GET') {
      result = await pool.query(`SELECT r.*,u.nama_lengkap AS verifier_name,created.username AS created_username
                                   FROM registrations r LEFT JOIN users u ON u.id=r.verified_by LEFT JOIN users created ON created.id=r.user_id WHERE r.id=$1`, [match![1]])
      if (!result.rowCount) throw fail(404, 'Pendaftaran tidak ditemukan.')
      const registration = result.rows[0]
      const evidenceRequired =
        (registration.kursus_pilihan === 'eng' && ['A2', 'B1'].includes(registration.tingkat_bahasa)) ||
        (['kor', 'th'].includes(registration.kursus_pilihan) && registration.tingkat_bahasa === 'Intermediate')
      return send(json, res, 200, {
        data: registration,
        evidence_required: evidenceRequired,
        can_create_user: registration.status === 'verified' && !registration.user_id,
        class_options: (await getClassOptions()).active_classes,
      })
    }
    match = path.match(/^\/api\/admin\/registrations\/(\d+)\/evidence\/(payment|placement)$/)
    if (match && method === 'GET') {
      const column = match![2] === 'payment' ? 'bukti_bayar_url' : 'bukti_kemampuan_dasar'
      const evidence = await pool.query(`SELECT ${column} AS file_path FROM registrations WHERE id=$1`, [match![1]])
      if (!evidence.rowCount) throw fail(404, 'Pendaftaran tidak ditemukan.')
      const stored = evidence.rows[0].file_path
      if (!stored) throw fail(404, 'Berkas tidak tersedia.')
      if (/^https?:\/\//i.test(stored)) {
        res.writeHead(302, { Location: stored, 'Cache-Control': 'no-store' })
        res.end()
        return
      }
      if (!config.legacyStoragePublicDir) throw fail(404, 'Folder berkas belum dikonfigurasi pada backend.')
      const root = nodePath.resolve(config.legacyStoragePublicDir)
      const relativeFile = String(stored).replace(/\\/g, '/').replace(/^\/?storage\//, '').replace(/^\//, '')
      let realRoot
      let file
      try {
        realRoot = await realpath(root)
        file = await realpath(nodePath.resolve(realRoot, relativeFile))
      } catch { throw fail(404, 'Berkas tidak ditemukan di penyimpanan yang dikonfigurasi.') }
      const relative = nodePath.relative(realRoot, file)
      if (!relative || relative === '..' || relative.startsWith(`..${nodePath.sep}`) || nodePath.isAbsolute(relative)) throw fail(404, 'Berkas tidak tersedia.')
      let fileInfo
      try { fileInfo = await stat(file) } catch { throw fail(404, 'Berkas tidak ditemukan di penyimpanan yang dikonfigurasi.') }
      if (!fileInfo.isFile()) throw fail(404, 'Berkas tidak tersedia.')
      const ext = nodePath.extname(file).toLowerCase()
      const mime = ({
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.webp': 'image/webp',
        '.gif': 'image/gif',
        '.pdf': 'application/pdf',
      })[ext] || 'application/octet-stream'
      res.writeHead(200, {
        'Content-Type': mime,
        'Content-Length': fileInfo.size,
        'Content-Disposition': `${mime.startsWith('image/') || mime === 'application/pdf' ? 'inline' : 'attachment'}; filename="${nodePath.basename(file).replace(/["\r\n]/g, '_')}"`,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, no-store',
      })
      createReadStream(file).pipe(res)
      return
    }
    match = path.match(/^\/api\/admin\/registrations\/(\d+)\/verify$/)
    if (match && method === 'POST') {
      const input = await getBody()
      const notes = input.admin_notes == null ? '' : String(input.admin_notes).trim()
      const errors: Record<string, string[]> = {}
      if (!['verified', 'rejected'].includes(input.status)) errors.status = ['Pilih verified atau rejected.']
      if (input.status === 'rejected' && !notes) errors.admin_notes = ['Catatan wajib diisi saat menolak pendaftaran.']
      if (notes.length > 500) errors.admin_notes = ['Catatan maksimal 500 karakter.']
      if (Object.keys(errors).length) throw fail(422, 'Periksa kembali isian.', errors)
      result = await pool.query(
        'UPDATE registrations SET status=$1,admin_notes=$2,verified_by=$3,updated_at=CURRENT_TIMESTAMP WHERE id=$4 RETURNING *',
        [input.status, notes || null, session.user_id, match![1]],
      )
      if (!result.rowCount) throw fail(404, 'Pendaftaran tidak ditemukan.')
      return send(json, res, 200, { message: 'Registrasi berhasil diverifikasi.', data: result.rows[0] })
    }
    match = path.match(/^\/api\/admin\/registrations\/(\d+)\/create-user$/)
    if (match && method === 'POST') {
      const input = await getBody()
      const errors: Record<string, string[]> = {}
      const username = validateText(input, 'username')
      if (username.error) errors.username = [username.error]
      if (!roleValues.has(input.role)) errors.role = ['Pilih role yang tersedia.']
      if (typeof input.password !== 'string' || input.password.length < 8) errors.password = ['Password minimal 8 karakter.']
      if (input.password !== input.password_confirmation) errors.password_confirmation = ['Konfirmasi password tidak sama.']
      const classId = input.id_class ? idValue(input.id_class) : null
      if (input.id_class && !classId) errors.id_class = ['Kelas tidak valid.']
      if (Object.keys(errors).length) throw fail(422, 'Periksa kembali isian.', errors)
      const password = await hashPassword(input.password)
      result = await transaction(async (client) => {
        const registration = await client.query('SELECT * FROM registrations WHERE id=$1 FOR UPDATE', [match![1]])
        if (!registration.rowCount) throw fail(404, 'Pendaftaran tidak ditemukan.')
        const row = registration.rows[0]
        if (row.status !== 'verified') throw fail(409, 'Registrasi harus diverifikasi terlebih dahulu.')
        if (row.user_id) throw fail(409, 'User sudah dibuat untuk registrasi ini.')
        if (input.role === 'murid' && classId) {
          const active = await client.query("SELECT 1 FROM classes WHERE id=$1 AND status='aktif'", [classId])
          if (!active.rowCount) throw fail(422, 'Kelas yang dipilih sudah selesai/tidak aktif.', { id_class: ['Pilih kelas aktif.'] })
        }
        const created = await client.query(`INSERT INTO users(username,nama_lengkap,email,tingkat_bahasa,role,password,email_verified_at)
                                            VALUES($1,$2,$3,$4,$5,$6,CURRENT_TIMESTAMP) RETURNING id,username,nama_lengkap,email,role`,
          [username.value, row.nama, row.email, row.tingkat_bahasa, input.role, password])
        await client.query('UPDATE registrations SET user_id=$1,updated_at=CURRENT_TIMESTAMP WHERE id=$2', [created.rows[0].id, row.id])
        if (input.role === 'murid' && classId) {
          await client.query(
            'INSERT INTO class_students(id_class,id_student) VALUES($1,$2) ON CONFLICT DO NOTHING',
            [classId, created.rows[0].id],
          )
        }
        return created.rows[0]
      })
      return send(json, res, 201, { message: 'User berhasil dibuat.', data: result })
    }
    match = path.match(/^\/api\/admin\/registrations\/(\d+)$/)
    if (match && method === 'DELETE') {
      result = await pool.query('DELETE FROM registrations WHERE id=$1 RETURNING id', [match![1]])
      if (!result.rowCount) throw fail(404, 'Pendaftaran tidak ditemukan.')
      return send(json, res, 200, { message: 'Pendaftaran berhasil dihapus.' })
    }

    const roleRoute = path.match(/^\/api\/admin\/(gurus|murids|admins)$/)
    if (path === '/api/admin/users' && method === 'GET') return send(json, res, 200, await listUsers(url))
    if (roleRoute && method === 'GET') return send(json, res, 200, await listUsers(url, { gurus: 'guru', murids: 'murid', admins: 'admin' }[roleRoute[1]]))
    if (path === '/api/admin/users' && method === 'POST') {
      const input = await getBody()
      const errors = validateUserTextFields(input)
      if (!roleValues.has(input.role)) errors.role = ['Pilih role yang tersedia.']
      if (typeof input.password !== 'string' || input.password.length < 8) errors.password = ['Password minimal 8 karakter.']
      if (input.password !== input.password_confirmation) errors.password_confirmation = ['Konfirmasi password tidak sama.']
      if (input.tingkat_bahasa != null && String(input.tingkat_bahasa).length > 50) errors.tingkat_bahasa = ['Tingkat bahasa maksimal 50 karakter.']
      const classId = input.id_class ? idValue(input.id_class) : null
      if (input.id_class && !classId) errors.id_class = ['Kelas tidak valid.']
      if (Object.keys(errors).length) throw fail(422, 'Periksa kembali isian.', errors)
      const hashed = await hashPassword(input.password)
      result = await transaction(async (client) => {
        if (input.role === 'murid' && classId) {
          const active = await client.query("SELECT 1 FROM classes WHERE id=$1 AND status='aktif' AND is_archived=false", [classId])
          if (!active.rowCount) throw fail(422, 'Kelas yang dipilih sudah selesai/tidak aktif.', { id_class: ['Pilih kelas aktif.'] })
        }
        const created = await client.query(`INSERT INTO users(nama_lengkap,username,email,role,tingkat_bahasa,password)
                                            VALUES($1,$2,$3,$4,$5,$6) RETURNING id`, [input.nama_lengkap,input.username,input.email,input.role,input.tingkat_bahasa || null,hashed])
        if (input.role === 'murid' && classId) await client.query('INSERT INTO class_students(id_class,id_student) VALUES($1,$2)', [classId,created.rows[0].id])
        return userDetailsWithClient(client, created.rows[0].id)
      })
      return send(json, res, 201, { message: 'User berhasil ditambahkan.', data: result })
    }

    match = path.match(/^\/api\/admin\/users\/(\d+)$/)
    if (match && method === 'GET') return send(json, res, 200, { data: await userDetails(match![1]), options: await getClassOptions() })
    if (match && method === 'PUT') {
      const input = await getBody()
      const errors = validateUserTextFields(input)
      if (!roleValues.has(input.role)) errors.role = ['Pilih role yang tersedia.']
      if (input.password && (String(input.password).length < 8 || input.password !== input.password_confirmation)) errors.password = ['Password minimal 8 karakter dan konfirmasi harus sama.']
      if (input.tingkat_bahasa != null && String(input.tingkat_bahasa).length > 50) errors.tingkat_bahasa = ['Tingkat bahasa maksimal 50 karakter.']
      if (Object.keys(errors).length) throw fail(422, 'Periksa kembali isian.', errors)
      const target = await pool.query('SELECT id FROM users WHERE id=$1', [match![1]])
      if (!target.rowCount) throw fail(404, 'User tidak ditemukan.')
      let hashed: string | null = null
      if (input.password) hashed = await hashPassword(input.password)
      await transaction(async (client) => {
        await client.query(`UPDATE users SET nama_lengkap=$1,username=$2,email=$3,role=$4,tingkat_bahasa=$5,
                            password=COALESCE($6,password),updated_at=CURRENT_TIMESTAMP WHERE id=$7`,
          [input.nama_lengkap,input.username,input.email,input.role,input.tingkat_bahasa ?? null,hashed,match![1]])
        if (input.role === 'murid' && Object.hasOwn(input, 'id_class')) {
          const classId = input.id_class ? idValue(input.id_class) : null
          if (input.id_class && !classId) throw fail(422, 'Kelas tidak valid.', { id_class: ['Pilih kelas yang tersedia.'] })
          if (classId) {
            const active = await client.query("SELECT 1 FROM classes WHERE id=$1 AND status='aktif'", [classId])
            if (!active.rowCount) throw fail(422, 'Kelas yang dipilih sudah selesai/tidak aktif.', { id_class: ['Pilih kelas aktif.'] })
          }
          await client.query('DELETE FROM class_students WHERE id_student=$1', [match![1]])
          if (classId) await client.query('INSERT INTO class_students(id_class,id_student) VALUES($1,$2)', [classId,match![1]])
        }
      })
      return send(json, res, 200, { message: 'User berhasil diupdate.', data: await userDetails(match![1]) })
    }
    if (match && method === 'DELETE') {
      if (String(session.user_id) === match![1]) throw fail(409, 'Tidak dapat menghapus user yang sedang login.')
      result = await pool.query('DELETE FROM users WHERE id=$1 RETURNING id', [match![1]])
      if (!result.rowCount) throw fail(404, 'User tidak ditemukan.')
      return send(json, res, 200, { message: 'User berhasil dihapus.' })
    }

    if (path === '/api/admin/classes' && method === 'GET') return send(json, res, 200, await listClasses(url))
    if (path === '/api/admin/classes' && method === 'POST') {
      const values = await validateClass(await getBody())
      result = await transaction(async (client) => {
        const created = await client.query(`INSERT INTO classes(id_course,id_guru,nama_kelas,periode,status,jumlah_hari)
                                            VALUES($1,$2,$3,$4,$5,$6) RETURNING id`, Object.values(values))
        for (let i = 1; i <= values.jumlah_hari; i++) {
          await client.query(
            'INSERT INTO meetings(id_class,urutan_pertemuan,judul_pertemuan) VALUES($1,$2,$3)',
            [created.rows[0].id, i, `Pertemuan ${i}`],
          )
        }
        return created.rows[0].id
      })
      return send(json, res, 201, { message: 'Kelas berhasil dibuat.', data: await classDetail(result) })
    }
    match = path.match(/^\/api\/admin\/classes\/(\d+)$/)
    if (match && method === 'GET') return send(json, res, 200, { data: await classDetail(match![1]), options: await getClassOptions() })
    if (match && method === 'PUT') {
      const values = await validateClass(await getBody())
      result = await pool.query(
        `UPDATE classes SET id_course=$1,id_guru=$2,nama_kelas=$3,periode=$4,status=$5,jumlah_hari=$6,updated_at=CURRENT_TIMESTAMP WHERE id=$7 RETURNING id`,
        [...Object.values(values), match![1]],
      )
      if (!result.rowCount) throw fail(404, 'Kelas tidak ditemukan.')
      return send(json, res, 200, { message: 'Kelas berhasil diupdate.', data: await classDetail(match![1]) })
    }
    if (match && method === 'DELETE') {
      result = await pool.query('UPDATE classes SET is_archived=true,updated_at=CURRENT_TIMESTAMP WHERE id=$1 RETURNING id', [match![1]])
      if (!result.rowCount) throw fail(404, 'Kelas tidak ditemukan.')
      return send(json, res, 200, { message: 'Kelas berhasil diarsipkan.' })
    }
    if (path === '/api/admin/classes/enroll' && method === 'POST') {
      const input = await getBody()
      const classId = idValue(input.id_class)
      const rawIds = Array.isArray(input.student_ids) ? input.student_ids : []
      const ids = [...new Set(rawIds.map(idValue))]
      if (ids.some((id) => !id)) throw fail(422, 'Daftar murid tidak valid.', { student_ids: ['Semua ID murid harus berupa ID yang valid.'] })
      if (!classId || !ids.length) throw fail(422, 'Pilih kelas dan minimal satu murid.', { student_ids: ['Pilih minimal satu murid.'] })
      await transaction(async (client) => {
        const classRow = await client.query('SELECT status FROM classes WHERE id=$1 FOR UPDATE', [classId])
        if (!classRow.rowCount) throw fail(404, 'Kelas tidak ditemukan.')
        if (classRow.rows[0].status !== 'aktif') throw fail(409, 'Tidak dapat menambahkan murid ke kelas yang sudah selesai.')
        const existing = await client.query('SELECT COUNT(*)::int AS total FROM users WHERE id=ANY($1::bigint[])', [ids])
        if (existing.rows[0].total !== ids.length) throw fail(422, 'Salah satu murid tidak ditemukan.', { student_ids: ['Pilih ulang daftar murid.'] })
        const students = await client.query("SELECT id FROM users WHERE id=ANY($1::bigint[]) AND role='murid'", [ids])
        for (const row of students.rows) await client.query('INSERT INTO class_students(id_class,id_student) VALUES($1,$2) ON CONFLICT DO NOTHING', [classId,row.id])
      })
      return send(json, res, 200, { message: 'Murid berhasil dimasukkan ke kelas.', data: await classDetail(classId) })
    }

    if (path === '/api/admin/monitoring' && method === 'GET') return send(json, res, 200, { data: await monitoring(url) })
    match = path.match(/^\/api\/admin\/monitoring\/(\d+)\/students\/(\d+)$/)
    if (match && method === 'GET') return send(json, res, 200, { data: await monitoringStudent(match![1],match![2]) })
    return send(json, res, 404, { message: 'Endpoint Admin tidak ditemukan.' })
  } catch (error) {
    if (error.code === '23505') {
      return send(json, res, 409, {
        message: 'Data dengan username atau email tersebut sudah digunakan.',
        errors: { username: ['Nilai harus unik.'], email: ['Nilai harus unik.'] },
      })
    }
    if (error.code === '23503') return send(json, res, 422, { message: 'Relasi data tidak valid.' })
    return send(json, res, error.status || 500, {
      message: error.status ? error.message : 'Terjadi kesalahan pada layanan.',
      ...(error.errors ? { errors: error.errors } : {}),
    })
  }
}

async function userDetailsWithClient(client: PoolClient, id: string) {
  const result = await client.query('SELECT id,nama_lengkap,username,email,role,tingkat_bahasa FROM users WHERE id=$1',[id])
  return result.rows[0]
}

async function classDetail(id: string) {
  const result = await pool.query(`SELECT c.*,co.nama_bahasa AS course_name,co.kode AS course_code,u.nama_lengkap AS teacher_name,
                                         COUNT(cs.id)::int AS student_count
                                    FROM classes c JOIN courses co ON co.id=c.id_course JOIN users u ON u.id=c.id_guru
                                    LEFT JOIN class_students cs ON cs.id_class=c.id WHERE c.id=$1
                                   GROUP BY c.id,co.nama_bahasa,co.kode,u.nama_lengkap`,[id])
  if (!result.rowCount) throw fail(404,'Kelas tidak ditemukan.')
  const [students, available, meetings] = await Promise.all([
    pool.query(`SELECT u.id,u.nama_lengkap,u.username,u.email,u.tingkat_bahasa FROM class_students cs JOIN users u ON u.id=cs.id_student WHERE cs.id_class=$1 ORDER BY u.nama_lengkap`,[id]),
    pool.query(`SELECT u.id,u.nama_lengkap,u.username,u.email,u.tingkat_bahasa FROM users u
                 WHERE u.role='murid' AND NOT EXISTS (SELECT 1 FROM class_students cs WHERE cs.id_class=$1 AND cs.id_student=u.id)
                   AND EXISTS (SELECT 1 FROM registrations r WHERE r.user_id=u.id AND r.kursus_pilihan=$2)
                 ORDER BY u.nama_lengkap`,[id,result.rows[0].course_code]),
    pool.query('SELECT id,urutan_pertemuan,judul_pertemuan,deskripsi FROM meetings WHERE id_class=$1 ORDER BY urutan_pertemuan',[id]),
  ])
  return { ...result.rows[0], students: students.rows, available_students: available.rows, meetings: meetings.rows }
}

async function monitoring(url: URL) {
  const [options, levels] = await Promise.all([
    getClassOptions(),
    pool.query("SELECT DISTINCT tingkat_bahasa FROM users WHERE role='murid' AND tingkat_bahasa IS NOT NULL ORDER BY tingkat_bahasa"),
  ])
  const classId = url.searchParams.get('class_id')
  if (!classId) return { options, students: [], class_stats: null }
  const level = url.searchParams.get('tingkat') || ''
  const result = await pool.query('SELECT id FROM classes WHERE id=$1', [classId])
  if (!result.rowCount) throw fail(404, 'Kelas aktif tidak ditemukan.')
  const roster = await pool.query(
    `SELECT u.id,u.nama_lengkap,u.username,u.email,u.tingkat_bahasa
       FROM class_students cs JOIN users u ON u.id=cs.id_student
      WHERE cs.id_class=$1 AND ($2='' OR u.tingkat_bahasa=$2) ORDER BY u.nama_lengkap`,
    [classId, level],
  )
  const meetings = await pool.query('SELECT id FROM meetings WHERE id_class=$1', [classId])
  const students: any[] = []
  for (const student of roster.rows) {
    const grades = await getStudentGrades(classId, student.id)
    const attendance = await pool.query(
      'SELECT status,COUNT(*)::int AS count FROM attendances WHERE id_student=$1 AND id_meeting=ANY($2::bigint[]) GROUP BY status',
      [student.id, meetings.rows.map((r) => r.id)],
    )
    const present = attendance.rows.filter((r) => r.status === 'hadir').reduce((n, r) => n + r.count, 0)
    const total = meetings.rowCount as number
    const percentage = total ? Math.round((present / total) * 1000) / 10 : 0
    const average = grades.average
    const status = percentage >= 90 && average !== null && average >= 85
      ? 'Sangat Baik'
      : percentage >= 75 && average !== null && average >= 70
        ? 'Baik'
        : 'Perlu Perhatian'
    students.push({
      student,
      ...{
        total_meetings: total,
        hadir: present,
        tidak_hadir: total - present,
        persentase_kehadiran: percentage,
        average_grade: average,
        status,
      },
    })
  }
  const stats = {
    totalStudents: students.length,
    avgGradeClass: students.length ? roundAvg(students.map((s) => s.average_grade).filter((v) => v !== null)) : 0,
    avgKehadiran: students.length ? roundAvg(students.map((s) => s.persentase_kehadiran)) : 0,
    bermasalah: students.filter((s) => s.persentase_kehadiran < 75 || (s.average_grade !== null && s.average_grade < 70)).length,
  }
  return {
    options,
    levels: levels.rows.map((r) => r.tingkat_bahasa),
    selected_class: options.active_classes.find((c) => String(c.id) === String(classId)),
    students,
    class_stats: stats,
  }
}

const roundAvg = (values: number[]) => values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length * 10) / 10 : 0

async function getStudentGrades(classId: string, studentId: string) {
  const [skills, quiz, assignment, counts] = await Promise.all([
    pool.query('SELECT id,kode,nama_skill FROM skills ORDER BY id'),
    pool.query(
      `SELECT q.id_skill,AVG(qs.skor)::float AS score
         FROM quiz_scores qs JOIN quizzes q ON q.id=qs.id_quiz JOIN meetings m ON m.id=q.id_meeting
        WHERE m.id_class=$1 AND qs.id_student=$2 AND qs.skor IS NOT NULL GROUP BY q.id_skill`,
      [classId, studentId],
    ),
    pool.query(
      `SELECT a.id_skill,AVG(s.nilai_guru)::float AS score
         FROM assignment_submissions s JOIN assignments a ON a.id=s.id_assignment JOIN meetings m ON m.id=a.id_meeting
        WHERE m.id_class=$1 AND s.id_student=$2 AND s.nilai_guru IS NOT NULL GROUP BY a.id_skill`,
      [classId, studentId],
    ),
    pool.query(
      `SELECT (SELECT COUNT(*) FROM quiz_scores qs JOIN quizzes q ON q.id=qs.id_quiz JOIN meetings m ON m.id=q.id_meeting WHERE m.id_class=$1 AND qs.id_student=$2 AND qs.skor IS NOT NULL)::int AS quiz_count,
              (SELECT COUNT(*) FROM assignment_submissions s JOIN assignments a ON a.id=s.id_assignment JOIN meetings m ON m.id=a.id_meeting WHERE m.id_class=$1 AND s.id_student=$2 AND s.nilai_guru IS NOT NULL)::int AS assignment_count`,
      [classId, studentId],
    ),
  ])
  const quizScores = new Map(quiz.rows.map((r) => [String(r.id_skill), r.score]))
  const assignmentScores = new Map(assignment.rows.map((r) => [String(r.id_skill), r.score]))
  const scores = Object.fromEntries(skills.rows.map((skill) => {
    const quizValue = quizScores.get(String(skill.id))
    const assignmentValue = assignmentScores.get(String(skill.id))
    return [skill.kode, quizValue != null && assignmentValue != null ? (quizValue + assignmentValue) / 2 : quizValue ?? assignmentValue ?? null]
  }))
  const valid = Object.values(scores).filter((v): v is number => v !== null)
  return {
    skill_scores: scores,
    average: valid.length ? valid.reduce((x, y) => x + y, 0) / valid.length : null,
    ...counts.rows[0],
  }
}

async function monitoringStudent(classId: string, studentId: string) {
  const enrollment = await pool.query(
    `SELECT c.id,c.nama_kelas,c.periode,co.nama_bahasa AS course_name,u.nama_lengkap AS teacher_name,s.id AS student_id,s.nama_lengkap,s.username,s.email,s.tingkat_bahasa
       FROM classes c JOIN courses co ON co.id=c.id_course JOIN users u ON u.id=c.id_guru
       JOIN class_students cs ON cs.id_class=c.id JOIN users s ON s.id=cs.id_student
      WHERE c.id=$1 AND s.id=$2 AND s.role='murid'`,
    [classId, studentId],
  )
  if (!enrollment.rowCount) throw fail(403, 'Murid tidak terdaftar di kelas ini.')
  const grades = await getStudentGrades(classId, studentId)
  const [attendance, history] = await Promise.all([
    pool.query(
      'SELECT status,COUNT(*)::int AS count FROM attendances a JOIN meetings m ON m.id=a.id_meeting WHERE m.id_class=$1 AND a.id_student=$2 GROUP BY status',
      [classId, studentId],
    ),
    pool.query(
      `SELECT m.id,m.urutan_pertemuan,m.judul_pertemuan,
              a.status AS attendance,
              COALESCE(json_agg(DISTINCT jsonb_build_object('judul',q.judul_kuis,'nilai',qs.skor,'skill',sk.nama_skill)) FILTER (WHERE q.id IS NOT NULL),'[]') AS quizzes,
              COALESCE(json_agg(DISTINCT jsonb_build_object('judul',ass.judul_tugas,'nilai',sub.nilai_guru,'skill',ask.nama_skill)) FILTER (WHERE ass.id IS NOT NULL),'[]') AS assignments
         FROM meetings m LEFT JOIN attendances a ON a.id_meeting=m.id AND a.id_student=$2
         LEFT JOIN quizzes q ON q.id_meeting=m.id LEFT JOIN skills sk ON sk.id=q.id_skill LEFT JOIN quiz_scores qs ON qs.id_quiz=q.id AND qs.id_student=$2
         LEFT JOIN assignments ass ON ass.id_meeting=m.id LEFT JOIN skills ask ON ask.id=ass.id_skill LEFT JOIN assignment_submissions sub ON sub.id_assignment=ass.id AND sub.id_student=$2
        WHERE m.id_class=$1 GROUP BY m.id,a.status ORDER BY m.urutan_pertemuan`,
      [classId, studentId],
    ),
  ])
  return { class: enrollment.rows[0], grades, attendance: attendance.rows, history: history.rows }
}
