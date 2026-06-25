-- (APT-004) Bloqueos de horario NATIVOS, para calendarios Ristak/Google (antes solo
-- funcionaban con HighLevel). Se respetan en checkSlotAvailability para impedir agendar
-- sobre un horario bloqueado. Aditiva e idempotente vía el runner versionado.
CREATE TABLE IF NOT EXISTS blocked_slots (
  id TEXT PRIMARY KEY,
  calendar_id TEXT,
  start_time DATETIME NOT NULL,
  end_time DATETIME NOT NULL,
  title TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_blocked_slots_calendar ON blocked_slots(calendar_id, start_time);
