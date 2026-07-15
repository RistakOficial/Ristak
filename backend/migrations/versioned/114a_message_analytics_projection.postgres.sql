CREATE TABLE IF NOT EXISTS message_analytics_projection_state (
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
  whatsapp_cursor TEXT NOT NULL DEFAULT '',
  meta_cursor TEXT NOT NULL DEFAULT '',
  email_cursor TEXT NOT NULL DEFAULT '',
  whatsapp_complete BOOLEAN NOT NULL DEFAULT FALSE,
  meta_complete BOOLEAN NOT NULL DEFAULT FALSE,
  email_complete BOOLEAN NOT NULL DEFAULT FALSE,
  last_applied_at TIMESTAMPTZ,
  last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO message_analytics_projection_state(singleton_id, projection_version, status)
VALUES (1, 1, 'backfilling')
ON CONFLICT(singleton_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS message_analytics_change_queue (
  source_kind TEXT NOT NULL CHECK (source_kind IN ('whatsapp', 'meta', 'email')),
  source_message_id TEXT NOT NULL,
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  active_applied_revision BIGINT NOT NULL DEFAULT 0 CHECK (active_applied_revision >= 0),
  building_applied_revision BIGINT NOT NULL DEFAULT 0 CHECK (building_applied_revision >= 0),
  enqueued_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (source_kind, source_message_id)
);
CREATE INDEX IF NOT EXISTS idx_message_analytics_change_queue_order
  ON message_analytics_change_queue(enqueued_at, source_kind, source_message_id);

CREATE TABLE IF NOT EXISTS message_analytics_contact_queue (
  contact_id TEXT PRIMARY KEY,
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  cursor_message_id TEXT NOT NULL DEFAULT '',
  enqueued_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_message_analytics_contact_queue_order
  ON message_analytics_contact_queue(enqueued_at, contact_id);

-- Las generaciones retiradas se conservan durante una ventana de gracia y se
-- borran por lotes. Esto evita que un cutover dispare DELETE masivos/WAL y deja
-- una generación N-1 disponible mientras terminan lecturas iniciadas antes del
-- cambio.
CREATE TABLE IF NOT EXISTS message_analytics_generation_gc (
  generation BIGINT PRIMARY KEY,
  eligible_at TIMESTAMPTZ NOT NULL,
  enqueued_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_message_analytics_generation_gc_due
  ON message_analytics_generation_gc(eligible_at, generation);

CREATE TABLE IF NOT EXISTS message_analytics_fact (
  generation BIGINT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('whatsapp', 'meta', 'email')),
  source_message_id TEXT NOT NULL,
  projection_version INTEGER NOT NULL DEFAULT 1,
  included BOOLEAN NOT NULL DEFAULT FALSE,
  occurred_at TIMESTAMPTZ,
  business_date DATE,
  identity_key TEXT NOT NULL DEFAULT '',
  contact_id TEXT,
  contact_key TEXT NOT NULL DEFAULT '',
  channel TEXT NOT NULL DEFAULT '',
  channel_label TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  attributed BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (generation, source_kind, source_message_id)
);
CREATE INDEX IF NOT EXISTS idx_message_analytics_fact_date
  ON message_analytics_fact(
    generation, business_date, channel, source, identity_key, contact_key,
    occurred_at, source_kind, source_message_id
  )
  WHERE included = TRUE;
CREATE INDEX IF NOT EXISTS idx_message_analytics_fact_contact
  ON message_analytics_fact(generation, contact_id)
  WHERE included = TRUE AND contact_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS message_analytics_daily_identity (
  generation BIGINT NOT NULL,
  business_date DATE NOT NULL,
  channel TEXT NOT NULL,
  source TEXT NOT NULL,
  identity_key TEXT NOT NULL,
  contact_key TEXT NOT NULL DEFAULT '',
  contact_id TEXT,
  channel_label TEXT NOT NULL DEFAULT '',
  message_count BIGINT NOT NULL DEFAULT 0 CHECK (message_count >= 0),
  attributed_message_count BIGINT NOT NULL DEFAULT 0
    CHECK (attributed_message_count >= 0 AND attributed_message_count <= message_count),
  first_occurred_at TIMESTAMPTZ NOT NULL,
  first_source_kind TEXT NOT NULL,
  first_source_message_id TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (generation, business_date, channel, source, identity_key, contact_key)
);
CREATE INDEX IF NOT EXISTS idx_message_analytics_daily_metrics
  ON message_analytics_daily_identity(generation, business_date, identity_key)
  INCLUDE (message_count, attributed_message_count);
CREATE INDEX IF NOT EXISTS idx_message_analytics_daily_channel
  ON message_analytics_daily_identity(generation, business_date, channel, identity_key)
  INCLUDE (channel_label, message_count);
CREATE INDEX IF NOT EXISTS idx_message_analytics_daily_source
  ON message_analytics_daily_identity(generation, business_date, source, identity_key);
CREATE INDEX IF NOT EXISTS idx_message_analytics_daily_contact
  ON message_analytics_daily_identity(generation, contact_id, business_date);

CREATE OR REPLACE FUNCTION enqueue_message_analytics_change()
RETURNS TRIGGER AS $$
DECLARE
  kind TEXT := TG_ARGV[0];
  message_id TEXT;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF kind = 'whatsapp' THEN
      IF ROW(
        NEW.contact_id, NEW.phone, NEW.whatsapp_api_contact_id, NEW.direction,
        NEW.message_timestamp, NEW.created_at, NEW.detected_ctwa_clid,
        NEW.detected_source_id, NEW.detected_source_url, NEW.detected_source_type,
        NEW.detected_source_app, NEW.detected_entry_point
      ) IS NOT DISTINCT FROM ROW(
        OLD.contact_id, OLD.phone, OLD.whatsapp_api_contact_id, OLD.direction,
        OLD.message_timestamp, OLD.created_at, OLD.detected_ctwa_clid,
        OLD.detected_source_id, OLD.detected_source_url, OLD.detected_source_type,
        OLD.detected_source_app, OLD.detected_entry_point
      ) THEN
        RETURN NEW;
      END IF;
    ELSIF kind = 'meta' THEN
      IF ROW(
        NEW.platform, NEW.meta_social_contact_id, NEW.contact_id, NEW.sender_id,
        NEW.direction, NEW.message_timestamp, NEW.created_at, NEW.referral_json
      ) IS NOT DISTINCT FROM ROW(
        OLD.platform, OLD.meta_social_contact_id, OLD.contact_id, OLD.sender_id,
        OLD.direction, OLD.message_timestamp, OLD.created_at, OLD.referral_json
      ) THEN
        RETURN NEW;
      END IF;
    ELSIF kind = 'email' THEN
      IF ROW(
        NEW.contact_id, NEW.direction, NEW.from_email, NEW.message_timestamp,
        NEW.created_at
      ) IS NOT DISTINCT FROM ROW(
        OLD.contact_id, OLD.direction, OLD.from_email, OLD.message_timestamp,
        OLD.created_at
      ) THEN
        RETURN NEW;
      END IF;
    END IF;
  END IF;
  message_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.id::text ELSE NEW.id::text END;
  INSERT INTO message_analytics_change_queue(source_kind, source_message_id, revision, enqueued_at)
  VALUES (kind, message_id, 1, clock_timestamp())
  ON CONFLICT(source_kind, source_message_id) DO UPDATE SET
    revision = message_analytics_change_queue.revision + 1,
    enqueued_at = EXCLUDED.enqueued_at;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_message_analytics_whatsapp_change ON whatsapp_api_messages;
CREATE TRIGGER trg_message_analytics_whatsapp_change
AFTER INSERT OR DELETE OR UPDATE OF
  contact_id, phone, whatsapp_api_contact_id, direction, message_timestamp,
  created_at, detected_ctwa_clid, detected_source_id, detected_source_url,
  detected_source_type, detected_source_app, detected_entry_point
ON whatsapp_api_messages
FOR EACH ROW EXECUTE FUNCTION enqueue_message_analytics_change('whatsapp');
DROP TRIGGER IF EXISTS trg_message_analytics_meta_change ON meta_social_messages;
CREATE TRIGGER trg_message_analytics_meta_change
AFTER INSERT OR DELETE OR UPDATE OF
  platform, meta_social_contact_id, contact_id, sender_id, direction,
  message_timestamp, created_at, referral_json
ON meta_social_messages
FOR EACH ROW EXECUTE FUNCTION enqueue_message_analytics_change('meta');
DROP TRIGGER IF EXISTS trg_message_analytics_email_change ON email_messages;
CREATE TRIGGER trg_message_analytics_email_change
AFTER INSERT OR DELETE OR UPDATE OF
  contact_id, direction, from_email, message_timestamp, created_at
ON email_messages
FOR EACH ROW EXECUTE FUNCTION enqueue_message_analytics_change('email');

CREATE OR REPLACE FUNCTION enqueue_message_analytics_attribution_change()
RETURNS TRIGGER AS $$
DECLARE
  old_message_id TEXT := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.whatsapp_api_message_id::text END;
  new_message_id TEXT := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE NEW.whatsapp_api_message_id::text END;
BEGIN
  IF TG_OP = 'UPDATE' AND ROW(
    NEW.whatsapp_api_message_id, NEW.detected_source_id, NEW.detected_ctwa_clid,
    NEW.detected_source_url, NEW.detected_source_type, NEW.detected_source_app,
    NEW.detected_entry_point
  ) IS NOT DISTINCT FROM ROW(
    OLD.whatsapp_api_message_id, OLD.detected_source_id, OLD.detected_ctwa_clid,
    OLD.detected_source_url, OLD.detected_source_type, OLD.detected_source_app,
    OLD.detected_entry_point
  ) THEN
    RETURN NEW;
  END IF;
  INSERT INTO message_analytics_change_queue(source_kind, source_message_id, revision, enqueued_at)
  SELECT 'whatsapp', candidate.message_id, 1, clock_timestamp()
  FROM (
    SELECT DISTINCT message_id
    FROM (VALUES (old_message_id), (new_message_id)) AS changed(message_id)
    WHERE message_id IS NOT NULL
  ) candidate
  ON CONFLICT(source_kind, source_message_id) DO UPDATE SET
    revision = message_analytics_change_queue.revision + 1,
    enqueued_at = EXCLUDED.enqueued_at;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_message_analytics_attribution_change ON whatsapp_api_attribution;
CREATE TRIGGER trg_message_analytics_attribution_change
AFTER INSERT OR DELETE OR UPDATE OF
  whatsapp_api_message_id, detected_source_id, detected_ctwa_clid,
  detected_source_url, detected_source_type, detected_source_app,
  detected_entry_point
ON whatsapp_api_attribution
FOR EACH ROW EXECUTE FUNCTION enqueue_message_analytics_attribution_change();

CREATE OR REPLACE FUNCTION enqueue_message_analytics_contact_change()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.source IS NOT DISTINCT FROM OLD.source
    AND NEW.attribution_url IS NOT DISTINCT FROM OLD.attribution_url
    AND NEW.attribution_session_source IS NOT DISTINCT FROM OLD.attribution_session_source
    AND NEW.attribution_medium IS NOT DISTINCT FROM OLD.attribution_medium
    AND NEW.attribution_ctwa_clid IS NOT DISTINCT FROM OLD.attribution_ctwa_clid
    AND NEW.attribution_ad_id IS NOT DISTINCT FROM OLD.attribution_ad_id THEN
    RETURN NEW;
  END IF;
  INSERT INTO message_analytics_contact_queue(contact_id, revision, cursor_message_id, enqueued_at)
  VALUES (NEW.id::text, 1, '', clock_timestamp())
  ON CONFLICT(contact_id) DO UPDATE SET
    revision = message_analytics_contact_queue.revision + 1,
    cursor_message_id = '',
    enqueued_at = EXCLUDED.enqueued_at;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_message_analytics_contact_attribution_update ON contacts;
CREATE TRIGGER trg_message_analytics_contact_attribution_update
AFTER UPDATE OF source, attribution_url, attribution_session_source,
  attribution_medium, attribution_ctwa_clid, attribution_ad_id
ON contacts
FOR EACH ROW EXECUTE FUNCTION enqueue_message_analytics_contact_change();
