/// <reference path="./types/express.d.ts" />

import express from 'express'
import { errorHandler, notFoundHandler } from './middleware/error.ts'
import { originMiddleware } from './middleware/origin.ts'
import { sessionMiddleware } from './middleware/session.ts'
import { registerRoutes } from './routes/index.ts'

const app = express()
app.disable('x-powered-by')
app.set('etag', false)
app.set('strict routing', true)
app.set('case sensitive routing', true)

app.use(originMiddleware)
app.use(sessionMiddleware)
registerRoutes(app)
app.use(notFoundHandler)
app.use(errorHandler)

export { app }
export default app
