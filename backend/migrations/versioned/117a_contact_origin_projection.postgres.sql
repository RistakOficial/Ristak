-- Read model exacto de los desgloses de origen usados por Dashboard/mobile.
-- Los triggers sólo coalescen llaves; toda resolución histórica ocurre fuera
-- del write path y se publica mediante un cutover generacional.
CREATE SEQUENCE IF NOT EXISTS contact_origin_generation_seq AS BIGINT;

CREATE TABLE IF NOT EXISTS contact_origin_projection_state (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  projection_version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'backfilling'
    CHECK (status IN ('backfilling', 'replaying', 'ready', 'failed')),
  active_generation BIGINT,
  active_version INTEGER,
  active_timezone TEXT,
  building_generation BIGINT,
  building_version INTEGER,
  building_timezone TEXT,
  contact_cursor TEXT NOT NULL DEFAULT '',
  appointment_cursor TEXT NOT NULL DEFAULT '',
  contacts_complete BOOLEAN NOT NULL DEFAULT FALSE,
  appointments_complete BOOLEAN NOT NULL DEFAULT FALSE,
  range_compiled BOOLEAN NOT NULL DEFAULT FALSE,
  processed_contacts BIGINT NOT NULL DEFAULT 0 CHECK (processed_contacts >= 0),
  processed_appointments BIGINT NOT NULL DEFAULT 0 CHECK (processed_appointments >= 0),
  last_applied_at TIMESTAMPTZ,
  last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO contact_origin_projection_state(singleton_id, projection_version, status)
VALUES (1, 1, 'backfilling')
ON CONFLICT(singleton_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS contact_origin_contact_queue (
  contact_id TEXT PRIMARY KEY,
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  enqueued_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_contact_origin_contact_queue_order
  ON contact_origin_contact_queue(enqueued_at, contact_id);

CREATE TABLE IF NOT EXISTS contact_origin_identity_queue (
  identity_kind TEXT NOT NULL CHECK (identity_kind IN ('contact', 'visitor', 'email')),
  identity_value TEXT NOT NULL,
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  enqueued_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (identity_kind, identity_value)
);
CREATE INDEX IF NOT EXISTS idx_contact_origin_identity_queue_order
  ON contact_origin_identity_queue(enqueued_at, identity_kind, identity_value);

CREATE TABLE IF NOT EXISTS contact_origin_appointment_queue (
  appointment_id TEXT PRIMARY KEY,
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  enqueued_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_contact_origin_appointment_queue_order
  ON contact_origin_appointment_queue(enqueued_at, appointment_id);

CREATE TABLE IF NOT EXISTS contact_origin_contact_fact (
  generation BIGINT NOT NULL,
  contact_id TEXT NOT NULL,
  projection_version INTEGER NOT NULL,
  resolved_source TEXT NOT NULL,
  lead_business_date DATE NOT NULL,
  first_payment_business_date DATE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (generation, contact_id)
);
CREATE INDEX IF NOT EXISTS idx_contact_origin_fact_lead
  ON contact_origin_contact_fact(generation, lead_business_date, resolved_source, contact_id);
CREATE INDEX IF NOT EXISTS idx_contact_origin_fact_conversion
  ON contact_origin_contact_fact(generation, first_payment_business_date, resolved_source, contact_id)
  WHERE first_payment_business_date IS NOT NULL;

CREATE TABLE IF NOT EXISTS contact_origin_daily_rollup (
  generation BIGINT NOT NULL,
  metric_kind TEXT NOT NULL CHECK (metric_kind IN ('leads', 'conversions')),
  business_date DATE NOT NULL,
  resolved_source TEXT NOT NULL,
  contact_count BIGINT NOT NULL DEFAULT 0 CHECK (contact_count >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (generation, metric_kind, business_date, resolved_source)
);
CREATE INDEX IF NOT EXISTS idx_contact_origin_daily_query
  ON contact_origin_daily_rollup(generation, metric_kind, business_date, resolved_source)
  INCLUDE (contact_count);

CREATE TABLE IF NOT EXISTS contact_origin_appointment_fact (
  generation BIGINT NOT NULL,
  appointment_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  business_date DATE NOT NULL,
  calendar_id TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (generation, appointment_id)
);
CREATE INDEX IF NOT EXISTS idx_contact_origin_appointment_range
  ON contact_origin_appointment_fact(generation, business_date, calendar_id, contact_id);
CREATE INDEX IF NOT EXISTS idx_contact_origin_appointment_contact
  ON contact_origin_appointment_fact(generation, contact_id, business_date, calendar_id);

CREATE TABLE IF NOT EXISTS contact_origin_appointment_range_point (
  generation BIGINT NOT NULL,
  contact_id TEXT NOT NULL,
  resolved_source TEXT NOT NULL,
  start_boundary DATE NOT NULL,
  occurrence_date DATE NOT NULL,
  range_delta SMALLINT NOT NULL CHECK (range_delta IN (-1, 1)),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (generation, contact_id, resolved_source, start_boundary, occurrence_date)
);
CREATE INDEX IF NOT EXISTS idx_contact_origin_appointment_point_contact
  ON contact_origin_appointment_range_point(generation, contact_id);

CREATE TABLE IF NOT EXISTS contact_origin_appointment_range_delta (
  generation BIGINT NOT NULL,
  resolved_source TEXT NOT NULL,
  start_boundary DATE NOT NULL,
  occurrence_date DATE NOT NULL,
  range_delta BIGINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (generation, resolved_source, start_boundary, occurrence_date)
);
CREATE INDEX IF NOT EXISTS idx_contact_origin_appointment_delta_query
  ON contact_origin_appointment_range_delta(
    generation, start_boundary, occurrence_date, resolved_source
  ) INCLUDE (range_delta);

CREATE TABLE IF NOT EXISTS contact_origin_range_generation (
  generation BIGINT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'building' CHECK (status IN ('building', 'ready')),
  built_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS contact_origin_generation_gc (
  generation BIGINT PRIMARY KEY,
  eligible_at TIMESTAMPTZ NOT NULL,
  enqueued_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_contact_origin_generation_gc_due
  ON contact_origin_generation_gc(eligible_at, generation);

CREATE OR REPLACE FUNCTION enqueue_contact_origin_contact_change()
RETURNS TRIGGER AS $$
DECLARE
  old_contact_id TEXT := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.id::text END;
  new_contact_id TEXT := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE NEW.id::text END;
BEGIN
  IF TG_OP = 'UPDATE' AND ROW(
    NEW.id, NEW.source, NEW.visitor_id, NEW.email, NEW.attribution_url,
    NEW.attribution_session_source, NEW.attribution_medium,
    NEW.attribution_ctwa_clid, NEW.attribution_ad_id, NEW.created_at
  ) IS NOT DISTINCT FROM ROW(
    OLD.id, OLD.source, OLD.visitor_id, OLD.email, OLD.attribution_url,
    OLD.attribution_session_source, OLD.attribution_medium,
    OLD.attribution_ctwa_clid, OLD.attribution_ad_id, OLD.created_at
  ) THEN
    RETURN NEW;
  END IF;

  INSERT INTO contact_origin_contact_queue(contact_id, revision, enqueued_at)
  SELECT changed.contact_id, 1, clock_timestamp()
  FROM (
    SELECT DISTINCT contact_id
    FROM (VALUES (old_contact_id), (new_contact_id)) ids(contact_id)
    WHERE contact_id IS NOT NULL AND contact_id != ''
  ) changed
  ON CONFLICT(contact_id) DO UPDATE SET
    revision = contact_origin_contact_queue.revision + 1,
    enqueued_at = EXCLUDED.enqueued_at;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION enqueue_contact_origin_related_change()
RETURNS TRIGGER AS $$
DECLARE
  old_contact_id TEXT := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.contact_id::text END;
  new_contact_id TEXT := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE NEW.contact_id::text END;
BEGIN
  INSERT INTO contact_origin_contact_queue(contact_id, revision, enqueued_at)
  SELECT changed.contact_id, 1, clock_timestamp()
  FROM (
    SELECT DISTINCT contact_id
    FROM (VALUES (old_contact_id), (new_contact_id)) ids(contact_id)
    WHERE contact_id IS NOT NULL AND contact_id != ''
  ) changed
  ON CONFLICT(contact_id) DO UPDATE SET
    revision = contact_origin_contact_queue.revision + 1,
    enqueued_at = EXCLUDED.enqueued_at;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

-- El volumen normal de chat no debe convertirse en trabajo de atribucion.
-- Solo una entrada inbound con señal util (o un cambio de asociación) puede
-- modificar la primera fuente de un contacto.
CREATE OR REPLACE FUNCTION enqueue_contact_origin_whatsapp_message_change()
RETURNS TRIGGER AS $$
DECLARE
  old_relevant BOOLEAN := FALSE;
  new_relevant BOOLEAN := FALSE;
  contact_changed BOOLEAN := FALSE;
BEGIN
  IF TG_OP != 'INSERT' THEN
    old_relevant := LOWER(COALESCE(OLD.direction, '')) = 'inbound' AND COALESCE(
      NULLIF(BTRIM(COALESCE(OLD.detected_ctwa_clid::text, '')), ''),
      NULLIF(BTRIM(COALESCE(OLD.detected_source_id::text, '')), ''),
      NULLIF(BTRIM(COALESCE(OLD.detected_source_url::text, '')), ''),
      NULLIF(BTRIM(COALESCE(OLD.detected_source_type::text, '')), ''),
      NULLIF(BTRIM(COALESCE(OLD.detected_source_app::text, '')), ''),
      NULLIF(BTRIM(COALESCE(OLD.detected_entry_point::text, '')), ''),
      NULLIF(BTRIM(COALESCE(OLD.detected_headline::text, '')), '')
    ) IS NOT NULL;
  END IF;
  IF TG_OP != 'DELETE' THEN
    new_relevant := LOWER(COALESCE(NEW.direction, '')) = 'inbound' AND COALESCE(
      NULLIF(BTRIM(COALESCE(NEW.detected_ctwa_clid::text, '')), ''),
      NULLIF(BTRIM(COALESCE(NEW.detected_source_id::text, '')), ''),
      NULLIF(BTRIM(COALESCE(NEW.detected_source_url::text, '')), ''),
      NULLIF(BTRIM(COALESCE(NEW.detected_source_type::text, '')), ''),
      NULLIF(BTRIM(COALESCE(NEW.detected_source_app::text, '')), ''),
      NULLIF(BTRIM(COALESCE(NEW.detected_entry_point::text, '')), ''),
      NULLIF(BTRIM(COALESCE(NEW.detected_headline::text, '')), '')
    ) IS NOT NULL;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    contact_changed := OLD.contact_id IS DISTINCT FROM NEW.contact_id;
    IF NOT contact_changed AND ROW(
      NEW.direction, NEW.message_timestamp, NEW.created_at,
      NEW.detected_ctwa_clid, NEW.detected_source_id, NEW.detected_source_url,
      NEW.detected_source_type, NEW.detected_source_app,
      NEW.detected_entry_point, NEW.detected_headline
    ) IS NOT DISTINCT FROM ROW(
      OLD.direction, OLD.message_timestamp, OLD.created_at,
      OLD.detected_ctwa_clid, OLD.detected_source_id, OLD.detected_source_url,
      OLD.detected_source_type, OLD.detected_source_app,
      OLD.detected_entry_point, OLD.detected_headline
    ) THEN
      RETURN NEW;
    END IF;
  END IF;

  INSERT INTO contact_origin_contact_queue(contact_id, revision, enqueued_at)
  SELECT changed.contact_id, 1, clock_timestamp()
  FROM (
    SELECT DISTINCT contact_id
    FROM (VALUES
      (CASE WHEN old_relevant OR contact_changed THEN
        CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.contact_id::text END END),
      (CASE WHEN new_relevant OR contact_changed THEN
        CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE NEW.contact_id::text END END)
    ) ids(contact_id)
    WHERE contact_id IS NOT NULL AND contact_id != ''
  ) changed
  ON CONFLICT(contact_id) DO UPDATE SET
    revision = contact_origin_contact_queue.revision + 1,
    enqueued_at = EXCLUDED.enqueued_at;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION enqueue_contact_origin_api_attribution_change()
RETURNS TRIGGER AS $$
DECLARE
  old_contact_id TEXT := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.contact_id::text END;
  new_contact_id TEXT := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE NEW.contact_id::text END;
  old_message_id TEXT := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.whatsapp_api_message_id::text END;
  new_message_id TEXT := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE NEW.whatsapp_api_message_id::text END;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD IS NOT DISTINCT FROM NEW THEN
    RETURN NEW;
  END IF;

  INSERT INTO contact_origin_contact_queue(contact_id, revision, enqueued_at)
  SELECT changed.contact_id, 1, clock_timestamp()
  FROM (
    SELECT DISTINCT contact_id
    FROM (
      VALUES (old_contact_id), (new_contact_id)
    ) direct_ids(contact_id)
    WHERE contact_id IS NOT NULL AND contact_id != ''

    UNION

    SELECT DISTINCT msg.contact_id::text
    FROM whatsapp_api_messages msg
    WHERE msg.id::text IN (old_message_id, new_message_id)
      AND msg.contact_id IS NOT NULL AND msg.contact_id::text != ''
  ) changed
  ON CONFLICT(contact_id) DO UPDATE SET
    revision = contact_origin_contact_queue.revision + 1,
    enqueued_at = EXCLUDED.enqueued_at;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION enqueue_contact_origin_session_identities()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO contact_origin_identity_queue(identity_kind, identity_value, revision, enqueued_at)
  SELECT changed.identity_kind, changed.identity_value, 1, clock_timestamp()
  FROM (
    SELECT DISTINCT identity_kind, identity_value
    FROM (VALUES
      ('contact', CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.contact_id::text END),
      ('contact', CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE NEW.contact_id::text END),
      ('visitor', CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.visitor_id::text END),
      ('visitor', CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE NEW.visitor_id::text END),
      ('email', CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE LOWER(TRIM(OLD.email::text)) END),
      ('email', CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE LOWER(TRIM(NEW.email::text)) END)
    ) identities(identity_kind, identity_value)
    WHERE identity_value IS NOT NULL AND identity_value != ''
  ) changed
  ON CONFLICT(identity_kind, identity_value) DO UPDATE SET
    revision = contact_origin_identity_queue.revision + 1,
    enqueued_at = EXCLUDED.enqueued_at;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION enqueue_contact_origin_appointment_change()
RETURNS TRIGGER AS $$
DECLARE
  old_appointment_id TEXT := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.id::text END;
  new_appointment_id TEXT := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE NEW.id::text END;
BEGIN
  INSERT INTO contact_origin_appointment_queue(appointment_id, revision, enqueued_at)
  SELECT changed.appointment_id, 1, clock_timestamp()
  FROM (
    SELECT DISTINCT appointment_id
    FROM (VALUES (old_appointment_id), (new_appointment_id)) ids(appointment_id)
    WHERE appointment_id IS NOT NULL AND appointment_id != ''
  ) changed
  ON CONFLICT(appointment_id) DO UPDATE SET
    revision = contact_origin_appointment_queue.revision + 1,
    enqueued_at = EXCLUDED.enqueued_at;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_contact_origin_contacts ON contacts;
CREATE TRIGGER trg_contact_origin_contacts
AFTER INSERT OR DELETE OR UPDATE OF
  id, source, visitor_id, email, attribution_url, attribution_session_source,
  attribution_medium, attribution_ctwa_clid, attribution_ad_id, created_at
ON contacts FOR EACH ROW EXECUTE FUNCTION enqueue_contact_origin_contact_change();

DROP TRIGGER IF EXISTS trg_contact_origin_activity ON contact_list_activity;
CREATE TRIGGER trg_contact_origin_activity
AFTER INSERT OR DELETE OR UPDATE OF contact_id, first_payment_date
ON contact_list_activity FOR EACH ROW EXECUTE FUNCTION enqueue_contact_origin_related_change();

DROP TRIGGER IF EXISTS trg_contact_origin_whatsapp_message ON whatsapp_api_messages;
CREATE TRIGGER trg_contact_origin_whatsapp_message
AFTER INSERT OR DELETE OR UPDATE OF
  contact_id, direction, message_timestamp, created_at, detected_ctwa_clid,
  detected_source_id, detected_source_url, detected_source_type,
  detected_source_app, detected_entry_point, detected_headline
ON whatsapp_api_messages FOR EACH ROW EXECUTE FUNCTION enqueue_contact_origin_whatsapp_message_change();

DROP TRIGGER IF EXISTS trg_contact_origin_api_attribution ON whatsapp_api_attribution;
CREATE TRIGGER trg_contact_origin_api_attribution
AFTER INSERT OR DELETE OR UPDATE OF
  contact_id, whatsapp_api_message_id, detected_source_id, detected_ctwa_clid,
  detected_source_url, detected_source_type, detected_source_app,
  detected_entry_point, detected_headline, created_at
ON whatsapp_api_attribution FOR EACH ROW EXECUTE FUNCTION enqueue_contact_origin_api_attribution_change();

DROP TRIGGER IF EXISTS trg_contact_origin_official_attribution ON whatsapp_attribution;
CREATE TRIGGER trg_contact_origin_official_attribution
AFTER INSERT OR DELETE OR UPDATE OF
  contact_id, referral_source_url, referral_source_type, referral_source_id,
  referral_ctwa_clid, ad_id_thru_message, created_at
ON whatsapp_attribution FOR EACH ROW EXECUTE FUNCTION enqueue_contact_origin_related_change();

DROP TRIGGER IF EXISTS trg_contact_origin_sessions ON sessions;
CREATE TRIGGER trg_contact_origin_sessions
AFTER INSERT OR DELETE OR UPDATE OF
  id, contact_id, visitor_id, email, started_at, created_at, referrer_url,
  site_source_name, utm_source, source_platform
ON sessions FOR EACH ROW EXECUTE FUNCTION enqueue_contact_origin_session_identities();

DROP TRIGGER IF EXISTS trg_contact_origin_appointments ON appointments;
CREATE TRIGGER trg_contact_origin_appointments
AFTER INSERT OR DELETE OR UPDATE OF id, contact_id, date_added, calendar_id
ON appointments FOR EACH ROW EXECUTE FUNCTION enqueue_contact_origin_appointment_change();
