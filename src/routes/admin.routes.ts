import type { Express } from 'express'
import { handleAdminRequest } from '../controllers/admin.controller.ts'
import { authorizeArea } from '../middleware/authorize.ts'

export function registerAdminRoutes(app: Express): void {
  app.use(authorizeArea('/api/admin', 'admin', (context) => handleAdminRequest(context)))
}
