import { readFile, unlink } from 'node:fs/promises'
import nodePath from 'node:path'
import type { Request, Response } from 'express'
import { pool } from '../config/database.ts'
import { config } from '../config/env.ts'
import { fail, json } from '../utils/http.ts'
import { readJson, readMultipart } from '../utils/request.ts'
import { deleteStoredFile, getStoredFile, MAX_UPLOAD_BYTES, saveStoredFile } from '../services/file-storage.service.ts'
import type { AreaContext } from '../types/http.ts'

const send = (jsonFn: typeof json, res: Response, status: number, data: unknown) => jsonFn(res, status, data)
const grade = (n: number) => n >= 90 ? 'A' : n >= 80 ? 'B' : n >= 70 ? 'C' : n >= 60 ? 'D' : 'E'
const storedPath = (root: string, relative: any) => {
  const base = nodePath.resolve(root)
  const target = nodePath.resolve(base, String(relative || ''))
  return target === base || target.startsWith(base + nodePath.sep) ? target : null
}

async function enrolled(classId: any, studentId: string) {
  const r = await pool.query('SELECT 1 FROM class_students WHERE id_class=$1 AND id_student=$2', [classId, studentId])
  if (!r.rowCount) throw fail(403, 'Anda bukan peserta kelas ini.')
}

async function assignmentRow(id: any) {
  const r = await pool.query(
    `SELECT a.*,s.nama_skill,s.kode skill_code,m.id_class,m.urutan_pertemuan
       FROM assignments a JOIN skills s ON s.id=a.id_skill JOIN meetings m ON m.id=a.id_meeting WHERE a.id=$1`,
    [id],
  )
  if (!r.rowCount) throw fail(404, 'Tugas tidak ditemukan.')
  return r.rows[0]
}

async function quizRow(id: any) {
  const r = await pool.query(
    `SELECT q.*,s.nama_skill,s.kode skill_code,m.id_class,m.urutan_pertemuan
       FROM quizzes q JOIN skills s ON s.id=q.id_skill JOIN meetings m ON m.id=q.id_meeting WHERE q.id=$1`,
    [id],
  )
  if (!r.rowCount) throw fail(404, 'Kuis tidak ditemukan.')
  return r.rows[0]
}

async function classData(classId: any, studentId: string) {
  await enrolled(classId, studentId)
  const r = await pool.query(
    `SELECT c.*,co.nama_bahasa course_name,co.kode course_code,u.nama_lengkap teacher_name
       FROM classes c JOIN courses co ON co.id=c.id_course JOIN users u ON u.id=c.id_guru WHERE c.id=$1`,
    [classId],
  )
  return r.rows[0]
}

