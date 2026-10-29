import { app } from './app.ts'
import { config } from './config/env.ts'

app.listen(config.port, config.host, () => console.log(`Khrufai API berjalan di http://${config.host}:${config.port}`))
