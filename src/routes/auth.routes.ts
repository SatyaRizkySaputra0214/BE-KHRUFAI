import type { Express } from 'express'
import { getCsrf, getSession, health, login, logout } from '../controllers/auth.controller.ts'
import { asyncHandler, route } from '../utils/http.ts'

export function registerAuthRoutes(app: Express): void {
  // Give the backend host a useful response when opened directly in a browser.
  // Keep the database-backed readiness check at /api/health.
  route(app, 'GET', '/', (_req, res) => {
    res.status(200).json({ status: 'ok', service: 'Khrufai API', health: '/api/health' })
  })
  route(app, 'GET', '/api', (_req, res) => {
    res.status(200).json({ status: 'ok', service: 'Khrufai API', health: '/api/health' })
  })
  route(app, 'GET', '/api/health', asyncHandler(health))
  route(app, 'GET', '/api/auth/csrf', asyncHandler(getCsrf))
  route(app, 'POST', '/api/auth/login', asyncHandler(login))
  route(app, 'GET', '/api/auth/session', asyncHandler(getSession))
  route(app, 'POST', '/api/auth/logout', asyncHandler(logout))
}
