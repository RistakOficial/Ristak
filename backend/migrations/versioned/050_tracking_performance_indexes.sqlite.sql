-- SQLite local no soporta CREATE INDEX CONCURRENTLY. PostgreSQL usa las
-- migraciones 050a-050d para construir cada índice sin congelar tracking.
CREATE INDEX IF NOT EXISTS idx_sessions_started_at_id
  ON sessions(started_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_sessions_created_at_id
  ON sessions(created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_sessions_contact_started_at_id
  ON sessions(contact_id, started_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_sessions_event_started_at_id
  ON sessions(event_name, started_at DESC, id DESC);