async function progressData(studentId: string, classFilter: string | null = null) {
  const classes = (await pool.query(
    `SELECT c.id,c.nama_kelas,c.periode,c.status,c.is_archived,co.nama_bahasa course_name,u.nama_lengkap teacher_name
       FROM class_students cs JOIN classes c ON c.id=cs.id_class JOIN courses co ON co.id=c.id_course JOIN users u ON u.id=c.id_guru
      WHERE cs.id_student=$1 AND ($2::bigint IS NULL OR c.id=$2) ORDER BY c.created_at DESC`,
    [studentId, classFilter],
  )).rows

  const result: any[] = []
  for (const c of classes) {
    const [meetings, skills] = await Promise.all([
      pool.query(
        `SELECT m.id,m.urutan_pertemuan,m.judul_pertemuan,m.deskripsi,
                COALESCE((SELECT json_agg(jsonb_build_object('id',q.id,'judul_kuis',q.judul_kuis,'skor',qs.skor,'completed_at',qs.completed_at,'id_skill',q.id_skill,'nama_skill',sk.nama_skill) ORDER BY q.id) FROM quizzes q JOIN skills sk ON sk.id=q.id_skill LEFT JOIN quiz_scores qs ON qs.id_quiz=q.id AND qs.id_student=$2 WHERE q.id_meeting=m.id),'[]') quizzes,
                COALESCE((SELECT json_agg(jsonb_build_object('id',a.id,'judul_tugas',a.judul_tugas,'nilai_guru',s.nilai_guru,'feedback',s.feedback,'submitted_at',s.submitted_at,'id_skill',a.id_skill,'nama_skill',sk.nama_skill) ORDER BY a.id) FROM assignments a JOIN skills sk ON sk.id=a.id_skill LEFT JOIN assignment_submissions s ON s.id_assignment=a.id AND s.id_student=$2 WHERE a.id_meeting=m.id),'[]') assignments,
                (SELECT jsonb_build_object('status',att.status,'keterangan',att.keterangan,'checked_at',att.checked_at) FROM attendances att WHERE att.id_meeting=m.id AND att.id_student=$2) attendance
           FROM meetings m WHERE m.id_class=$1 ORDER BY m.urutan_pertemuan`,
        [c.id, studentId],
      ),
      pool.query(
        `SELECT sk.kode,AVG(qs.skor) FILTER(WHERE qs.skor IS NOT NULL) qa,AVG(ss.nilai_guru) FILTER(WHERE ss.nilai_guru IS NOT NULL) aa,
                COUNT(DISTINCT qs.id) FILTER(WHERE qs.skor IS NOT NULL)::int qc,
                COUNT(DISTINCT ss.id) FILTER(WHERE ss.nilai_guru IS NOT NULL)::int ac
           FROM skills sk
           LEFT JOIN quizzes q ON q.id_skill=sk.id
           LEFT JOIN meetings qm ON qm.id=q.id_meeting AND qm.id_class=$1
           LEFT JOIN quiz_scores qs ON qs.id_quiz=q.id AND qs.id_student=$2
           LEFT JOIN assignments a ON a.id_skill=sk.id
           LEFT JOIN meetings am ON am.id=a.id_meeting AND am.id_class=$1
           LEFT JOIN assignment_submissions ss ON ss.id_assignment=a.id AND ss.id_student=$2
          WHERE qm.id IS NOT NULL OR am.id IS NOT NULL GROUP BY sk.id,sk.kode`,
        [c.id, studentId],
      ),
    ])

    const items = meetings.rows
    const scoreBySkill: Record<string, any> = {}
    for (const x of skills.rows) {
      scoreBySkill[x.kode] = x.qa != null && x.aa != null
        ? (Number(x.qa) + Number(x.aa)) / 2
        : (x.qa == null ? x.aa : x.qa)
    }
    const vals = Object.values(scoreBySkill).filter((v) => v != null)
    const attendance = items.map((m) => m.attendance).filter(Boolean)
    const present = attendance.filter((x) => ['present', 'hadir'].includes(String(x.status).toLowerCase())).length
    const totals = await pool.query(
      `SELECT (SELECT COUNT(*)::int FROM quizzes q JOIN meetings m ON m.id=q.id_meeting WHERE m.id_class=$1) tq,
              (SELECT COUNT(*)::int FROM assignments a JOIN meetings m ON m.id=a.id_meeting WHERE m.id_class=$1) ta,
              (SELECT COUNT(*)::int FROM quiz_scores qs JOIN quizzes q ON q.id=qs.id_quiz JOIN meetings m ON m.id=q.id_meeting WHERE m.id_class=$1 AND qs.id_student=$2 AND qs.skor IS NOT NULL) cq,
              (SELECT COUNT(*)::int FROM assignment_submissions ss JOIN assignments a ON a.id=ss.id_assignment JOIN meetings m ON m.id=a.id_meeting WHERE m.id_class=$1 AND ss.id_student=$2 AND ss.nilai_guru IS NOT NULL) ca`,
      [c.id, studentId],
    )
    const t = totals.rows[0]
    const totalItems = t.tq + t.ta
    result.push({
      ...c,
      meetings: items,
      class_average: vals.length ? vals.reduce((a, b) => a + Number(b), 0) / vals.length : null,
      skill_scores: scoreBySkill,
      quiz_count: skills.rows.reduce((n, x) => n + x.qc, 0),
      assignment_count: skills.rows.reduce((n, x) => n + x.ac, 0),
      class_progress: totalItems ? Math.round((t.cq + t.ca) / totalItems * 100) : 0,
      attendance_percentage: attendance.length ? Math.round(present / attendance.length * 1000) / 10 : 0,
    })
  }
  return result
}

