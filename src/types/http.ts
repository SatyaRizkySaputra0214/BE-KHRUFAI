import type { Request, Response } from 'express'
import type { AuthenticatedSession } from './session.ts'

export interface AreaContext {
  req: Request
  res: Response
  path: string
  session: AuthenticatedSession
}

export type JsonResponse = (res: Response, status: number, body: unknown) => void
export type ReadJson = (req: Request, maxBytes?: number) => Promise<any>
