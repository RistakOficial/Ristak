ALTER TABLE appointment_reminder_sends
  ADD COLUMN IF NOT EXISTS source_type TEXT DEFAULT 'appointment_reminder';

ALTER TABLE appointment_reminder_sends
  ADD COLUMN IF NOT EXISTS source_id TEXT;

ALTER TABLE appointment_reminder_sends
  ADD COLUMN IF NOT EXISTS source_config TEXT;
