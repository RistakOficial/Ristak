ALTER TABLE appointment_reminders
  ADD COLUMN IF NOT EXISTS calendar_id TEXT;

WITH preferred_calendar AS (
  SELECT calendars.id
  FROM calendars
  ORDER BY
    CASE
      WHEN calendars.id = (
        SELECT config_value
        FROM app_config
        WHERE config_key = 'default_calendar_id'
        LIMIT 1
      ) THEN 0
      WHEN COALESCE(calendars.is_active, 1) = 1 THEN 1
      ELSE 2
    END,
    calendars.created_at ASC,
    calendars.id ASC
  LIMIT 1
)
UPDATE appointment_reminders
SET calendar_id = preferred_calendar.id
FROM preferred_calendar
WHERE appointment_reminders.calendar_id IS NULL;

DROP INDEX IF EXISTS idx_appointment_reminders_system_key;
DROP INDEX IF EXISTS idx_appointment_reminders_schedule_key;

CREATE INDEX IF NOT EXISTS idx_appointment_reminders_calendar
  ON appointment_reminders(calendar_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_appointment_reminders_calendar_system_key
  ON appointment_reminders(calendar_id, system_key)
  WHERE calendar_id IS NOT NULL AND system_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_appointment_reminders_calendar_schedule_key
  ON appointment_reminders(calendar_id, schedule_key)
  WHERE calendar_id IS NOT NULL AND schedule_key IS NOT NULL;

UPDATE appointment_reminder_sends AS sends
SET confirmation_timeout_status = 'disabled',
    confirmation_timeout_processed_at = CURRENT_TIMESTAMP
FROM appointment_reminders AS reminder,
     appointments AS appointment
WHERE sends.confirmation_timeout_status = 'pending'
  AND reminder.id = sends.reminder_id
  AND appointment.id = sends.appointment_id
  AND (
    reminder.calendar_id IS NULL OR
    appointment.calendar_id IS NULL OR
    reminder.calendar_id != appointment.calendar_id
  );
