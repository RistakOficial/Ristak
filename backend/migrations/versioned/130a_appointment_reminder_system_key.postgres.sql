ALTER TABLE appointment_reminders
  ADD COLUMN IF NOT EXISTS system_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_appointment_reminders_system_key
  ON appointment_reminders(system_key)
  WHERE system_key IS NOT NULL;