async function dashboard(studentId: string) {
  const classes = await progressData(studentId)
  const classIds = classes.map((x) => x.id)
  if (!classIds.length) {
    return {
      classes,
      assignments: [],
      announcements: [],
      overall_average: null,
      quiz_average: null,
      assignment_average: null,
      attendance_percentage: 0,
      total_attendance: 0,
      present_count: 0,
    }
  }
  const [assignments, announcements, averages, attendance] = await Promise.all([
    pool.query(
      `SELECT a.*,s.nama_skill skill_name,s.kode skill_code,m.id_class,m.urutan_pertemuan,c.nama_kelas
         FROM assignments a JOIN meetings m ON m.id=a.id_meeting JOIN classes c ON c.id=m.id_class JOIN skills s ON s.id=a.id_skill
         LEFT JOIN assignment_submissions sub ON sub.id_assignment=a.id AND sub.id_student=$1
        WHERE c.id=ANY($2::bigint[]) AND sub.id IS NULL ORDER BY a.deadline ASC NULLS LAST LIMIT 4`,
      [studentId, classIds],
    ),
    pool.query(
      `SELECT a.*,m.id_class,m.urutan_pertemuan,c.nama_kelas,u.nama_lengkap teacher_name,
              EXISTS(SELECT 1 FROM announcement_reads ar WHERE ar.id_announcement=a.id AND ar.id_user=$1) is_read
         FROM announcements a JOIN meetings m ON m.id=a.id_meeting JOIN classes c ON c.id=m.id_class JOIN users u ON u.id=a.id_guru
        WHERE c.id=ANY($2::bigint[]) AND NOT EXISTS(SELECT 1 FROM announcement_reads ar WHERE ar.id_announcement=a.id AND ar.id_user=$1)
        ORDER BY a.is_penting DESC,a.published_at DESC LIMIT 10`,
      [studentId, classIds],
    ),
    pool.query(
      `SELECT (SELECT AVG(qs.skor) FROM quiz_scores qs JOIN quizzes q ON q.id=qs.id_quiz JOIN meetings m ON m.id=q.id_meeting WHERE m.id_class=ANY($1::bigint[]) AND qs.id_student=$2) quiz_average,
              (SELECT AVG(s.nilai_guru) FROM assignment_submissions s JOIN assignments a ON a.id=s.id_assignment JOIN meetings m ON m.id=a.id_meeting WHERE m.id_class=ANY($1::bigint[]) AND s.id_student=$2 AND s.nilai_guru IS NOT NULL) assignment_average`,
      [classIds, studentId],
    ),
    pool.query(
      `SELECT COUNT(*)::int total,COUNT(*) FILTER(WHERE status IN ('present','hadir'))::int present
         FROM attendances a JOIN meetings m ON m.id=a.id_meeting WHERE m.id_class=ANY($1::bigint[]) AND a.id_student=$2`,
      [classIds, studentId],
    ),
  ])
  const qa = averages.rows[0].quiz_average == null ? null : Number(averages.rows[0].quiz_average)
  const aa = averages.rows[0].assignment_average == null ? null : Number(averages.rows[0].assignment_average)
  const at = attendance.rows[0]
  
  return {
    classes,
    assignments: assignments.rows,
    announcements: announcements.rows,
    quiz_average: qa,
    assignment_average: aa,
    overall_average: qa != null && aa != null ? Math.round((qa + aa) / 2 * 100) / 100 : qa ?? aa,
    attendance_percentage: at.total ? Math.round(at.present / at.total * 10000) / 100 : 0,
    total_attendance: at.total,
    present_count: at.present,
  }
}

async function classOverview(classId: string, userId: string) {
  const cls = await classData(classId, userId)
  const [meetings, stats] = await Promise.all([
    pool.query(
      `SELECT m.*,
              (SELECT COUNT(*)::int FROM materials x WHERE x.id_meeting=m.id) material_count,
              (SELECT COUNT(*)::int FROM quizzes x WHERE x.id_meeting=m.id) quiz_count,
              (SELECT COUNT(*)::int FROM assignments x WHERE x.id_meeting=m.id) assignment_count,
              COALESCE((SELECT json_agg(to_jsonb(a) ORDER BY a.is_penting DESC,a.published_at DESC) FROM announcements a WHERE a.id_meeting=m.id),'[]') announcements
         FROM meetings m WHERE m.id_class=$1 ORDER BY m.urutan_pertemuan`,
      [cls.id],
    ),
    pool.query(
      `SELECT (SELECT COUNT(*)::int FROM meetings WHERE id_class=$1) meetings,
              (SELECT COUNT(*)::int FROM materials ma JOIN meetings mm ON mm.id=ma.id_meeting WHERE mm.id_class=$1) materials,
              (SELECT COUNT(*)::int FROM quizzes q JOIN meetings mm ON mm.id=q.id_meeting WHERE mm.id_class=$1) quizzes,
              (SELECT COUNT(*)::int FROM assignments a JOIN meetings mm ON mm.id=a.id_meeting WHERE mm.id_class=$1) assignments,
              (SELECT COUNT(*)::int FROM quiz_scores qs JOIN quizzes q ON q.id=qs.id_quiz JOIN meetings mm ON mm.id=q.id_meeting WHERE mm.id_class=$1 AND qs.id_student=$2 AND qs.skor IS NOT NULL) completed_quizzes,
              (SELECT COUNT(*)::int FROM assignment_submissions s JOIN assignments a ON a.id=s.id_assignment JOIN meetings mm ON mm.id=a.id_meeting WHERE mm.id_class=$1 AND s.id_student=$2 AND s.nilai_guru IS NOT NULL) completed_assignments`,
      [cls.id, userId],
    ),
  ])
  const s = stats.rows[0]
  const total = s.quizzes + s.assignments
  return {
    ...cls,
    meetings: meetings.rows,
    stats: { ...s, progress: total ? Math.round((s.completed_quizzes + s.completed_assignments) / total * 100) : 0 },
  }
}

