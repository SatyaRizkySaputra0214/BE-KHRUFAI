import type { RequestHandler } from 'express'
import { config } from '../config/env.ts'
import { json } from '../utils/http.ts'

export const originMiddleware: RequestHandler = (req, res, next) => {
  const origin = req.headers.origin
  if (origin && origin !== config.frontendOrigin) return json(res, 403, { message: 'Origin tidak diizinkan.' })
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', config.frontendOrigin)
    res.setHeader('Access-Control-Allow-Credentials', 'true')
    res.setHeader('Vary', 'Origin')
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, X-CSRF-Token' })
    return res.end()
  }
  next()
}
