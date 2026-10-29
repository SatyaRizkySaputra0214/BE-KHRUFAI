CREATE TABLE IF NOT EXISTS stored_files (
    id UUID PRIMARY KEY,
    filename VARCHAR(255) NOT NULL,
    mime_type VARCHAR(255) NOT NULL,
    data BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS stored_files_created_at_idx ON stored_files(created_at);
