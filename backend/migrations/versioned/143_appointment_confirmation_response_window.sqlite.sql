-- initTables repara estas columnas antes de ejecutar migraciones versionadas.
-- El SELECT falla cerrado si una instalación SQLite quedó incompleta.
SELECT
  confirmation_timeout_mode,
  confirmation_response_start,
  confirmation_response_end
FROM appointment_reminders
LIMIT 0;
