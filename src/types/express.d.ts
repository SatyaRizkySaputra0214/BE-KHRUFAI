import type { AuthSession } from './session.ts'

declare global {
  namespace Express {
    interface Request {
      authSession: AuthSession | null
    }
  }
}

export {}
