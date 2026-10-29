import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import pathUtil from 'node:path'
import type { Response } from 'express'
import { pool } from '../config/database.ts'
import { config } from '../config/env.ts'
import { fail, json } from '../utils/http.ts'
import { readJson } from '../utils/request.ts'
import type { AreaContext } from '../types/http.ts'
import { deleteStoredFile, getStoredFile, MAX_UPLOAD_BYTES, saveStoredFile } from '../services/file-storage.service.ts'

const id = (value: any) => /^\d+$/.test(String(value ?? '')) ? String(value) : null
const text = (body: any, field: string, { required = true, max = 255 }: { required?: boolean; max?: number } = {}) => {
  const value = typeof body[field] === 'string' ? body[field].trim() : ''
  if (required && !value) return { error: `${field} wajib diisi.` }
  if (value.length > max) return { error: `${field} maksimal ${max} karakter.` }
  return { value: value || null }
}
const send = (jsonFn: typeof json, res: Response, status: number, data: unknown) => jsonFn(res, status, data)

const kindTables: Record<string, string> = {
  quizzes: 'quizzes',
  assignments: 'assignments',
  announcements: 'announcements',
  attendance: 'attendances',
}

const quizSchema = {
  id_skill: { type: 'id' },
  judul_kuis: { required: true },
  deskripsi: { required: false },
  durasi: { type: 'number', min: 1, max: 1440, integer: true, optional: true },
  start_at: { required: false },
  end_at: { required: false },
}

const assignmentSchema = {
  id_skill: { type: 'id' },
  judul_tugas: { required: true },
  deskripsi: { required: true, max: 10000 },
  deadline: { required: false },
  poin_maksimal: { type: 'number', min: 1, max: 100, integer: true, optional: true, default: 100 },
}

const announcementSchema = {
  judul_pengumuman: { required: true },
  isi_pengumuman: { required: true, max: 10000 },
  is_penting: { type: 'bool' },
}

async function owned(table: string, key: string, value: any, guruId: string, join = '') {
  const result = await pool.query(`SELECT x.* FROM ${table} x ${join} WHERE x.${key}=$1 AND c.id_guru=$2`, [value, guruId])
  if (!result.rowCount) throw fail(404, 'Data tidak ditemukan atau bukan milik Anda.')
  return result.rows[0]
}

async function meeting(idValue: any, guruId: string) {
  return owned('meetings', 'id', idValue, guruId, 'JOIN classes c ON c.id=x.id_class')
}

async function quiz(idValue: any, guruId: string) {
  return owned('quizzes', 'id', idValue, guruId, 'JOIN meetings m ON m.id=x.id_meeting JOIN classes c ON c.id=m.id_class')
}

async function assignment(idValue: any, guruId: string) {
  return owned('assignments', 'id', idValue, guruId, 'JOIN meetings m ON m.id=x.id_meeting JOIN classes c ON c.id=m.id_class')
}

async function classInfo(classId: any, guruId: string) {
  const result = await pool.query(
    `SELECT c.*, co.nama_bahasa AS course_name,co.kode AS course_code,u.nama_lengkap AS teacher_name,
            (SELECT COUNT(*)::int FROM class_students cs WHERE cs.id_class=c.id) AS student_count
       FROM classes c JOIN courses co ON co.id=c.id_course JOIN users u ON u.id=c.id_guru
      WHERE c.id=$1 AND c.id_guru=$2`,
    [classId, guruId],
  )
  if (!result.rowCount) throw fail(404, 'Kelas tidak ditemukan atau bukan kelas Anda.')
  return result.rows[0]
}

async function classDetail(classId: any, guruId: string) {
  const cls = await classInfo(classId, guruId)
  const [students, meetings] = await Promise.all([
    pool.query(
      `SELECT u.id,u.nama_lengkap,u.username,u.email FROM class_students cs JOIN users u ON u.id=cs.id_student WHERE cs.id_class=$1 ORDER BY u.nama_lengkap`,
      [classId],
    ),
    pool.query(
      `SELECT m.*,
              COALESCE((SELECT json_agg(to_jsonb(x) ORDER BY x.id) FROM materials x WHERE x.id_meeting=m.id),'[]') materials,
              COALESCE((SELECT json_agg((to_jsonb(x)||jsonb_build_object('skill_name',s.nama_skill,'skill_code',s.kode)) ORDER BY x.id) FROM quizzes x JOIN skills s ON s.id=x.id_skill WHERE x.id_meeting=m.id),'[]') quizzes,
              COALESCE((SELECT json_agg((to_jsonb(x)||jsonb_build_object('skill_name',s.nama_skill,'skill_code',s.kode)) ORDER BY x.id) FROM assignments x JOIN skills s ON s.id=x.id_skill WHERE x.id_meeting=m.id),'[]') assignments,
              COALESCE((SELECT json_agg(to_jsonb(x) ORDER BY x.id) FROM announcements x WHERE x.id_meeting=m.id),'[]') announcements,
              (SELECT COUNT(*)::int FROM attendances a WHERE a.id_meeting=m.id) attendance_count
         FROM meetings m WHERE m.id_class=$1 ORDER BY m.urutan_pertemuan`,
      [classId],
    ),
  ])
  return { ...cls, students: students.rows, meetings: meetings.rows }
}

async function skills() {
  return (await pool.query('SELECT id,nama_skill,kode FROM skills ORDER BY id')).rows
}

async function requireSkill(skillId: any) {
  if (!(await pool.query('SELECT 1 FROM skills WHERE id=$1', [skillId])).rowCount) {
    throw fail(422, 'Skill tidak ditemukan.', { id_skill: ['Pilih skill yang tersedia.'] })
  }
}

