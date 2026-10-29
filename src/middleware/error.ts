import type { ErrorRequestHandler, RequestHandler } from 'express'
import { json } from '../utils/http.ts'

export const notFoundHandler: RequestHandler = (_req, res) => {
  json(res, 404, { message: 'Endpoint tidak ditemukan.' })
}

export const errorHandler: ErrorRequestHandler = (error, _req, res, next) => {
  console.error(error)
  if (res.headersSent) return next(error)
  return json(res, error.status || 500, { message: error.status ? error.message : 'Terjadi kesalahan pada layanan.', ...(error.errors ? { errors: error.errors } : {}) })
}
