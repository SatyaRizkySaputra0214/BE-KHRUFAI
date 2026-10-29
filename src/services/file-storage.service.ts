import { randomUUID } from 'node:crypto'
import { pool } from '../config/database.ts'

export const MAX_UPLOAD_BYTES = 3 * 1024 * 1024

export interface StoredFile {
  id: string
  filename: string
  mime_type: string
  data: Buffer
}

export async function saveStoredFile(filename: string, mimeType: string, data: Buffer): Promise<string> {
  const id = randomUUID()
  await pool.query(
    'INSERT INTO stored_files(id,filename,mime_type,data) VALUES($1,$2,$3,$4)',
    [id, filename.slice(0, 255), mimeType.slice(0, 255), data],
  )
  return id
}

export async function getStoredFile(id: string): Promise<StoredFile | null> {
  if (!/^[a-f0-9-]{36}$/i.test(id)) return null
  const result = await pool.query('SELECT id,filename,mime_type,data FROM stored_files WHERE id=$1', [id])
  return result.rows[0] || null
}

export async function deleteStoredFile(id: string): Promise<void> {
  if (/^[a-f0-9-]{36}$/i.test(id)) await pool.query('DELETE FROM stored_files WHERE id=$1', [id])
}