function validate(body: any, schema: Record<string, any>) {
  const errors: Record<string, string[]> = {}
  const values: Record<string, any> = {}
  for (const [field, rule] of Object.entries(schema)) {
    if (rule.type === 'id') {
      const value = id(body[field])
      if (!value) errors[field] = [`${field} wajib dipilih.`]
      else values[field] = value
      continue
    }
    if (rule.type === 'bool') {
      values[field] = body[field] === true || body[field] === '1' || body[field] === 'true'
      continue
    }
    if (rule.type === 'enum') {
      if (!rule.values.includes(body[field])) errors[field] = [`${field} tidak valid.`]
      else values[field] = body[field]
      continue
    }
    if (rule.type === 'number') {
      const n = body[field] === '' || body[field] == null ? rule.default : Number(body[field])
      if (rule.optional && n == null) {
        values[field] = null
        continue
      }
      if (!Number.isFinite(n) || n < rule.min || n > rule.max || (rule.integer && !Number.isInteger(n))) {
        errors[field] = [`${field} harus bernilai ${rule.min} sampai ${rule.max}.`]
      } else {
        values[field] = n
      }
      continue
    }
    const v = text(body, field, rule)
    if (v.error) errors[field] = [v.error]
    else values[field] = v.value
  }
  if (Object.keys(errors).length) throw fail(422, 'Periksa kembali isian.', errors)
  return values
}

const run = async (sql: string, values?: any[]) => (await pool.query(sql, values)).rows[0]

async function dashboard(guruId: string) {
  const [totals, classes, submissions] = await Promise.all([
    pool.query(
      `SELECT COUNT(DISTINCT c.id)::int total_classes,COUNT(DISTINCT cs.id_student)::int total_students,
              COUNT(DISTINCT CASE WHEN s.nilai_guru IS NULL THEN s.id END)::int ungraded_assignments,
              COUNT(DISTINCT CASE WHEN q.id IS NOT NULL THEN q.id END)::int total_quizzes,
              COUNT(DISTINCT CASE WHEN q.id IS NOT NULL AND qs.skor IS NOT NULL THEN qs.id END)::int completed_quizzes
         FROM classes c
         LEFT JOIN class_students cs ON cs.id_class=c.id
         LEFT JOIN meetings m ON m.id_class=c.id
         LEFT JOIN assignments a ON a.id_meeting=m.id
         LEFT JOIN assignment_submissions s ON s.id_assignment=a.id
         LEFT JOIN quizzes q ON q.id_meeting=m.id
         LEFT JOIN quiz_scores qs ON qs.id_quiz=q.id AND qs.id_student=cs.id_student
        WHERE c.id_guru=$1`,
      [guruId],
    ),
    pool.query(
      `SELECT c.id,c.nama_kelas,c.periode,c.status,co.nama_bahasa AS course_name,COUNT(DISTINCT cs.id_student)::int student_count
         FROM classes c JOIN courses co ON co.id=c.id_course LEFT JOIN class_students cs ON cs.id_class=c.id
        WHERE c.id_guru=$1 AND c.status='aktif'
        GROUP BY c.id,co.nama_bahasa ORDER BY c.created_at DESC`,
      [guruId],
    ),
    pool.query(
      `SELECT s.id,s.id_assignment,s.id_student,s.file_url,s.catatan_siswa,s.submitted_at,u.nama_lengkap AS student_name,a.judul_tugas,c.nama_kelas
         FROM assignment_submissions s
         JOIN assignments a ON a.id=s.id_assignment
         JOIN meetings m ON m.id=a.id_meeting
         JOIN classes c ON c.id=m.id_class
         JOIN users u ON u.id=s.id_student
        WHERE c.id_guru=$1 AND s.nilai_guru IS NULL
        ORDER BY s.submitted_at DESC LIMIT 5`,
      [guruId],
    ),
  ])
  const t = totals.rows[0]
  return {
    ...t,
    incomplete_quizzes: Math.max(0, t.total_quizzes - t.completed_quizzes),
    active_classes: classes.rows,
    recent_submissions: submissions.rows,
  }
}

async function listClasses(guruId: string, page: number) {
  const perPage = 15
  const [count, rows] = await Promise.all([
    pool.query('SELECT COUNT(*)::int total FROM classes WHERE id_guru=$1', [guruId]),
    pool.query(
      `SELECT c.*,co.nama_bahasa course_name,co.kode course_code,COUNT(DISTINCT cs.id_student)::int student_count
         FROM classes c JOIN courses co ON co.id=c.id_course LEFT JOIN class_students cs ON cs.id_class=c.id
        WHERE c.id_guru=$1 GROUP BY c.id,co.nama_bahasa,co.kode ORDER BY c.created_at DESC LIMIT $2 OFFSET $3`,
      [guruId, perPage, (page - 1) * perPage],
    ),
  ])
  return {
    data: rows.rows,
    pagination: {
      page,
      per_page: perPage,
      total: count.rows[0].total,
      last_page: Math.max(1, Math.ceil(count.rows[0].total / perPage)),
    },
  }
}

async function classStudentDetail(classId: string, studentId: string, guruId: string) {
  await classInfo(classId, guruId)
  const student = await pool.query(
    `SELECT u.id,u.nama_lengkap,u.username,u.email,u.tingkat_bahasa,r.kursus_pilihan,r.status registration_status,r.created_at registration_created_at,r.bukti_bayar_url
       FROM class_students cs JOIN users u ON u.id=cs.id_student LEFT JOIN registrations r ON r.user_id=u.id
      WHERE cs.id_class=$1 AND cs.id_student=$2 ORDER BY r.created_at DESC LIMIT 1`,
    [classId, studentId],
  )
  if (!student.rowCount) throw fail(404, 'Murid tidak terdaftar di kelas ini.')
  return { ...student.rows[0], class: await classInfo(classId, guruId) }
}

