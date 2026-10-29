import { loadSession } from '../services/auth.service.ts'
import { asyncHandler } from '../utils/http.ts'

export const sessionMiddleware = asyncHandler(async (req, _res, next) => {
  req.authSession = await loadSession(req)
  next()
})
