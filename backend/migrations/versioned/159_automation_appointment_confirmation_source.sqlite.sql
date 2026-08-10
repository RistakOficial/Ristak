-- initTables repara estas columnas antes de ejecutar migraciones versionadas.
-- El SELECT valida el contrato sin duplicar columnas en instalaciones nuevas.
SELECT
  source_type,
  source_id,
  source_config
FROM appointment_reminder_sends
LIMIT 0;
