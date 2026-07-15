-- Reportes agrupa pagos por payments.date y citas por appointments.date_added.
-- 070* ya cubre inserts/deletes y las demás columnas del hot path, pero estas
-- dos fechas editables necesitan invalidar sólo el snapshot de Reportes.
DROP TRIGGER IF EXISTS trg_reports_snapshot_payments_time_update;
DROP TRIGGER IF EXISTS trg_reports_snapshot_appointments_time_update;

CREATE TRIGGER trg_reports_snapshot_payments_time_update
AFTER UPDATE OF date ON payments BEGIN
  UPDATE reports_snapshot_revision
  SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP
  WHERE singleton = 1;
END;

CREATE TRIGGER trg_reports_snapshot_appointments_time_update
AFTER UPDATE OF date_added ON appointments BEGIN
  UPDATE reports_snapshot_revision
  SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP
  WHERE singleton = 1;
END;