async function saveMaterialFile(body: any) {
  const allowed: Record<string, string> = {
    'application/pdf': 'pdf',
    'application/x-pdf': 'pdf',
    'application/msword': 'doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  }
  
  const encoded = typeof body.data === 'string' ? body.data : ''
  const mimeType = String(body.mime_type || '').split(';')[0].trim().toLowerCase()
  const mimeExtension = allowed[mimeType]
  const nameExtension = typeof body.filename === 'string' ? pathUtil.extname(body.filename).slice(1).toLowerCase() : ''
  const extension = mimeExtension || (['pdf', 'doc', 'docx'].includes(nameExtension) ? nameExtension : null)

  if (!extension || !encoded) throw fail(422, 'Pilih berkas PDF atau dokumen Word.', { file: ['Format berkas tidak valid.'] })
  const bytes = Buffer.from(encoded, 'base64')
  if (!bytes.length || bytes.length > MAX_UPLOAD_BYTES) throw fail(422, 'Ukuran berkas maksimal 3 MB.', { file: ['Ukuran berkas maksimal 3 MB.'] })
  if (extension === 'pdf' && !bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
    throw fail(422, 'Berkas yang dipilih bukan PDF yang valid.', { file: ['Pilih berkas PDF yang valid.'] })
  }
  const filename = `${randomUUID()}.${extension}`
  const fileId = await saveStoredFile(filename, mimeType, bytes)
  return { file_url: `/api/materials/files/${fileId}.${extension}`, filename, size: bytes.length }
}

async function createMeeting(guruId: string, body: any) {
  const v = validate(body, {
    id_class: { type: 'id' },
    urutan_pertemuan: { type: 'number', min: 1, max: 1000, integer: true },
    judul_pertemuan: { required: true },
    deskripsi: { required: false },
  })
  await classInfo(v.id_class, guruId)
  return run(
    'INSERT INTO meetings(id_class,urutan_pertemuan,judul_pertemuan,deskripsi) VALUES($1,$2,$3,$4) RETURNING *',
    [v.id_class, v.urutan_pertemuan, v.judul_pertemuan, v.deskripsi],
  )
}

async function updateMeeting(meetingId: any, body: any) {
  const v = validate(body, {
    urutan_pertemuan: { type: 'number', min: 1, max: 1000, integer: true },
    judul_pertemuan: { required: true },
    deskripsi: { required: false },
  })
  return run(
    'UPDATE meetings SET urutan_pertemuan=$1,judul_pertemuan=$2,deskripsi=$3,updated_at=NOW() WHERE id=$4 RETURNING *',
    [v.urutan_pertemuan, v.judul_pertemuan, v.deskripsi, meetingId],
  )
}

async function createMeetingMaterial(meetingId: any, body: any) {
  const v = validate(body, {
    judul: { required: true },
    tipe: { type: 'enum', values: ['video', 'pdf', 'doc'] },
    file_url: { required: true },
    deskripsi: { required: false },
  })
  if (v.tipe === 'video' && !/^https?:\/\//i.test(v.file_url)) {
    throw fail(422, 'URL video tidak valid.', { file_url: ['Masukkan URL video yang valid.'] })
  }
  try {
    return await run(
      'INSERT INTO materials(id_meeting,judul,tipe,file_url,deskripsi) VALUES($1,$2,$3,$4,$5) RETURNING *',
      [meetingId, v.judul, v.tipe, v.file_url, v.deskripsi],
    )
  } catch (error) {
    const uploadedId = String(v.file_url).match(/^\/api\/materials\/files\/([a-f0-9-]{36})\./i)?.[1]
    if (uploadedId) await deleteStoredFile(uploadedId).catch(() => {})
    console.error('Gagal menyimpan materi ke database:', error)
    throw fail(500, 'File sudah diunggah, tetapi data materi gagal disimpan. Periksa struktur tabel materials dan koneksi database.')
  }
}

async function listMeetingItems(meeting: any, kind: string) {
  const table = kindTables[kind]
  if (table === 'attendances') {
    return {
      meeting: { id: meeting.id, urutan_pertemuan: meeting.urutan_pertemuan, judul_pertemuan: meeting.judul_pertemuan },
      data: (await pool.query(
        `SELECT u.id id_student,u.nama_lengkap,a.status,a.keterangan,a.checked_at
           FROM class_students cs JOIN users u ON u.id=cs.id_student
           LEFT JOIN attendances a ON a.id_student=u.id AND a.id_meeting=$1
          WHERE cs.id_class=$2 ORDER BY u.nama_lengkap`,
        [meeting.id, meeting.id_class],
      )).rows,
    }
  }
  const rows = await pool.query(`SELECT * FROM ${table} WHERE id_meeting=$1 ORDER BY id`, [meeting.id])
  return { data: rows.rows }
}

async function createMeetingItem(meeting: any, kind: string, body: any, guruId: string) {
  let row
  if (kind === 'quizzes') {
    const v = validate(body, quizSchema)
    await requireSkill(v.id_skill)
    if (v.start_at && v.end_at && new Date(v.end_at) <= new Date(v.start_at)) {
      throw fail(422, 'Waktu berakhir harus setelah waktu mulai.', { end_at: ['Waktu berakhir harus setelah waktu mulai.'] })
    }
    row = await run(
      'INSERT INTO quizzes(id_meeting,id_skill,judul_kuis,deskripsi,durasi,start_at,end_at) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [meeting.id, v.id_skill, v.judul_kuis, v.deskripsi, v.durasi, v.start_at, v.end_at],
    )
  } else if (kind === 'assignments') {
    const v = validate(body, assignmentSchema)
    await requireSkill(v.id_skill)
    row = await run(
      'INSERT INTO assignments(id_meeting,id_skill,judul_tugas,deskripsi,deadline,poin_maksimal) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
      [meeting.id, v.id_skill, v.judul_tugas, v.deskripsi, v.deadline, v.poin_maksimal],
    )
  } else if (kind === 'announcements') {
    const v = validate(body, announcementSchema)
    row = await run(
      'INSERT INTO announcements(id_meeting,id_guru,judul_pengumuman,isi_pengumuman,is_penting,published_at) VALUES($1,$2,$3,$4,$5,NOW()) RETURNING *',
      [meeting.id, guruId, v.judul_pengumuman, v.isi_pengumuman, v.is_penting],
    )
  } else {
    const list = body.attendances
    if (!Array.isArray(list) || !list.length) {
      throw fail(422, 'Daftar kehadiran wajib diisi.', { attendances: ['Daftar kehadiran wajib diisi.'] })
    }
    const students = (await pool.query('SELECT id_student FROM class_students WHERE id_class=$1', [meeting.id_class])).rows.map((x) => String(x.id_student))
    for (const a of list) {
      if (!students.includes(String(a.id_student)) || !['hadir', 'izin', 'sakit', 'alfa'].includes(a.status)) {
        throw fail(422, 'Data kehadiran tidak valid.', { attendances: ['Pilih murid kelas ini dan status kehadiran yang valid.'] })
      }
      await pool.query(
        `INSERT INTO attendances(id_meeting,id_student,status,keterangan,checked_at) VALUES($1,$2,$3,$4,NOW())
         ON CONFLICT(id_meeting,id_student) DO UPDATE SET status=EXCLUDED.status,keterangan=EXCLUDED.keterangan,checked_at=NOW()`,
        [meeting.id, a.id_student, a.status, a.keterangan || null],
      )
    }
    return { attendanceSaved: true }
  }
  return { data: row }
}

async function findKindRow(kind: string, objectId: any, guruId: string) {
  if (kind === 'quizzes') return quiz(objectId, guruId)
  if (kind === 'assignments') return assignment(objectId, guruId)
  return owned('announcements', 'id', objectId, guruId, 'JOIN meetings m ON m.id=x.id_meeting JOIN classes c ON c.id=m.id_class')
}

async function updateKindRow(kind: string, objectId: any, body: any) {
  if (kind === 'quizzes') {
    const v = validate(body, quizSchema)
    await requireSkill(v.id_skill)
    if (v.start_at && v.end_at && new Date(v.end_at) <= new Date(v.start_at)) {
      throw fail(422, 'Waktu berakhir harus setelah waktu mulai.', { end_at: ['Waktu berakhir harus setelah waktu mulai.'] })
    }
    return run(
      'UPDATE quizzes SET id_skill=$1,judul_kuis=$2,deskripsi=$3,durasi=$4,start_at=$5,end_at=$6,updated_at=NOW() WHERE id=$7 RETURNING *',
      [v.id_skill, v.judul_kuis, v.deskripsi, v.durasi, v.start_at, v.end_at, objectId],
    )
  }
  if (kind === 'assignments') {
    const v = validate(body, assignmentSchema)
    await requireSkill(v.id_skill)
    return run(
      'UPDATE assignments SET id_skill=$1,judul_tugas=$2,deskripsi=$3,deadline=$4,poin_maksimal=$5,updated_at=NOW() WHERE id=$6 RETURNING *',
      [v.id_skill, v.judul_tugas, v.deskripsi, v.deadline, v.poin_maksimal, objectId],
    )
  }
  const v = validate(body, announcementSchema)
  return run(
    'UPDATE announcements SET judul_pengumuman=$1,isi_pengumuman=$2,is_penting=$3,updated_at=NOW() WHERE id=$4 RETURNING *',
    [v.judul_pengumuman, v.isi_pengumuman, v.is_penting, objectId],
  )
}

const questionSchema = {
  soal: { required: true, max: 10000 },
  opsi_a: { required: true, max: 10000 },
  opsi_b: { required: true, max: 10000 },
  opsi_c: { required: true, max: 10000 },
  opsi_d: { required: true, max: 10000 },
  kunci_jawaban: { type: 'enum', values: ['A', 'B', 'C', 'D'] },
  poin: { type: 'number', min: 1, max: 100000, integer: true, optional: true, default: 1 },
}

async function createQuestion(quizId: any, body: any) {
  const v = validate(body, questionSchema)
  return run(
    'INSERT INTO questions(id_quiz,soal,opsi_a,opsi_b,opsi_c,opsi_d,kunci_jawaban,poin) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
    [quizId, v.soal, v.opsi_a, v.opsi_b, v.opsi_c, v.opsi_d, v.kunci_jawaban, v.poin],
  )
}

async function updateQuestion(questionId: any, body: any) {
  const v = validate(body, questionSchema)
  return run(
    'UPDATE questions SET soal=$1,opsi_a=$2,opsi_b=$3,opsi_c=$4,opsi_d=$5,kunci_jawaban=$6,poin=$7,updated_at=NOW() WHERE id=$8 RETURNING *',
    [v.soal, v.opsi_a, v.opsi_b, v.opsi_c, v.opsi_d, v.kunci_jawaban, v.poin, questionId],
  )
}

async function assignmentSubmissions(assignmentId: any, guruId: string) {
  const a = await assignment(assignmentId, guruId)
  const data = await pool.query(
    `SELECT u.id id_student,u.nama_lengkap,u.username,s.id submission_id,s.file_url,s.catatan_siswa,s.submitted_at,s.nilai_guru,s.feedback,
            (s.id IS NOT NULL) has_submitted,(s.nilai_guru IS NOT NULL) is_graded
       FROM class_students cs JOIN users u ON u.id=cs.id_student
       LEFT JOIN assignment_submissions s ON s.id_assignment=$1 AND s.id_student=u.id
      WHERE cs.id_class=(SELECT m.id_class FROM meetings m WHERE m.id=$2) ORDER BY u.nama_lengkap`,
    [a.id, a.id_meeting],
  )
  return { assignment: a, students: data.rows }
}

async function sendSubmissionFile(submissionId: any, guruId: string, res: Response) {
  const s = await owned(
    'assignment_submissions',
    'id',
    submissionId,
    guruId,
    'JOIN assignments a ON a.id=x.id_assignment JOIN meetings m ON m.id=a.id_meeting JOIN classes c ON c.id=m.id_class',
  )
  if (!s.file_url) throw fail(404, 'Berkas pengumpulan tidak tersedia.')
  if (String(s.file_url).startsWith('db:')) {
    const stored = await getStoredFile(String(s.file_url).slice(3))
    if (!stored) throw fail(404, 'Berkas pengumpulan tidak ditemukan.')
    const extension = pathUtil.extname(stored.filename).toLowerCase()
    res.writeHead(200, {
      'Content-Type': stored.mime_type,
      'Content-Length': stored.data.length,
      'Content-Disposition': `${stored.mime_type === 'application/pdf' ? 'inline' : 'attachment'}; filename="submission-${submissionId}${extension}"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    })
    res.end(stored.data)
    return
  }
  const filename = pathUtil.basename(s.file_url)
  const file = pathUtil.join(config.backendRoot, 'uploads', 'assignments', filename)
  let bytes
  try {
    bytes = await readFile(file)
  } catch {
    throw fail(404, 'Berkas pengumpulan tidak ditemukan.')
  }
  const extension = pathUtil.extname(filename).toLowerCase()
  const mime = ({
    '.pdf': 'application/pdf',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.txt': 'text/plain',
    '.zip': 'application/zip',
  })[extension] || 'application/octet-stream'
  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': bytes.length,
    'Content-Disposition': `${mime === 'application/pdf' ? 'inline' : 'attachment'}; filename="submission-${submissionId}${extension}"`,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(bytes)
}

async function gradeAssignment(a: any, body: any) {
  const v = validate(body, {
    id_student: { type: 'id' },
    nilai_guru: { type: 'number', min: 0, max: 100 },
    feedback: { required: false, max: 10000 },
  })
  const enrolled = await pool.query(
    'SELECT 1 FROM class_students cs JOIN meetings m ON m.id_class=cs.id_class WHERE m.id=$1 AND cs.id_student=$2',
    [a.id_meeting, v.id_student],
  )
  if (!enrolled.rowCount) throw fail(403, 'Murid bukan peserta kelas ini.')
  return run(
    `INSERT INTO assignment_submissions(id_assignment,id_student,file_url,nilai_guru,feedback,submitted_at)
     VALUES($1,$2,'',$3,$4,NOW())
     ON CONFLICT(id_assignment,id_student) DO UPDATE SET nilai_guru=EXCLUDED.nilai_guru,feedback=EXCLUDED.feedback,updated_at=NOW() RETURNING *`,
    [a.id, v.id_student, v.nilai_guru, v.feedback],
  )
}

async function updateSubmissionGrade(submission: any, body: any) {
  const v = validate(body, {
    nilai_guru: { type: 'number', min: 0, max: 100 },
    feedback: { required: false, max: 10000 },
  })
  return run(
    'UPDATE assignment_submissions SET nilai_guru=$1,feedback=$2,updated_at=NOW() WHERE id=$3 RETURNING *',
    [v.nilai_guru, v.feedback, submission.id],
  )
}

async function classCertificates(classId: string, guruId: string, search: string) {
  const cls = await classInfo(classId, guruId)
  const data = await pool.query(
    `SELECT u.id,u.nama_lengkap,u.username,cert.id certificate_id,cert.nomor_sertifikat,cert.rata_rata_total,
            (SELECT COUNT(*)::int FROM quizzes q JOIN meetings m ON m.id=q.id_meeting WHERE m.id_class=$1) total_quizzes,
            (SELECT COUNT(*)::int FROM assignments a JOIN meetings m ON m.id=a.id_meeting WHERE m.id_class=$1) total_assignments,
            (SELECT COUNT(*)::int FROM quiz_scores qs JOIN quizzes q ON q.id=qs.id_quiz JOIN meetings m ON m.id=q.id_meeting WHERE m.id_class=$1 AND qs.id_student=u.id AND qs.skor IS NOT NULL) completed_quizzes,
            (SELECT COUNT(*)::int FROM assignment_submissions s JOIN assignments a ON a.id=s.id_assignment JOIN meetings m ON m.id=a.id_meeting WHERE m.id_class=$1 AND s.id_student=u.id AND s.nilai_guru IS NOT NULL) completed_assignments
       FROM class_students cs JOIN users u ON u.id=cs.id_student
       LEFT JOIN certificates cert ON cert.id_class=cs.id_class AND cert.id_student=u.id
      WHERE cs.id_class=$1 AND ($2='' OR u.nama_lengkap ILIKE '%'||$2||'%' OR u.username ILIKE '%'||$2||'%')
      ORDER BY u.nama_lengkap`,
    [cls.id, search],
  )
  return { data: data.rows, class: cls }
}

async function classGrades(classId: string, guruId: string) {
  const cls = await classInfo(classId, guruId)
  return { data: await gradeRows(cls.id), class: cls, skills: await skills() }
}

async function classQuizResults(classId: string, guruId: string, search: string) {
  const cls = await classInfo(classId, guruId)
  const data = await pool.query(
    `SELECT qs.id,qs.id_student,qs.id_quiz,qs.skor,qs.total_poin,qs.started_at,qs.completed_at,u.nama_lengkap,q.judul_kuis,m.urutan_pertemuan
       FROM quiz_scores qs JOIN users u ON u.id=qs.id_student JOIN quizzes q ON q.id=qs.id_quiz JOIN meetings m ON m.id=q.id_meeting
      WHERE m.id_class=$1 AND ($2='' OR u.nama_lengkap ILIKE '%'||$2||'%' OR q.judul_kuis ILIKE '%'||$2||'%')
      ORDER BY qs.created_at DESC`,
    [cls.id, search],
  )
  return { data: data.rows, class: cls }
}

async function quizResults(quizId: any, guruId: string, search: string) {
  const q = await quiz(quizId, guruId)
  const data = await pool.query(
    `SELECT qs.*,u.nama_lengkap FROM quiz_scores qs JOIN users u ON u.id=qs.id_student
      WHERE qs.id_quiz=$1 AND ($2='' OR u.nama_lengkap ILIKE '%'||$2||'%') ORDER BY qs.created_at DESC`,
    [q.id, search],
  )
  return { data: data.rows, quiz: q }
}

async function studentGradeView(classId: string, studentId: string, guruId: string) {
  const cls = await classInfo(classId, guruId)
  const enrolled = await pool.query('SELECT 1 FROM class_students WHERE id_class=$1 AND id_student=$2', [cls.id, studentId])
  if (!enrolled.rowCount) throw fail(404, 'Murid tidak terdaftar di kelas ini.')
  return { data: await studentGradeDetails(cls.id, studentId), class: cls }
}

async function studentCertificate(classId: string, studentId: string, guruId: string) {
  const cls = await classInfo(classId, guruId)
  const enrolled = await pool.query('SELECT 1 FROM class_students WHERE id_class=$1 AND id_student=$2', [cls.id, studentId])
  if (!enrolled.rowCount) throw fail(404, 'Murid tidak terdaftar di kelas ini.')
  const result = await pool.query(
    `SELECT cert.*,u.nama_lengkap,co.nama_bahasa course_name,c.periode
       FROM certificates cert JOIN users u ON u.id=cert.id_student JOIN classes c ON c.id=cert.id_class JOIN courses co ON co.id=c.id_course
      WHERE cert.id_class=$1 AND cert.id_student=$2`,
    [cls.id, studentId],
  )
  return result.rows[0] || null
}

async function createCertificate(cls: any, studentId: string, body: any) {
  const v = validate(
    body,
    Object.fromEntries(['reading', 'writing', 'listening', 'speaking', 'grammar'].map((k) => [
      `nilai_${k}`,
      { type: 'number', min: 0, max: 100, optional: true },
    ])),
  )
  const enrolled = await pool.query('SELECT 1 FROM class_students WHERE id_class=$1 AND id_student=$2', [cls.id, studentId])
  if (!enrolled.rowCount) throw fail(404, 'Murid tidak terdaftar di kelas ini.')
  const [counts, done] = await Promise.all([
    pool.query(
      `SELECT (SELECT COUNT(*) FROM quizzes q JOIN meetings m ON m.id=q.id_meeting WHERE m.id_class=$1)::int tq,
              (SELECT COUNT(*) FROM assignments a JOIN meetings m ON m.id=a.id_meeting WHERE m.id_class=$1)::int ta`,
      [cls.id],
    ),
    pool.query(
      `SELECT (SELECT COUNT(*) FROM quiz_scores qs JOIN quizzes q ON q.id=qs.id_quiz JOIN meetings m ON m.id=q.id_meeting WHERE m.id_class=$1 AND qs.id_student=$2 AND qs.skor IS NOT NULL)::int cq,
              (SELECT COUNT(*) FROM assignment_submissions s JOIN assignments a ON a.id=s.id_assignment JOIN meetings m ON m.id=a.id_meeting WHERE m.id_class=$1 AND s.id_student=$2 AND s.nilai_guru IS NOT NULL)::int ca`,
      [cls.id, studentId],
    ),
  ])
  if (done.rows[0].cq < counts.rows[0].tq || done.rows[0].ca < counts.rows[0].ta) {
    throw fail(
      422,
      `Murid belum menyelesaikan semua tugas dan kuis. Progress: ${done.rows[0].cq}/${counts.rows[0].tq} kuis, ${done.rows[0].ca}/${counts.rows[0].ta} tugas.`,
    )
  }
  const values = Object.values(v).filter((x) => x != null)
  const average = values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0
  const serial = `CERT-${String(cls.course_code).toUpperCase()}-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${String((await pool.query('SELECT COUNT(*)::int n FROM certificates')).rows[0].n + 1).padStart(4, '0')}`
  return run(
    `INSERT INTO certificates(id_student,id_class,nomor_sertifikat,tgl_terbit,nilai_reading,nilai_writing,nilai_listening,nilai_speaking,nilai_grammar,rata_rata_total)
     VALUES($1,$2,$3,CURRENT_DATE,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [studentId, cls.id, serial, v.nilai_reading, v.nilai_writing, v.nilai_listening, v.nilai_speaking, v.nilai_grammar, average],
  )
}

async function exportClassGrades(classId: string, guruId: string, res: Response) {
  const cls = await classInfo(classId, guruId)
  const rows = await gradeRows(cls.id)
  const header = ['Nama Murid', 'Reading', 'Writing', 'Listening', 'Speaking', 'Grammar', 'Rata-rata']
  const csv = [header, ...rows.map((r) => [
    r.student.nama_lengkap,
    ...['reading', 'writing', 'listening', 'speaking', 'grammar'].map((s) => r.skill_scores[s] ?? ''),
    r.average,
  ])]
    .map((r) => r.map((x) => `"${String(x ?? '').replaceAll('"', '""')}"`).join(','))
    .join('\r\n')
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="grades-${cls.id}.csv"`,
    'Cache-Control': 'no-store',
  })
  res.end('\ufeff' + csv)
}

export async function handleGuruRequest({ req, res, path, session }: AreaContext): Promise<void> {
  if (session.role !== 'guru') throw fail(403, 'Akses khusus akun Guru.')
  const method = req.method
  const url = new URL(req.url, 'http://localhost')
  const guruId = session.user_id
  let body: any
  const getBody = async () => body ||= await readJson(req, path.endsWith('/material-files') ? 4_300_000 : 1_048_576)
  let match

  try {
    if (method === 'GET' && path === '/api/guru/dashboard') {
      return send(json, res, 200, { data: await dashboard(guruId) })
    }

    if (method === 'GET' && path === '/api/guru/classes') {
      const page = Math.max(1, Number.parseInt(url.searchParams.get('page') as string, 10) || 1)
      return send(json, res, 200, await listClasses(guruId, page))
    }

    if ((match = path.match(/^\/api\/guru\/classes\/(\d+)$/)) && method === 'GET') {
      return send(json, res, 200, { data: await classDetail(match[1], guruId) })
    }

    if ((match = path.match(/^\/api\/guru\/classes\/(\d+)\/students\/(\d+)$/)) && method === 'GET') {
      return send(json, res, 200, { data: await classStudentDetail(match[1], match[2], guruId) })
    }

    if (method === 'GET' && path === '/api/guru/options') {
      return send(json, res, 200, { data: { skills: await skills() } })
    }

    if (method === 'POST' && path === '/api/guru/material-files') {
      return send(json, res, 201, { data: await saveMaterialFile(await getBody()) })
    }

    if (method === 'POST' && path === '/api/guru/classes') {
      const row = await createMeeting(guruId, await getBody())
      return send(json, res, 201, { data: row })
    }

    if ((match = path.match(/^\/api\/guru\/classes\/(\d+)$/)) && method === 'POST') {
      const row = await createMeeting(guruId, { ...await getBody(), id_class: match[1] })
      return send(json, res, 201, { data: row })
    }

    if ((match = path.match(/^\/api\/guru\/meetings\/(\d+)$/))) {
      const m = await meeting(match[1], guruId)
      if (method === 'GET') return send(json, res, 200, { data: m })
      if (method === 'PUT') return send(json, res, 200, { data: await updateMeeting(m.id, await getBody()) })
      if (method === 'DELETE') {
        await pool.query('DELETE FROM meetings WHERE id=$1', [m.id])
        return send(json, res, 200, { message: 'Pertemuan berhasil dihapus.' })
      }
    }

    if ((match = path.match(/^\/api\/guru\/meetings\/(\d+)\/materials$/)) && method === 'POST') {
      const m = await meeting(match[1], guruId)
      const row = await createMeetingMaterial(m.id, await getBody())
      return send(json, res, 201, { data: row })
    }

    if ((match = path.match(/^\/api\/guru\/materials\/(\d+)$/)) && method === 'DELETE') {
      const row = await owned('materials', 'id', match[1], guruId, 'JOIN meetings m ON m.id=x.id_meeting JOIN classes c ON c.id=m.id_class')
      await pool.query('DELETE FROM materials WHERE id=$1', [row.id])
      return send(json, res, 200, { message: 'Materi berhasil dihapus.' })
    }

    if ((match = path.match(/^\/api\/guru\/meetings\/(\d+)\/(quizzes|assignments|announcements|attendance)$/)) && method === 'GET') {
      const m = await meeting(match[1], guruId)
      return send(json, res, 200, await listMeetingItems(m, match[2]))
    }

    if ((match = path.match(/^\/api\/guru\/meetings\/(\d+)\/(quizzes|assignments|announcements|attendance)$/)) && method === 'POST') {
      const m = await meeting(match[1], guruId)
      const result = await createMeetingItem(m, match[2], await getBody(), guruId)
      if (result.attendanceSaved) return send(json, res, 200, { message: 'Kehadiran berhasil disimpan.' })
      return send(json, res, 201, { data: result.data })
    }

    if ((match = path.match(/^\/api\/guru\/(quizzes|assignments|announcements)\/(\d+)$/))) {
      const kind = match[1]
      const objectId = match[2]
      const table = kindTables[kind]
      const row = await findKindRow(kind, objectId, guruId)

      if (method === 'DELETE') {
        await pool.query(`DELETE FROM ${table} WHERE id=$1`, [objectId])
        return send(json, res, 200, { message: 'Data berhasil dihapus.' })
      }

      if (method === 'PUT') {
        return send(json, res, 200, { data: await updateKindRow(kind, objectId, await getBody()) })
      }

      if (method === 'GET' && kind === 'quizzes') {
        return send(json, res, 200, {
          data: { ...row, questions: (await pool.query('SELECT * FROM questions WHERE id_quiz=$1 ORDER BY id', [row.id])).rows },
        })
      }
    }

    if ((match = path.match(/^\/api\/guru\/quizzes\/(\d+)\/questions$/)) && method === 'POST') {
      const q = await quiz(match[1], guruId)
      return send(json, res, 201, { data: await createQuestion(q.id, await getBody()) })
    }

    if ((match = path.match(/^\/api\/guru\/questions\/(\d+)$/))) {
      const q = await owned(
        'questions',
        'id',
        match[1],
        guruId,
        'JOIN quizzes quiz ON quiz.id=x.id_quiz JOIN meetings m ON m.id=quiz.id_meeting JOIN classes c ON c.id=m.id_class',
      )
      if (method === 'GET') return send(json, res, 200, { data: q })
      if (method === 'DELETE') {
        await pool.query('DELETE FROM questions WHERE id=$1', [q.id])
        return send(json, res, 200, { message: 'Soal berhasil dihapus.' })
      }
      if (method === 'PUT') return send(json, res, 200, { data: await updateQuestion(q.id, await getBody()) })
    }

    if ((match = path.match(/^\/api\/guru\/assignments\/(\d+)\/submissions$/)) && method === 'GET') {
      return send(json, res, 200, { data: await assignmentSubmissions(match[1], guruId) })
    }

    if ((match = path.match(/^\/api\/guru\/submissions\/(\d+)\/file$/)) && method === 'GET') {
      return sendSubmissionFile(match[1], guruId, res)
    }

    if ((match = path.match(/^\/api\/guru\/assignments\/(\d+)\/grade$/)) && method === 'POST') {
      const a = await assignment(match[1], guruId)
      return send(json, res, 200, { data: await gradeAssignment(a, await getBody()) })
    }

    if ((match = path.match(/^\/api\/guru\/submissions\/(\d+)\/grade$/)) && method === 'PUT') {
      const s = await owned(
        'assignment_submissions',
        'id',
        match[1],
        guruId,
        'JOIN assignments a ON a.id=x.id_assignment JOIN meetings m ON m.id=a.id_meeting JOIN classes c ON c.id=m.id_class',
      )
      return send(json, res, 200, { data: await updateSubmissionGrade(s, await getBody()) })
    }

    if ((match = path.match(/^\/api\/guru\/classes\/(\d+)\/(grades|certificates|quiz-results)$/)) && method === 'GET') {
      if (match[2] === 'certificates') {
        return send(json, res, 200, await classCertificates(match[1], guruId, url.searchParams.get('search')?.trim() || ''))
      }
      if (match[2] === 'grades') return send(json, res, 200, await classGrades(match[1], guruId))
      return send(json, res, 200, await classQuizResults(match[1], guruId, url.searchParams.get('search')?.trim() || ''))
    }

    if ((match = path.match(/^\/api\/guru\/quizzes\/(\d+)\/results$/)) && method === 'GET') {
      return send(json, res, 200, await quizResults(match[1], guruId, url.searchParams.get('search')?.trim() || ''))
    }

    if ((match = path.match(/^\/api\/guru\/quiz-scores\/(\d+)$/)) && method === 'DELETE') {
      const s = await owned(
        'quiz_scores',
        'id',
        match[1],
        guruId,
        'JOIN quizzes q ON q.id=x.id_quiz JOIN meetings m ON m.id=q.id_meeting JOIN classes c ON c.id=m.id_class',
      )
      await pool.query('DELETE FROM quiz_scores WHERE id=$1', [s.id])
      return send(json, res, 200, { message: 'Hasil kuis berhasil direset.' })
    }

    if ((match = path.match(/^\/api\/guru\/classes\/(\d+)\/students\/(\d+)\/(grades|certificate)$/)) && method === 'GET') {
      if (match[3] === 'certificate') {
        return send(json, res, 200, { data: await studentCertificate(match[1], match[2], guruId) })
      }
      return send(json, res, 200, await studentGradeView(match[1], match[2], guruId))
    }

    if ((match = path.match(/^\/api\/guru\/classes\/(\d+)\/students\/(\d+)\/certificate$/)) && method === 'POST') {
      const cls = await classInfo(match[1], guruId)
      return send(json, res, 201, { data: await createCertificate(cls, match[2], await getBody()) })
    }

    if (method === 'GET' && path === '/api/guru/grades') {
      const data = await pool.query(
        `SELECT c.id,c.nama_kelas,c.periode,co.nama_bahasa course_name,COUNT(DISTINCT cs.id_student)::int student_count
           FROM classes c JOIN courses co ON co.id=c.id_course LEFT JOIN class_students cs ON cs.id_class=c.id
          WHERE c.id_guru=$1 GROUP BY c.id,co.nama_bahasa ORDER BY c.created_at DESC`,
        [guruId],
      )
      return send(json, res, 200, { data: data.rows })
    }

    if (method === 'GET' && path === '/api/guru/quiz-results') {
      const data = await pool.query(
        `SELECT c.id,c.nama_kelas,co.nama_bahasa course_name,COUNT(DISTINCT m.id)::int meeting_count
           FROM classes c JOIN courses co ON co.id=c.id_course LEFT JOIN meetings m ON m.id_class=c.id
          WHERE c.id_guru=$1 GROUP BY c.id,co.nama_bahasa ORDER BY c.created_at DESC`,
        [guruId],
      )
      return send(json, res, 200, { data: data.rows })
    }

    if ((match = path.match(/^\/api\/guru\/classes\/(\d+)\/grades\.csv$/)) && method === 'GET') {
      return exportClassGrades(match[1], guruId, res)
    }

    return send(json, res, 404, { message: 'Endpoint Guru tidak ditemukan.' })
  } catch (error) {
    if (error.status) throw error
    console.error(error)
    throw error
  }
}

async function gradeRows(classId: string) {
  const students = await pool.query(
    'SELECT u.id,u.nama_lengkap,u.username FROM class_students cs JOIN users u ON u.id=cs.id_student WHERE cs.id_class=$1 ORDER BY u.nama_lengkap',
    [classId],
  )
  const skillsList = await skills()
  const result: any[] = []
  for (const student of students.rows) {
    const scores = await pool.query(
      `SELECT sk.kode,AVG(qs.skor)::numeric(6,2) quiz_avg,AVG(ss.nilai_guru)::numeric(6,2) assignment_avg,
              COUNT(DISTINCT qs.id)::int quiz_count,COUNT(DISTINCT ss.id)::int assignment_count
         FROM skills sk
         LEFT JOIN quizzes q ON q.id_skill=sk.id
         LEFT JOIN meetings qm ON qm.id=q.id_meeting AND qm.id_class=$1
         LEFT JOIN quiz_scores qs ON qs.id_quiz=q.id AND qs.id_student=$2 AND qs.skor IS NOT NULL AND qm.id IS NOT NULL
         LEFT JOIN assignments a ON a.id_skill=sk.id
         LEFT JOIN meetings am ON am.id=a.id_meeting AND am.id_class=$1
         LEFT JOIN assignment_submissions ss ON ss.id_assignment=a.id AND ss.id_student=$2 AND ss.nilai_guru IS NOT NULL AND am.id IS NOT NULL
        WHERE (qm.id IS NOT NULL OR am.id IS NOT NULL) GROUP BY sk.id,sk.kode`,
      [classId, student.id],
    )
    const skill_scores: Record<string, any> = {}
    for (const sk of skillsList) {
      const score = scores.rows.find((x) => x.kode === sk.kode)
      const quizAvg = score?.quiz_avg == null ? null : Number(score.quiz_avg)
      const assignmentAvg = score?.assignment_avg == null ? null : Number(score.assignment_avg)
      skill_scores[sk.kode] = quizAvg !== null && assignmentAvg !== null ? (quizAvg + assignmentAvg) / 2 : (quizAvg ?? assignmentAvg)
    }
    const vals = Object.values(skill_scores).filter((x) => x != null)
    const average = vals.length ? Number((vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2)) : null
    const quizCount = Number((await pool.query(
      'SELECT COUNT(*)::int n FROM quiz_scores qs JOIN quizzes q ON q.id=qs.id_quiz JOIN meetings m ON m.id=q.id_meeting WHERE m.id_class=$1 AND qs.id_student=$2 AND qs.skor IS NOT NULL',
      [classId, student.id],
    )).rows[0].n)
    const assignmentCount = Number((await pool.query(
      'SELECT COUNT(*)::int n FROM assignment_submissions ss JOIN assignments a ON a.id=ss.id_assignment JOIN meetings m ON m.id=a.id_meeting WHERE m.id_class=$1 AND ss.id_student=$2 AND ss.nilai_guru IS NOT NULL',
      [classId, student.id],
    )).rows[0].n)
    result.push({ student, skill_scores, average, quiz_count: quizCount, assignment_count: assignmentCount })
  }
  return result
}

async function studentGradeDetails(classId: string, studentId: string) {
  const summary = (await gradeRows(classId)).find((x) => String(x.student.id) === String(studentId))
  const [quiz, assignment, attendance] = await Promise.all([
    pool.query(
      `SELECT q.id,q.judul_kuis,q.id_skill,s.nama_skill,s.kode,m.urutan_pertemuan,qs.skor,qs.completed_at
         FROM meetings m JOIN quizzes q ON q.id_meeting=m.id
         LEFT JOIN skills s ON s.id=q.id_skill
         LEFT JOIN quiz_scores qs ON qs.id_quiz=q.id AND qs.id_student=$2
        WHERE m.id_class=$1 ORDER BY m.urutan_pertemuan,q.id`,
      [classId, studentId],
    ),
    pool.query(
      `SELECT a.id,a.judul_tugas,a.id_skill,s.nama_skill,s.kode,m.urutan_pertemuan,ss.nilai_guru,ss.feedback,ss.submitted_at
         FROM meetings m JOIN assignments a ON a.id_meeting=m.id
         LEFT JOIN skills s ON s.id=a.id_skill
         LEFT JOIN assignment_submissions ss ON ss.id_assignment=a.id AND ss.id_student=$2
        WHERE m.id_class=$1 ORDER BY m.urutan_pertemuan,a.id`,
      [classId, studentId],
    ),
    pool.query(
      `SELECT a.id_meeting,a.status,a.keterangan,a.checked_at,m.urutan_pertemuan
         FROM attendances a JOIN meetings m ON m.id=a.id_meeting
        WHERE m.id_class=$1 AND a.id_student=$2 ORDER BY m.urutan_pertemuan`,
      [classId, studentId],
    ),
  ])
  return { ...summary, quizzes: quiz.rows, assignments: assignment.rows, attendance: attendance.rows }
}
