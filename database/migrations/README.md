# SQL migrations

`schema.sql` is baseline migration `001_initial_schema` and builds the current Khrufai schema in a development database. It creates `khrufai_schema_migrations` and refuses to initialize when Khrufai domain tables already exist without that marker. Unrelated objects such as provider extensions are left alone.

Add future changes as forward-only files named `002_short_description.sql`, `003_short_description.sql`, and so on. Run them through `npm run db:apply`; the runner records each applied filename and skips completed migrations. Do not edit an already-applied migration. Avoid data-clearing statements in automatic migrations.

Migration `002_persistent_file_storage` adds PostgreSQL-backed file storage for new material and assignment uploads. This keeps uploads available across Vercel function instances and deployments. New uploads are limited to 3 MiB to fit Vercel's 4.5 MB function payload limit, including multipart/base64 overhead. Existing file paths continue to be read from their configured legacy location.
