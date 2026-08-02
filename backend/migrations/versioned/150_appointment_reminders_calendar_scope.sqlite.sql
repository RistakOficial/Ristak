-- initTables agrega y rellena calendar_id antes de ejecutar migraciones.
-- Los horarios y system_key sólo son únicos dentro de cada calendario.
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

UPDATE appointment_reminder_sends
SET confirmation_timeout_status = 'disabled',
    confirmation_timeout_processed_at = CURRENT_TIMESTAMP
WHERE confirmation_timeout_status = 'pending'
  AND EXISTS (
    SELECT 1
    FROM appointment_reminders reminder
    INNER JOIN appointments appointment
      ON appointment.id = appointment_reminder_sends.appointment_id
    WHERE reminder.id = appointment_reminder_sends.reminder_id
      AND (
        reminder.calendar_id IS NULL OR
        appointment.calendar_id IS NULL OR
        reminder.calendar_id != appointment.calendar_id
      )
  );
