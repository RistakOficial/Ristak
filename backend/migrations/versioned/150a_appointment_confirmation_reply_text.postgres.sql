ALTER TABLE appointment_reminders
  ADD COLUMN IF NOT EXISTS confirmation_reply_text TEXT;

ALTER TABLE appointment_reminder_sends
  ADD COLUMN IF NOT EXISTS confirmation_reply_sent_at TIMESTAMPTZ;

ALTER TABLE appointment_reminder_sends
  ADD COLUMN IF NOT EXISTS confirmation_reply_message_id TEXT;
