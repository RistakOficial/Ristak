-- initTables repara esta columna antes de ejecutar migraciones versionadas.
-- El SELECT falla cerrado si una instalación SQLite quedó incompleta.
SELECT follow_up_from_appointment_id
FROM appointments
LIMIT 0;

CREATE INDEX IF NOT EXISTS idx_appointments_follow_up_from
ON appointments(follow_up_from_appointment_id);
