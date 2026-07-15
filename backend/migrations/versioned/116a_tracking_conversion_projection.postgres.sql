-- Read model incremental exacto para el core de conversiones de Analiticas.
-- Los triggers sólo deduplican una llave de contacto; ningún write path agrega
-- historiales, consulta EXISTS ni recorre contactos.
CREATE TABLE IF NOT EXISTS tracking_conversion_projection_state (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  projection_version INTEGER NOT NULL DEFAULT 1,
  account_timezone TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'backfilling'
    CHECK (status IN ('backfilling', 'replaying', 'ready', 'failed')),
  backfill_cursor TEXT,
  backfill_complete BOOLEAN NOT NULL DEFAULT FALSE,
  processed_count BIGINT NOT NULL DEFAULT 0 CHECK (processed_count >= 0),
  last_applied_at TIMESTAMPTZ,
  last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO tracking_conversion_projection_state(
  singleton_id, projection_version, account_timezone, status, backfill_complete
) VALUES (1, 1, '', 'backfilling', FALSE)
ON CONFLICT(singleton_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS tracking_conversion_change_queue (
  contact_id TEXT PRIMARY KEY,
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  enqueued_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_tracking_conversion_queue_order
  ON tracking_conversion_change_queue(enqueued_at, contact_id);

CREATE TABLE IF NOT EXISTS tracking_conversion_contact_fact (
  contact_id TEXT PRIMARY KEY,
  projection_version INTEGER NOT NULL DEFAULT 1,
  contact_created_at TIMESTAMPTZ NOT NULL,
  business_date DATE NOT NULL,
  stage TEXT NOT NULL
    CHECK (stage IN ('prospect', 'appointment_scheduled', 'appointment_attended', 'customer')),
  registrations INTEGER NOT NULL DEFAULT 1 CHECK (registrations = 1),
  prospects INTEGER NOT NULL DEFAULT 0 CHECK (prospects IN (0, 1)),
  appointments INTEGER NOT NULL DEFAULT 0 CHECK (appointments IN (0, 1)),
  attendances INTEGER NOT NULL DEFAULT 0 CHECK (attendances IN (0, 1)),
  customers INTEGER NOT NULL DEFAULT 0 CHECK (customers IN (0, 1)),
  purchases BIGINT NOT NULL DEFAULT 0 CHECK (purchases >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_tracking_conversion_fact_date_stage
  ON tracking_conversion_contact_fact(business_date, stage, contact_id);

CREATE TABLE IF NOT EXISTS tracking_conversion_daily_rollup (
  business_date DATE NOT NULL,
  stage TEXT NOT NULL
    CHECK (stage IN ('prospect', 'appointment_scheduled', 'appointment_attended', 'customer')),
  registrations BIGINT NOT NULL DEFAULT 0 CHECK (registrations >= 0),
  prospects BIGINT NOT NULL DEFAULT 0 CHECK (prospects >= 0),
  appointments BIGINT NOT NULL DEFAULT 0 CHECK (appointments >= 0),
  attendances BIGINT NOT NULL DEFAULT 0 CHECK (attendances >= 0),
  customers BIGINT NOT NULL DEFAULT 0 CHECK (customers >= 0),
  purchases BIGINT NOT NULL DEFAULT 0 CHECK (purchases >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (business_date, stage)
);
CREATE INDEX IF NOT EXISTS idx_tracking_conversion_daily_range
  ON tracking_conversion_daily_rollup(business_date, stage);

CREATE OR REPLACE FUNCTION enqueue_tracking_conversion_contact_row_change()
RETURNS TRIGGER AS $$
DECLARE
  old_contact_id TEXT := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.id::text END;
  new_contact_id TEXT := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE NEW.id::text END;
BEGIN
  IF TG_OP = 'UPDATE' AND ROW(
    NEW.id, NEW.visitor_id, NEW.source, NEW.created_at, NEW.appointment_date
  ) IS NOT DISTINCT FROM ROW(
    OLD.id, OLD.visitor_id, OLD.source, OLD.created_at, OLD.appointment_date
  ) THEN
    RETURN NEW;
  END IF;

  INSERT INTO tracking_conversion_change_queue(contact_id, revision, enqueued_at)
  SELECT candidate.contact_id, 1, clock_timestamp()
  FROM (
    SELECT DISTINCT contact_id
    FROM (VALUES (old_contact_id), (new_contact_id)) changed(contact_id)
    WHERE contact_id IS NOT NULL AND contact_id != ''
  ) candidate
  ON CONFLICT(contact_id) DO UPDATE SET
    revision = tracking_conversion_change_queue.revision + 1,
    enqueued_at = EXCLUDED.enqueued_at;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION enqueue_tracking_conversion_related_change()
RETURNS TRIGGER AS $$
DECLARE
  old_contact_id TEXT := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.contact_id::text END;
  new_contact_id TEXT := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE NEW.contact_id::text END;
BEGIN
  INSERT INTO tracking_conversion_change_queue(contact_id, revision, enqueued_at)
  SELECT candidate.contact_id, 1, clock_timestamp()
  FROM (
    SELECT DISTINCT contact_id
    FROM (VALUES (old_contact_id), (new_contact_id)) changed(contact_id)
    WHERE contact_id IS NOT NULL AND contact_id != ''
  ) candidate
  ON CONFLICT(contact_id) DO UPDATE SET
    revision = tracking_conversion_change_queue.revision + 1,
    enqueued_at = EXCLUDED.enqueued_at;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_tracking_conversion_contact_change ON contacts;
CREATE TRIGGER trg_tracking_conversion_contact_change
AFTER INSERT OR DELETE OR UPDATE OF id, visitor_id, source, created_at, appointment_date
ON contacts FOR EACH ROW EXECUTE FUNCTION enqueue_tracking_conversion_contact_row_change();

DROP TRIGGER IF EXISTS trg_tracking_conversion_activity_change ON contact_list_activity;
CREATE TRIGGER trg_tracking_conversion_activity_change
AFTER INSERT OR DELETE OR UPDATE OF purchases_count, active_appointments_count,
  attended_appointments_count, attendance_signals_count
ON contact_list_activity FOR EACH ROW EXECUTE FUNCTION enqueue_tracking_conversion_related_change();

DROP TRIGGER IF EXISTS trg_tracking_conversion_whatsapp_message_change ON whatsapp_api_messages;
CREATE TRIGGER trg_tracking_conversion_whatsapp_message_change
AFTER INSERT OR DELETE OR UPDATE OF contact_id
ON whatsapp_api_messages FOR EACH ROW EXECUTE FUNCTION enqueue_tracking_conversion_related_change();

DROP TRIGGER IF EXISTS trg_tracking_conversion_api_attribution_change ON whatsapp_api_attribution;
CREATE TRIGGER trg_tracking_conversion_api_attribution_change
AFTER INSERT OR DELETE OR UPDATE OF contact_id
ON whatsapp_api_attribution FOR EACH ROW EXECUTE FUNCTION enqueue_tracking_conversion_related_change();

DROP TRIGGER IF EXISTS trg_tracking_conversion_legacy_attribution_change ON whatsapp_attribution;
CREATE TRIGGER trg_tracking_conversion_legacy_attribution_change
AFTER INSERT OR DELETE OR UPDATE OF contact_id
ON whatsapp_attribution FOR EACH ROW EXECUTE FUNCTION enqueue_tracking_conversion_related_change();
