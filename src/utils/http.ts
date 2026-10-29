import type { Express, NextFunction, Request, RequestHandler, Response } from 'express'

export const fail = (status: number, message: string, errors: Record<string, string[]> = {}) =>
  Object.assign(new Error(message), { status, errors })

export const json = (res: Response, status: number, body: unknown): void => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

export const currentPath = (req: Request): string => new URL(req.originalUrl, 'http://localhost').pathname

export const asyncHandler = (handler: (req: Request, res: Response, next: NextFunction) => unknown): RequestHandler =>
  (req, res, next) => { Promise.resolve(handler(req, res, next)).catch(next) }

export const route = (app: Express, method: string, path: string, handler: RequestHandler): void => {
  app.all(path, (req, res, next) => req.method === method ? handler(req, res, next) : next())
}
