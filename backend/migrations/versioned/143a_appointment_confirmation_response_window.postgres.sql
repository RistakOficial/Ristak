ALTER TABLE appointment_reminders
  ADD COLUMN IF NOT EXISTS confirmation_timeout_mode TEXT DEFAULT 'elapsed',
  ADD COLUMN IF NOT EXISTS confirmation_response_start TEXT DEFAULT '09:00',
  ADD COLUMN IF NOT EXISTS confirmation_response_end TEXT DEFAULT '21:00';

UPDATE appointment_reminders
SET confirmation_timeout_mode = COALESCE(NULLIF(confirmation_timeout_mode, ''), 'elapsed'),
    confirmation_response_start = COALESCE(NULLIF(confirmation_response_start, ''), '09:00'),
    confirmation_response_end = COALESCE(NULLIF(confirmation_response_end, ''), '21:00')
WHERE confirmation_timeout_mode IS NULL
   OR confirmation_timeout_mode = ''
   OR confirmation_response_start IS NULL
   OR confirmation_response_start = ''
   OR confirmation_response_end IS NULL
   OR confirmation_response_end = '';
