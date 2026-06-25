-- (DB-010) Tabla de auditoría/historial para entidades sensibles (contactos, pagos, citas).
-- Registra quién hizo qué y cuándo, para poder reconstruir qué pasó si algo falla.
-- El id lo genera la app (portátil SQLite/Postgres). Aditiva e idempotente vía el runner.
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  action TEXT NOT NULL,
  actor_user_id TEXT,
  actor_label TEXT,
  details_json TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit_log(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at);
