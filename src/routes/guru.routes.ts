import type { Express } from 'express'
import { handleGuruRequest } from '../controllers/guru.controller.ts'
import { authorizeArea } from '../middleware/authorize.ts'

export function registerGuruRoutes(app: Express): void {
  app.use(authorizeArea('/api/guru', 'guru', (context) => handleGuruRequest(context)))
}
