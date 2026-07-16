-- Outbox durable para separar el ACK del webhook de las entregas externas.
-- La identidad (job_kind, message_id) evita duplicar push o enriquecimiento
-- cuando Meta reintenta el mismo mensaje.
CREATE TABLE IF NOT EXISTS chat_delivery_outbox (
  id TEXT PRIMARY KEY,
  job_kind TEXT NOT NULL CHECK (job_kind IN ('push', 'meta_enrichment')),
  message_id TEXT NOT NULL,
  contact_id TEXT,
  provider TEXT,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL,
  lease_owner TEXT,
  lease_expires_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  failed_at TEXT,
  UNIQUE (job_kind, message_id)
);

CREATE INDEX IF NOT EXISTS idx_chat_delivery_outbox_ready
  ON chat_delivery_outbox (status, available_at, created_at);

CREATE INDEX IF NOT EXISTS idx_chat_delivery_outbox_lease
  ON chat_delivery_outbox (status, lease_expires_at);

CREATE INDEX IF NOT EXISTS idx_chat_delivery_outbox_completed
  ON chat_delivery_outbox (status, completed_at);

CREATE INDEX IF NOT EXISTS idx_chat_delivery_outbox_failed
  ON chat_delivery_outbox (status, failed_at);
