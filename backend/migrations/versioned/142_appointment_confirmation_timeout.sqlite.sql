-- initTables repara estas columnas antes de ejecutar migraciones versionadas.
-- El SELECT falla cerrado si una instalación SQLite quedó incompleta.
SELECT confirmation_timeout_value, confirmation_timeout_unit
FROM appointment_reminders
LIMIT 0;

SELECT
  confirmation_deadline_at,
  confirmation_timeout_status,
  confirmation_timeout_processed_at
FROM appointment_reminder_sends
LIMIT 0;

CREATE INDEX IF NOT EXISTS idx_appointment_reminder_sends_confirmation_deadline
  ON appointment_reminder_sends(
    confirmation_timeout_status,
    confirmation_deadline_at
  );
