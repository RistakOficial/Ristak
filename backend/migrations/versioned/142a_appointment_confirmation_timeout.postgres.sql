ALTER TABLE appointment_reminders
  ADD COLUMN IF NOT EXISTS confirmation_timeout_value INTEGER,
  ADD COLUMN IF NOT EXISTS confirmation_timeout_unit TEXT;

ALTER TABLE appointment_reminder_sends
  ADD COLUMN IF NOT EXISTS confirmation_deadline_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS confirmation_timeout_status TEXT,
  ADD COLUMN IF NOT EXISTS confirmation_timeout_processed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_appointment_reminder_sends_confirmation_deadline
  ON appointment_reminder_sends(
    confirmation_timeout_status,
    confirmation_deadline_at
  );