async function meetingOverview(meetingId: string, userId: string) {
  const auth = await pool.query(
    'SELECT m.id,m.id_class FROM meetings m JOIN class_students cs ON cs.id_class=m.id_class WHERE m.id=$1 AND cs.id_student=$2',
    [meetingId, userId],
  )
  if (!auth.rowCount) throw fail(404, 'Pertemuan tidak ditemukan atau Anda tidak terdaftar di kelas ini.')
  const [meeting, materials, quizzes, assignments, announcements] = await Promise.all([
    pool.query(
      `SELECT m.*,c.nama_kelas,co.nama_bahasa course_name
         FROM meetings m JOIN classes c ON c.id=m.id_class JOIN courses co ON co.id=c.id_course WHERE m.id=$1`,
      [meetingId],
    ),
    pool.query('SELECT * FROM materials WHERE id_meeting=$1 ORDER BY id', [meetingId]),
    pool.query(
      `SELECT q.*,sk.nama_skill,sk.kode skill_code,qs.id score_id,qs.skor,qs.started_at,qs.completed_at
         FROM quizzes q JOIN skills sk ON sk.id=q.id_skill
         LEFT JOIN quiz_scores qs ON qs.id_quiz=q.id AND qs.id_student=$2
        WHERE q.id_meeting=$1 ORDER BY q.id`,
      [meetingId, userId],
    ),
    pool.query(
      `SELECT a.*,sk.nama_skill,sk.kode skill_code,s.id submission_id,s.file_url,s.catatan_siswa,s.nilai_guru,s.feedback,s.submitted_at
         FROM assignments a JOIN skills sk ON sk.id=a.id_skill
         LEFT JOIN assignment_submissions s ON s.id_assignment=a.id AND s.id_student=$2
        WHERE a.id_meeting=$1 ORDER BY a.id`,
      [meetingId, userId],
    ),
    pool.query(
      `SELECT a.*,u.nama_lengkap teacher_name,
              EXISTS(SELECT 1 FROM announcement_reads ar WHERE ar.id_announcement=a.id AND ar.id_user=$2) is_read
         FROM announcements a JOIN users u ON u.id=a.id_guru
        WHERE a.id_meeting=$1 ORDER BY a.is_penting DESC,a.published_at DESC`,
      [meetingId, userId],
    ),
  ])
  return {
    ...meeting.rows[0],
    materials: materials.rows,
    quizzes: quizzes.rows,
    assignments: assignments.rows,
    announcements: announcements.rows,
  }
}

async function markAnnouncementRead(announcementId: string, userId: string) {
  const r = await pool.query(
    `INSERT INTO announcement_reads(id_announcement,id_user,read_at)
     SELECT a.id,$2,NOW() FROM announcements a JOIN meetings m ON m.id=a.id_meeting JOIN class_students cs ON cs.id_class=m.id_class AND cs.id_student=$2
      WHERE a.id=$1 ON CONFLICT(id_announcement,id_user) DO UPDATE SET read_at=NOW() RETURNING *`,
    [announcementId, userId],
  )
  if (!r.rowCount) throw fail(404, 'Pengumuman tidak ditemukan atau bukan dari kelas Anda.')
  return r.rows[0]
}

