-- initTables agrega y rellena schedule_key antes de ejecutar migraciones.
-- El índice parcial permite conservar duplicados históricos sin borrar datos:
-- sólo la fila canónica ocupa el horario y las demás deben corregirse al editar.
CREATE UNIQUE INDEX IF NOT EXISTS idx_appointment_reminders_schedule_key
  ON appointment_reminders(schedule_key)
  WHERE schedule_key IS NOT NULL;
