import type { Request } from 'express'

export interface UploadedFile {
  filename: string
  mime_type: string
  data: Buffer
  size: number
}

export interface MultipartBody {
  fields: Record<string, string>
  files: Record<string, UploadedFile>
}

export async function readJson(req: Request, maxBytes = 1_048_576): Promise<any> {
  let data = ''
  for await (const chunk of req) {
    data += chunk
    if (data.length > maxBytes) {
      throw Object.assign(new Error('Ukuran permintaan terlalu besar.'), { status: 413 })
    }
  }
  try {
    return data ? JSON.parse(data) : {}
  } catch {
    throw Object.assign(new Error('Format JSON tidak valid.'), { status: 400 })
  }
}

export async function readMultipart(req: Request, maxBytes = 10 * 1024 * 1024): Promise<MultipartBody> {
  const contentType = req.headers['content-type'] || ''
  const boundary = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i)?.slice(1).find(Boolean)
  if (!contentType.toLowerCase().startsWith('multipart/form-data') || !boundary) {
    throw Object.assign(new Error('Format unggahan tidak valid.'), { status: 400 })
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes + 128 * 1024) {
      throw Object.assign(new Error('Ukuran permintaan terlalu besar.'), { status: 413 })
    }
    chunks.push(chunk)
  }
  const raw = Buffer.concat(chunks)
  const fields: Record<string, string> = {}
  const files: Record<string, UploadedFile> = {}
  for (const part of raw.toString('latin1').split(`--${boundary}`).slice(1, -1)) {
    const normalized = part.replace(/^\r\n/, '').replace(/\r\n$/, '')
    const split = normalized.indexOf('\r\n\r\n')
    if (split < 0) continue
    const headers = normalized.slice(0, split)
    const disposition = headers.match(/content-disposition:\s*form-data;([^\r\n]+)/i)?.[1] || ''
    const field = disposition.match(/name="([^"]+)"/)?.[1]
    if (!field) continue
    const filename = disposition.match(/filename="([^"]*)"/)?.[1]
    const bodyStart = split + 4
    const bodyEnd = normalized.length
    // Latin1 preserves each input byte when re-encoded; remove only multipart framing CRLF.
    const value = normalized.slice(bodyStart, bodyEnd).replace(/\r\n$/, '')
    if (filename !== undefined) {
      const mime = headers.match(/content-type:\s*([^\r\n]+)/i)?.[1]?.trim().toLowerCase() || 'application/octet-stream'
      const data = Buffer.from(value, 'latin1')
      files[field] = {
        filename: filename.replace(/[\\/]/g, '_'),
        mime_type: mime,
        data,
        size: data.length,
      }
    } else {
      fields[field] = value
    }
  }
  return { fields, files }
}