async function sendMaterialFile(materialId: string, userId: string, res: Response) {
  const r = await pool.query(
    `SELECT ma.file_url FROM materials ma JOIN meetings m ON m.id=ma.id_meeting JOIN class_students cs ON cs.id_class=m.id_class
      WHERE ma.id=$1 AND cs.id_student=$2`,
    [materialId, userId],
  )
  if (!r.rowCount) throw fail(404, 'Materi tidak ditemukan atau tidak dapat diakses.')
  const name = r.rows[0].file_url
  if (/^https?:\/\//i.test(name)) {
    res.writeHead(302, { Location: name, 'Cache-Control': 'no-store' })
    res.end()
    return
  }
  const apiFile = name.match(/^\/api\/materials\/files\/([a-f0-9-]+\.(?:pdf|doc|docx))$/i)
  const base = apiFile ? config.materialUploadDir : (config.legacyStoragePublicDir || nodePath.join(config.backendRoot, 'uploads', 'materials'))
  const file = storedPath(base, apiFile ? apiFile[1] : name)
  if (!file) throw fail(404, 'Berkas materi tidak ditemukan.')
  let bytes
  try {
    bytes = await readFile(file)
  } catch {
    throw fail(404, 'Berkas materi tidak ditemukan.')
  }
  res.writeHead(200, {
    'Content-Type': file.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${nodePath.basename(file)}"`,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(bytes)
}

async function quizDeadline(q: any, userId: string) {
  const now = Date.now()
  const start = q.start_at ? new Date(q.start_at).getTime() : null
  const end = q.end_at ? new Date(q.end_at).getTime() : null
  const at = (await pool.query('SELECT started_at FROM quiz_scores WHERE id_quiz=$1 AND id_student=$2', [q.id, userId])).rows[0]
  const durationEnd = at?.started_at && q.durasi ? new Date(at.started_at).getTime() + q.durasi * 60000 : null
  const deadline = end && durationEnd ? Math.min(end, durationEnd) : end || durationEnd
  return { end_at: deadline ? Math.floor(deadline / 1000) : null, is_ended: deadline != null && now > deadline }
}

async function takeQuiz(q: any, userId: string) {
  const now = Date.now()
  const start = q.start_at ? new Date(q.start_at).getTime() : null
  const end = q.end_at ? new Date(q.end_at).getTime() : null
  if (end && now > end) throw fail(410, 'Kuis telah berakhir.')
  if (start && now < start) throw fail(409, 'Kuis belum dimulai.')
  let attempt = (await pool.query('SELECT * FROM quiz_scores WHERE id_quiz=$1 AND id_student=$2', [q.id, userId])).rows[0]
  if (attempt?.skor != null) return { completed: true, score_id: attempt.id }
  if (!attempt) {
    attempt = (await pool.query(
      `INSERT INTO quiz_scores(id_quiz,id_student,started_at) VALUES($1,$2,NOW())
       ON CONFLICT(id_quiz,id_student) DO UPDATE SET id_quiz=EXCLUDED.id_quiz RETURNING *`,
      [q.id, userId],
    )).rows[0]
  }
  const durationEnd = q.durasi ? new Date(attempt.started_at).getTime() + q.durasi * 60000 : null
  const deadline = end && durationEnd ? Math.min(end, durationEnd) : end || durationEnd
  const questions = (await pool.query('SELECT id,soal,opsi_a,opsi_b,opsi_c,opsi_d FROM questions WHERE id_quiz=$1 ORDER BY id', [q.id])).rows
  return { quiz: q, attempt, deadline: deadline ? Math.floor(deadline / 1000) : null, questions }
}

async function submitQuiz(q: any, userId: string, req: Request) {
  const body = await readJson(req)
  const answers = body.answers ?? {}
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
    throw fail(422, 'Format jawaban tidak valid.', { answers: ['Jawaban harus berupa objek.'] })
  }
  for (const [key, value] of Object.entries(answers) as [string, any][]) {
    if (!/^\d+$/.test(key) || !['A', 'B', 'C', 'D', null].includes(value)) {
      throw fail(422, 'Jawaban tidak valid.', { answers: ['Jawaban hanya boleh A, B, C, atau D.'] })
    }
  }

  const client = await pool.connect()
  let saved
  try {
    await client.query('BEGIN')
    const attempt = (await client.query('SELECT * FROM quiz_scores WHERE id_quiz=$1 AND id_student=$2 FOR UPDATE', [q.id, userId])).rows[0]
    if (!attempt) throw fail(409, 'Data pengerjaan kuis tidak ditemukan.')
    if (attempt.skor != null) {
      saved = attempt
      await client.query('COMMIT')
    } else {
      const deadlineAt = q.end_at ? new Date(q.end_at).getTime() : null
      const durationAt = attempt.started_at && q.durasi ? new Date(attempt.started_at).getTime() + q.durasi * 60000 : null
      const deadline = deadlineAt && durationAt ? Math.min(deadlineAt, durationAt) : deadlineAt || durationAt
      if (deadline && Date.now() > deadline) throw fail(410, 'Waktu pengerjaan kuis telah habis.')
      const questions = (await client.query('SELECT id,kunci_jawaban,poin FROM questions WHERE id_quiz=$1 ORDER BY id', [q.id])).rows
      if (!questions.length) throw fail(422, 'Kuis belum memiliki soal.')
      const correct = questions.filter((x) => answers[x.id] === x.kunci_jawaban)
      const score = Math.round(correct.length / questions.length * 100)
      const points = correct.reduce((n, x) => n + (x.poin ?? 1), 0)
      saved = (await client.query(
        'UPDATE quiz_scores SET skor=$1,total_poin=$2,completed_at=NOW(),updated_at=NOW() WHERE id=$3 AND skor IS NULL RETURNING *',
        [score, points, attempt.id],
      )).rows[0]
      await client.query('COMMIT')
    }
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }
  return saved
}

async function quizScore(scoreId: string, userId: string) {
  const r = await pool.query(
    `SELECT qs.*,q.judul_kuis,q.deskripsi,q.durasi,q.id_skill,sk.nama_skill,m.id_class,m.urutan_pertemuan
       FROM quiz_scores qs JOIN quizzes q ON q.id=qs.id_quiz JOIN skills sk ON sk.id=q.id_skill JOIN meetings m ON m.id=q.id_meeting
      WHERE qs.id=$1 AND qs.id_student=$2`,
    [scoreId, userId],
  )
  if (!r.rowCount) throw fail(404, 'Hasil kuis tidak ditemukan.')
  return r.rows[0]
}

async function assignmentDetail(assignmentId: string, userId: string) {
  const a = await assignmentRow(assignmentId)
  await enrolled(a.id_class, userId)
  const s = await pool.query(
    'SELECT id,file_url,catatan_siswa,nilai_guru,feedback,submitted_at FROM assignment_submissions WHERE id_assignment=$1 AND id_student=$2',
    [a.id, userId],
  )
  return { assignment: a, submission: s.rows[0] || null }
}

async function submitAssignment(a: any, userId: string, req: Request) {
  const { fields, files } = await readMultipart(req, MAX_UPLOAD_BYTES)
  const f = files.file_upload
  const note = fields.catatan_siswa || ''
  if (!f) throw fail(422, 'Pilih berkas jawaban.', { file_upload: ['Berkas jawaban wajib diisi.'] })
  if (note.length > 500) throw fail(422, 'Catatan maksimal 500 karakter.', { catatan_siswa: ['Catatan maksimal 500 karakter.'] })
  if (f.size > MAX_UPLOAD_BYTES) throw fail(422, 'Ukuran berkas maksimal 3 MB.', { file_upload: ['Ukuran berkas maksimal 3 MB.'] })
  const allowed = new Set([
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'image/jpeg',
    'image/png',
    'text/plain',
    'application/zip',
  ])
  if (!allowed.has(f.mime_type)) {
    throw fail(422, 'Format berkas tidak didukung.', { file_upload: ['Gunakan PDF, Word, gambar, teks, atau ZIP.'] })
  }

  const storedId = await saveStoredFile(f.filename, f.mime_type, f.data)
  const fileReference = `db:${storedId}`

  const client = await pool.connect()
  let record
  try {
    await client.query('BEGIN')
    const prev = await client.query(
      'SELECT id,file_url FROM assignment_submissions WHERE id_assignment=$1 AND id_student=$2 FOR UPDATE',
      [a.id, userId],
    )
    record = (await client.query(
      `INSERT INTO assignment_submissions(id_assignment,id_student,file_url,catatan_siswa,submitted_at)
       VALUES($1,$2,$3,$4,NOW())
       ON CONFLICT(id_assignment,id_student) DO UPDATE SET file_url=EXCLUDED.file_url,catatan_siswa=EXCLUDED.catatan_siswa,submitted_at=NOW(),updated_at=NOW() RETURNING *`,
      [a.id, userId, fileReference, note || null],
    )).rows[0]
    await client.query('COMMIT')
    const previousFile = String(prev.rows[0]?.file_url || '')
    if (previousFile.startsWith('db:')) await deleteStoredFile(previousFile.slice(3))
    else if (previousFile) await unlink(nodePath.join(config.backendRoot, 'uploads', 'assignments', nodePath.basename(previousFile))).catch(() => {})
  } catch (e) {
    await client.query('ROLLBACK')
    await deleteStoredFile(storedId).catch(() => {})
    throw e
  } finally {
    client.release()
  }
  return record
}

async function deleteSubmission(a: any, userId: string) {
  const r = await pool.query(
    'DELETE FROM assignment_submissions WHERE id_assignment=$1 AND id_student=$2 AND nilai_guru IS NULL RETURNING file_url',
    [a.id, userId],
  )
  if (!r.rowCount) {
    const exists = await pool.query('SELECT 1 FROM assignment_submissions WHERE id_assignment=$1 AND id_student=$2', [a.id, userId])
    if (exists.rowCount) throw fail(409, 'Tugas yang sudah dinilai tidak dapat dihapus.')
    throw fail(404, 'Belum ada jawaban untuk dihapus.')
  }
  const saved = r.rows[0].file_url
  if (String(saved).startsWith('db:')) {
    await deleteStoredFile(String(saved).slice(3))
    return
  }
  const candidates = [
    storedPath(nodePath.join(config.backendRoot, 'uploads', 'assignments'), nodePath.basename(saved)),
    config.legacyStoragePublicDir ? storedPath(config.legacyStoragePublicDir, saved) : null,
  ].filter((v): v is string => Boolean(v))
  for (const file of candidates) await unlink(file).catch(() => {})
}

async function sendSubmissionFile(submissionId: string, userId: string, res: Response) {
  const r = await pool.query('SELECT file_url FROM assignment_submissions WHERE id=$1 AND id_student=$2', [submissionId, userId])
  if (!r.rowCount) throw fail(404, 'Berkas tidak ditemukan.')
  const saved = String(r.rows[0].file_url)
  if (saved.startsWith('db:')) {
    const file = await getStoredFile(saved.slice(3))
    if (!file) throw fail(404, 'Berkas tidak ditemukan.')
    res.writeHead(200, {
      'Content-Type': file.mime_type,
      'Content-Disposition': `attachment; filename="${nodePath.basename(file.filename)}"`,
      'Content-Length': file.data.length,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    })
    res.end(file.data)
    return
  }
  let bytes
  const filename = nodePath.basename(saved)
  const candidates = [
    storedPath(nodePath.join(config.backendRoot, 'uploads', 'assignments'), filename),
    config.legacyStoragePublicDir ? storedPath(config.legacyStoragePublicDir, r.rows[0].file_url) : null,
  ].filter((v): v is string => Boolean(v))
  let found
  for (const candidate of candidates) {
    try {
      bytes = await readFile(candidate)
      found = candidate
      break
    } catch {}
  }
  if (!found) throw fail(404, 'Berkas tidak ditemukan.')
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${nodePath.basename(found)}"`,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(bytes)
}

async function listCertificates(userId: string) {
  const r = await pool.query(
    `SELECT cert.*,c.nama_kelas,c.periode,co.nama_bahasa course_name,co.kode course_code,u.nama_lengkap teacher_name,stu.nama_lengkap student_name
       FROM certificates cert JOIN classes c ON c.id=cert.id_class JOIN courses co ON co.id=c.id_course
       JOIN users u ON u.id=c.id_guru JOIN users stu ON stu.id=cert.id_student
      WHERE cert.id_student=$1 ORDER BY cert.created_at DESC`,
    [userId],
  )
  return r.rows.map((x) => ({ ...x, grade: grade(Number(x.rata_rata_total || 0)) }))
}

async function certificateDetail(certificateId: string, userId: string) {
  const r = await pool.query(
    `SELECT cert.*,c.nama_kelas,c.periode,co.nama_bahasa course_name,co.kode course_code,u.nama_lengkap teacher_name,stu.nama_lengkap student_name
       FROM certificates cert JOIN classes c ON c.id=cert.id_class JOIN courses co ON co.id=c.id_course
       JOIN users u ON u.id=c.id_guru JOIN users stu ON stu.id=cert.id_student
      WHERE cert.id=$1 AND cert.id_student=$2`,
    [certificateId, userId],
  )
  if (!r.rowCount) throw fail(404, 'Sertifikat tidak ditemukan.')
  const x = r.rows[0]
  return { ...x, grade: grade(Number(x.rata_rata_total || 0)) }
}

async function downloadCertificate(certificateId: string, userId: string, res: Response) {
  const r = await pool.query('SELECT file_pdf_url FROM certificates WHERE id=$1 AND id_student=$2', [certificateId, userId])
  if (!r.rowCount) throw fail(404, 'Sertifikat tidak ditemukan.')
  if (r.rows[0].file_pdf_url) {
    const file = storedPath(
      config.legacyStoragePublicDir || nodePath.join(config.backendRoot, 'uploads'),
      r.rows[0].file_pdf_url,
    )
    if (!file) throw fail(404, 'Berkas sertifikat tidak ditemukan.')
    let bytes
    try {
      bytes = await readFile(file)
    } catch {
      throw fail(404, 'Berkas sertifikat tidak ditemukan.')
    }
    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="certificate-${certificateId}.pdf"`,
      'Cache-Control': 'private, no-store',
    })
    res.end(bytes)
    return null
  }
  return { print: true, id: certificateId }
}

export async function handleStudentRequest({ req, res, path, session }: AreaContext): Promise<void> {
  const userId = session.user_id

  if (req.method === 'GET' && path === '/api/murid/dashboard') return send(json, res, 200, { data: await dashboard(userId) })
  if (req.method === 'GET' && path === '/api/murid/classes') return send(json, res, 200, { data: await progressData(userId) })

  let m
  if ((m = path.match(/^\/api\/murid\/classes\/(\d+)$/)) && req.method === 'GET') {
    return send(json, res, 200, { data: await classOverview(m[1], userId) })
  }

  if ((m = path.match(/^\/api\/murid\/meetings\/(\d+)$/)) && req.method === 'GET') {
    return send(json, res, 200, { data: await meetingOverview(m[1], userId) })
  }

  if ((m = path.match(/^\/api\/murid\/announcements\/(\d+)\/read$/)) && req.method === 'POST') {
    return send(json, res, 200, { data: await markAnnouncementRead(m[1], userId) })
  }

  if ((m = path.match(/^\/api\/murid\/materials\/(\d+)\/file$/)) && req.method === 'GET') {
    return sendMaterialFile(m[1], userId, res)
  }

  if ((m = path.match(/^\/api\/murid\/quizzes\/(\d+)\/(take|deadline)$/))) {
    const q = await quizRow(m[1])
    await enrolled(q.id_class, userId)
    if (m[2] === 'deadline' && req.method === 'GET') return send(json, res, 200, await quizDeadline(q, userId))
    if (m[2] === 'take' && req.method === 'GET') return send(json, res, 200, { data: await takeQuiz(q, userId) })
  }

  if ((m = path.match(/^\/api\/murid\/quizzes\/(\d+)\/submit$/)) && req.method === 'POST') {
    const q = await quizRow(m[1])
    await enrolled(q.id_class, userId)
    return send(json, res, 200, { data: await submitQuiz(q, userId, req) })
  }

  if ((m = path.match(/^\/api\/murid\/quiz-scores\/(\d+)$/)) && req.method === 'GET') {
    return send(json, res, 200, { data: await quizScore(m[1], userId) })
  }

  if ((m = path.match(/^\/api\/murid\/assignments\/(\d+)$/)) && req.method === 'GET') {
    return send(json, res, 200, { data: await assignmentDetail(m[1], userId) })
  }

  if ((m = path.match(/^\/api\/murid\/assignments\/(\d+)\/submit$/)) && req.method === 'POST') {
    const a = await assignmentRow(m[1])
    await enrolled(a.id_class, userId)
    return send(json, res, 200, { data: await submitAssignment(a, userId, req) })
  }

  if ((m = path.match(/^\/api\/murid\/assignments\/(\d+)\/submission$/)) && req.method === 'DELETE') {
    const a = await assignmentRow(m[1])
    await enrolled(a.id_class, userId)
    await deleteSubmission(a, userId)
    return send(json, res, 200, { message: 'Jawaban tugas berhasil dihapus.' })
  }

  if ((m = path.match(/^\/api\/murid\/submissions\/(\d+)\/file$/)) && req.method === 'GET') {
    return sendSubmissionFile(m[1], userId, res)
  }

  if (req.method === 'GET' && path === '/api/murid/progress') {
    return send(json, res, 200, { data: await progressData(userId, new URL(req.url, 'http://localhost').searchParams.get('class_id') || null) })
  }

  if (req.method === 'GET' && path === '/api/murid/certificates') {
    return send(json, res, 200, { data: await listCertificates(userId) })
  }

  if ((m = path.match(/^\/api\/murid\/certificates\/(\d+)$/)) && req.method === 'GET') {
    return send(json, res, 200, { data: await certificateDetail(m[1], userId) })
  }

  if ((m = path.match(/^\/api\/murid\/certificates\/(\d+)\/download$/)) && req.method === 'GET') {
    const printInfo = await downloadCertificate(m[1], userId, res)
    if (printInfo) return send(json, res, 200, { data: printInfo })
    return
  }

  return send(json, res, 404, { message: 'Endpoint Murid tidak ditemukan.' })
}
