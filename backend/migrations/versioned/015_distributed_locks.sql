-- Locks distribuidos con dueño. A diferencia de cron_locks, estos no se liberan
-- al terminar un tick: sirven para posesiones vivas como un socket de WhatsApp QR.
CREATE TABLE IF NOT EXISTS distributed_locks (
  name TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  locked_until DATETIME NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_distributed_locks_until ON distributed_locks(locked_until);
