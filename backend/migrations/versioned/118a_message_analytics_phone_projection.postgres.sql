-- Extension exacta del ledger 114/115. Las tablas nacen vacias y se llenan con
-- el mismo backfill/cutover generacional; por eso sus indices no requieren un
-- tren CONCURRENTLY separado.
CREATE TABLE IF NOT EXISTS message_analytics_phone_fact (
  generation BIGINT NOT NULL,
  source_message_id TEXT NOT NULL,
  projection_version INTEGER NOT NULL,
  included BOOLEAN NOT NULL DEFAULT FALSE,
  occurred_at TIMESTAMPTZ,
  business_date DATE,
  identity_key TEXT NOT NULL DEFAULT '',
  contact_id TEXT,
  contact_key TEXT NOT NULL DEFAULT '',
  business_phone_key TEXT NOT NULL DEFAULT '',
  business_phone_number_id TEXT NOT NULL DEFAULT '',
  business_phone_number TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (generation, source_message_id)
);
CREATE INDEX IF NOT EXISTS idx_message_analytics_phone_fact_contact
  ON message_analytics_phone_fact(generation, contact_id, business_date)
  WHERE included = TRUE AND contact_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS message_analytics_daily_phone_identity (
  generation BIGINT NOT NULL,
  business_date DATE NOT NULL,
  business_phone_key TEXT NOT NULL,
  identity_key TEXT NOT NULL,
  contact_key TEXT NOT NULL DEFAULT '',
  contact_id TEXT,
  message_count BIGINT NOT NULL DEFAULT 0 CHECK (message_count >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (
    generation, business_date, business_phone_key, identity_key, contact_key
  )
);
CREATE INDEX IF NOT EXISTS idx_message_analytics_daily_phone_identity_range
  ON message_analytics_daily_phone_identity(
    generation, business_phone_key, identity_key, business_date
  ) INCLUDE (contact_id, message_count);
CREATE INDEX IF NOT EXISTS idx_message_analytics_daily_phone_identity_contact
  ON message_analytics_daily_phone_identity(
    generation, contact_id, business_date, business_phone_key, identity_key
  ) INCLUDE (message_count)
  WHERE contact_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS message_analytics_daily_phone_metadata (
  generation BIGINT NOT NULL,
  business_date DATE NOT NULL,
  business_phone_key TEXT NOT NULL,
  business_phone_number_id TEXT NOT NULL DEFAULT '',
  business_phone_number TEXT NOT NULL DEFAULT '',
  message_count BIGINT NOT NULL DEFAULT 0 CHECK (message_count >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (
    generation, business_date, business_phone_key,
    business_phone_number_id, business_phone_number
  )
);
CREATE INDEX IF NOT EXISTS idx_message_analytics_daily_phone_metadata_range
  ON message_analytics_daily_phone_metadata(
    generation, business_phone_key, business_date
  ) INCLUDE (business_phone_number_id, business_phone_number, message_count);

CREATE TABLE IF NOT EXISTS message_analytics_phone_range_delta (
  generation BIGINT NOT NULL,
  business_phone_key TEXT NOT NULL,
  start_boundary DATE NOT NULL,
  occurrence_date DATE NOT NULL,
  range_delta BIGINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (
    generation, business_phone_key, start_boundary, occurrence_date
  )
);
CREATE INDEX IF NOT EXISTS idx_message_analytics_phone_range_delta_query
  ON message_analytics_phone_range_delta(
    generation, start_boundary, occurrence_date, business_phone_key
  ) INCLUDE (range_delta);

-- Agrega la identidad del numero a la comparacion del trigger compartido. La
-- funcion sigue escribiendo exclusivamente una llave deduplicada de la cola.
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
        NEW.message_timestamp, NEW.created_at, NEW.business_phone,
        NEW.business_phone_number_id, NEW.detected_ctwa_clid,
        NEW.detected_source_id, NEW.detected_source_url, NEW.detected_source_type,
        NEW.detected_source_app, NEW.detected_entry_point
      ) IS NOT DISTINCT FROM ROW(
        OLD.contact_id, OLD.phone, OLD.whatsapp_api_contact_id, OLD.direction,
        OLD.message_timestamp, OLD.created_at, OLD.business_phone,
        OLD.business_phone_number_id, OLD.detected_ctwa_clid,
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
  created_at, business_phone, business_phone_number_id, detected_ctwa_clid,
  detected_source_id, detected_source_url, detected_source_type,
  detected_source_app, detected_entry_point
ON whatsapp_api_messages
FOR EACH ROW EXECUTE FUNCTION enqueue_message_analytics_change('whatsapp');
