-- initTables agrega la columna antes de ejecutar migraciones versionadas.
-- Sólo los recordatorios creados por el sistema reciben system_key; los
-- recordatorios manuales conservan NULL y pueden repetir horario/intención.
CREATE UNIQUE INDEX IF NOT EXISTS idx_appointment_reminders_system_key
  ON appointment_reminders(system_key)
  WHERE system_key IS NOT NULL;
