import { readFile, readdir } from 'node:fs/promises'
import type { PoolClient } from 'pg'
import { pool } from '../src/config/database.ts'

let client: PoolClient | undefined
try {
  client = await pool.connect()
  await client.query('BEGIN')
  await client.query(await readFile(new URL('../database/schema.sql', import.meta.url), 'utf8'))
  await client.query('COMMIT')

  const files = (await readdir(new URL('../database/migrations/', import.meta.url)))
    .filter((name) => /^\d+_[a-z0-9_-]+\.sql$/i.test(name))
    .sort()
  for (const name of files) {
    const version = name.replace(/\.sql$/i, '')
    const applied = await client.query('SELECT 1 FROM khrufai_schema_migrations WHERE version=$1', [version])
    if (applied.rowCount) continue
    await client.query('BEGIN')
    await client.query(await readFile(new URL(`../database/migrations/${name}`, import.meta.url), 'utf8'))
    await client.query('INSERT INTO khrufai_schema_migrations(version) VALUES($1)', [version])
    await client.query('COMMIT')
    console.log(`Migration ${version} applied.`)
  }

  await client.query('BEGIN')
  await client.query(await readFile(new URL('../database/seeds/reference-data.sql', import.meta.url), 'utf8'))
  const identityTables = ['users','courses','skills','registrations','classes','class_students','meetings','materials','quizzes','questions','assignments','quiz_scores','assignment_submissions','certificates','attendances','announcements','announcement_reads']
  for (const table of identityTables) {
    await client.query(`SELECT setval(pg_get_serial_sequence('public.${table}','id'), GREATEST(COALESCE(MAX(id),1),1), COALESCE(MAX(id),0)>0) FROM ${table}`)
  }
  await client.query('COMMIT')
  console.log('Schema Khrufai, migration, dan referensi kursus/skill sudah tersedia.')
} catch (error) {
  if (client) {
    try { await client.query('ROLLBACK') } catch {}
  }
  console.error(`Database migration failed${error.code ? ` (${error.code})` : ''}: ${error.message}`)
  process.exitCode = 1
} finally {
  client?.release()
  await pool.end()
}
