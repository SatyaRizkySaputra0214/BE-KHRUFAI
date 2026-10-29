import type { Express } from 'express'
import { downloadMaterial } from '../controllers/material.controller.ts'
import { asyncHandler, route } from '../utils/http.ts'

export function registerMaterialRoutes(app: Express): void {
  route(app, 'GET', '/api/materials/files/:filename', asyncHandler(downloadMaterial))
}
