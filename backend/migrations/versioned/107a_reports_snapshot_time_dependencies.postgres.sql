-- Invalida el read-model de Reportes cuando una fila cambia de periodo sin
-- castigar inserts/deletes, que ya avanzan campaign_performance_revision.
DROP TRIGGER IF EXISTS trg_reports_snapshot_payments_time_update ON payments;
DROP TRIGGER IF EXISTS trg_reports_snapshot_appointments_time_update ON appointments;

CREATE TRIGGER trg_reports_snapshot_payments_time_update
AFTER UPDATE OF date ON payments
FOR EACH STATEMENT EXECUTE FUNCTION ristak_bump_reports_snapshot_revision();

CREATE TRIGGER trg_reports_snapshot_appointments_time_update
AFTER UPDATE OF date_added ON appointments
FOR EACH STATEMENT EXECUTE FUNCTION ristak_bump_reports_snapshot_revision();
