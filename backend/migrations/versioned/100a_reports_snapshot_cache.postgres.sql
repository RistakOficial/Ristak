CREATE TABLE IF NOT EXISTS reports_snapshot_cache (
  account_scope TEXT NOT NULL,
  principal_scope TEXT NOT NULL,
  cache_key TEXT NOT NULL,
  source_revision TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  built_at TIMESTAMPTZ NOT NULL,
  last_accessed_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (account_scope, principal_scope, cache_key)
);

CREATE INDEX IF NOT EXISTS idx_reports_snapshot_cache_lru
  ON reports_snapshot_cache(account_scope, principal_scope, last_accessed_at DESC);
CREATE INDEX IF NOT EXISTS idx_reports_snapshot_cache_account_lru
  ON reports_snapshot_cache(account_scope, last_accessed_at DESC);

-- La revision de campañas 070* ya cubre contactos, pagos, citas, asistencia,
-- anuncios y sesiones con triggers acotados a columnas relevantes. Esta
-- secuencia agrega solamente las dependencias exclusivas de Reportes; duplicar
-- los triggers del hot path haria dos escrituras de revision por mutacion.
CREATE SEQUENCE IF NOT EXISTS reports_snapshot_revision_seq
  AS BIGINT MINVALUE 1 START WITH 1 INCREMENT BY 1 CACHE 1;

ALTER SEQUENCE reports_snapshot_revision_seq CACHE 1;

CREATE OR REPLACE FUNCTION ristak_bump_reports_snapshot_revision()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM nextval('reports_snapshot_revision_seq');
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ristak_bump_reports_snapshot_config_revision()
RETURNS TRIGGER AS $$
DECLARE
  relevant BOOLEAN := FALSE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    relevant := NEW.config_key IN ('account_timezone', 'attribution_calendar_ids');
  ELSIF TG_OP = 'DELETE' THEN
    relevant := OLD.config_key IN ('account_timezone', 'attribution_calendar_ids');
  ELSE
    relevant := (
      OLD.config_key IN ('account_timezone', 'attribution_calendar_ids')
      OR NEW.config_key IN ('account_timezone', 'attribution_calendar_ids')
    ) AND (
      OLD.config_key IS DISTINCT FROM NEW.config_key
      OR OLD.config_value IS DISTINCT FROM NEW.config_value
    );
  END IF;
  IF relevant THEN
    PERFORM nextval('reports_snapshot_revision_seq');
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_reports_snapshot_contacts ON contacts;
DROP TRIGGER IF EXISTS trg_reports_snapshot_contact_phones ON contact_phone_numbers;
DROP TRIGGER IF EXISTS trg_reports_snapshot_payments ON payments;
DROP TRIGGER IF EXISTS trg_reports_snapshot_appointments ON appointments;
DROP TRIGGER IF EXISTS trg_reports_snapshot_attendance ON appointment_attendance_signals;
DROP TRIGGER IF EXISTS trg_reports_snapshot_ads ON meta_ads;
DROP TRIGGER IF EXISTS trg_reports_snapshot_sessions ON sessions;
DROP TRIGGER IF EXISTS trg_reports_snapshot_hidden ON hidden_contact_filters;
DROP TRIGGER IF EXISTS trg_reports_snapshot_app_config ON app_config;
DROP TRIGGER IF EXISTS trg_reports_snapshot_highlevel ON highlevel_config;

CREATE TRIGGER trg_reports_snapshot_contact_phones
AFTER INSERT OR UPDATE OR DELETE ON contact_phone_numbers
FOR EACH STATEMENT EXECUTE FUNCTION ristak_bump_reports_snapshot_revision();
CREATE TRIGGER trg_reports_snapshot_hidden
AFTER INSERT OR UPDATE OR DELETE ON hidden_contact_filters
FOR EACH STATEMENT EXECUTE FUNCTION ristak_bump_reports_snapshot_revision();
CREATE TRIGGER trg_reports_snapshot_app_config
AFTER INSERT OR UPDATE OR DELETE ON app_config
FOR EACH ROW EXECUTE FUNCTION ristak_bump_reports_snapshot_config_revision();
CREATE TRIGGER trg_reports_snapshot_highlevel
AFTER INSERT OR UPDATE OR DELETE ON highlevel_config
FOR EACH STATEMENT EXECUTE FUNCTION ristak_bump_reports_snapshot_revision();
