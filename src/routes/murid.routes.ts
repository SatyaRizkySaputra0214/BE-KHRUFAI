import type { Express } from 'express'
import { handleStudentRequest } from '../controllers/student.controller.ts'
import { authorizeArea } from '../middleware/authorize.ts'

export function registerMuridRoutes(app: Express): void {
  app.use(authorizeArea('/api/murid', 'murid', (context) => handleStudentRequest(context)))
}
