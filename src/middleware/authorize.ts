import type { Request, Response } from 'express'
import { validateCsrf } from '../services/auth.service.ts'
import { asyncHandler, currentPath, json } from '../utils/http.ts'
import type { AreaContext } from '../types/http.ts'
import type { AuthenticatedSession } from '../types/session.ts'

const mutatingMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

export const authorizeArea = (prefix: string, role: string, invoke: (context: AreaContext) => unknown) =>
  asyncHandler(async (req: Request, res: Response, next) => {
    const path = currentPath(req)
    if (!path.startsWith(prefix)) return next()
    const session = req.authSession
    if (!session?.user_id) return json(res, 401, { message: 'Silakan login terlebih dahulu.' })
    if (session.role !== role) return json(res, 403, { message: 'Anda tidak memiliki akses untuk tindakan ini.' })
    if (mutatingMethods.has(req.method) && !await validateCsrf(req, session)) {
      return json(res, 419, { message: 'Token keamanan tidak valid. Muat ulang halaman dan coba lagi.' })
    }
    return invoke({ req, res, path, session: session as AuthenticatedSession })
  })
