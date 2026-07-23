-- Cada reingreso permitido debe crear una inscripción nueva. El índice legacy
-- 010 bloqueaba para siempre (automation_id, contact_id), incluso cuando la
-- ejecución anterior ya había terminado.
DROP INDEX IF EXISTS uq_automation_enrollments_auto_contact;

-- Conserva la protección de las ejecuciones que ya estaban activas durante el
-- despliegue. Las nuevas filas sólo llenan esta columna cuando el flujo tiene
-- preventDuplicateActiveEnrollment habilitado.
UPDATE automation_enrollments
SET dedupe_contact_id = contact_id
WHERE contact_id IS NOT NULL
  AND status IN ('active', 'waiting', 'paused');

CREATE UNIQUE INDEX IF NOT EXISTS uq_automation_enrollments_active_contact
  ON automation_enrollments (automation_id, dedupe_contact_id)
  WHERE dedupe_contact_id IS NOT NULL
    AND status IN ('active', 'waiting', 'paused');
