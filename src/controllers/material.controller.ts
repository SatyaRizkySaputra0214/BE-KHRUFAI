import { readFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import type { Request, Response } from 'express'
import { config } from '../config/env.ts'
import { json } from '../utils/http.ts'
import { getStoredFile } from '../services/file-storage.service.ts'

const materialFilePattern = /^[a-f0-9-]+\.(?:pdf|doc|docx)$/i

export async function downloadMaterial(req: Request, res: Response): Promise<void> {
  const session = req.authSession
  const filename = String(req.params.filename || '')
  if (!materialFilePattern.test(filename) || !session?.user_id) return json(res, 404, { message: 'Endpoint tidak ditemukan.' })
  if (session.role === 'murid') return json(res, 403, { message: 'Gunakan tautan materi dari kelas yang Anda ikuti.' })
  const safeName = basename(filename)
  const stored = await getStoredFile(safeName.split('.')[0])
  if (stored) {
    res.writeHead(200, {
      'Content-Type': stored.mime_type,
      'Content-Length': stored.data.length,
      'Content-Disposition': `inline; filename="${basename(stored.filename)}"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    })
    res.end(stored.data)
    return
  }
  try {
    const bytes = await readFile(resolve(join(config.materialUploadDir, safeName)))
    const type = safeName.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': bytes.length,
      'Content-Disposition': `inline; filename="${safeName}"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    })
    res.end(bytes)
    return
  } catch { return json(res, 404, { message: 'Berkas materi tidak ditemukan.' }) }
}
