import type { Express } from 'express'
import { registerAuthRoutes } from './auth.routes.ts'
import { registerMaterialRoutes } from './material.routes.ts'
import { registerAdminRoutes } from './admin.routes.ts'
import { registerGuruRoutes } from './guru.routes.ts'
import { registerMuridRoutes } from './murid.routes.ts'

export function registerRoutes(app: Express): void {
  registerAuthRoutes(app)
  registerMaterialRoutes(app)
  registerAdminRoutes(app)
  registerGuruRoutes(app)
  registerMuridRoutes(app)
}
