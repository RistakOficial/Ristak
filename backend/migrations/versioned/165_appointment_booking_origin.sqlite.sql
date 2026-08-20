-- initTables agrega la columna antes de las migraciones versionadas en SQLite.
-- El SELECT valida el contrato y el UPDATE recupera citas conversacionales
-- históricas cuyo origen sí puede identificarse sin adivinar.
SELECT booking_origin
FROM appointments
LIMIT 0;

UPDATE appointments
SET booking_origin = 'contact'
WHERE booking_origin IS NULL
  AND LOWER(COALESCE(source, '')) = 'conversational_agent_v2';
