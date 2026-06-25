-- (AUTO-004) Inscripción duplicada por carrera en createEnrollment (automationEngine.js).
-- El motor hacía check-then-insert sin constraint: dos triggers casi simultáneos para el
-- mismo contacto en la misma automatización podían crear DOS enrollments "active" (fantasma).
--
-- Solución: índice ÚNICO PARCIAL sobre (automation_id, contact_id) solo cuando contact_id NO
-- es NULL. Razón del parcial: contact_id puede ser NULL (enrollment.contactId || null) y un
-- UNIQUE normal permitiría múltiples NULL en ambos motores, pero queremos ser explícitos: las
-- inscripciones SIN contacto NO se deben bloquear nunca (no hay clave de deduplicación válida).
-- Los índices parciales con WHERE funcionan tanto en SQLite como en PostgreSQL.
--
-- DEDUPLICACIÓN PREVIA (segura en ambos motores): si en prod ya existieran pares duplicados,
-- el CREATE UNIQUE INDEX fallaría. Antes de crearlo borramos los duplicados conservando UNA
-- fila por par (automation_id, contact_id) — la de menor entered_at, y como desempate la de id
-- menor (determinista).
-- NOTA cross-DB: SQLite NO permite alias en "DELETE FROM tabla alias" (PostgreSQL sí), así que
-- borramos por subconsulta sobre la PK (id IN (...)). El alias va DENTRO de la subconsulta, que
-- ambos motores aceptan. El self-join detecta para cada fila si existe otra "mejor" del mismo par.
DELETE FROM automation_enrollments
WHERE id IN (
  SELECT e.id
  FROM automation_enrollments e
  WHERE e.contact_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM automation_enrollments k
      WHERE k.automation_id = e.automation_id
        AND k.contact_id = e.contact_id
        AND (
          k.entered_at < e.entered_at
          OR (k.entered_at = e.entered_at AND k.id < e.id)
          OR (k.entered_at IS NULL AND e.entered_at IS NOT NULL)
          OR (k.entered_at IS NULL AND e.entered_at IS NULL AND k.id < e.id)
        )
    )
);

-- Índice único parcial: una sola inscripción por (automatización, contacto) con contacto real.
CREATE UNIQUE INDEX IF NOT EXISTS uq_automation_enrollments_auto_contact
  ON automation_enrollments (automation_id, contact_id)
  WHERE contact_id IS NOT NULL;
