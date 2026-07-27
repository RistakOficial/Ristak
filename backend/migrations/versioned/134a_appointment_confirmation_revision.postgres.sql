ALTER TABLE appointment_confirmation_windows
  ADD COLUMN IF NOT EXISTS message_revision INTEGER NOT NULL DEFAULT 0;
