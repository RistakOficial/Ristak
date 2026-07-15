-- Read model durable de Analiticas de mensajes. Los triggers deliberadamente
-- solo encolan O(1); ninguna escritura del inbox ejecuta agregados.
CREATE TABLE IF NOT EXISTS message_analytics_projection_state (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  projection_version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'backfilling'
    CHECK (status IN ('backfilling', 'replaying', 'ready', 'failed')),
  active_generation INTEGER,
  active_version INTEGER,
  active_timezone TEXT,
  building_generation INTEGER,
  building_version INTEGER,
  building_timezone TEXT,
  whatsapp_cursor TEXT NOT NULL DEFAULT '',
  meta_cursor TEXT NOT NULL DEFAULT '',
  email_cursor TEXT NOT NULL DEFAULT '',
  whatsapp_complete INTEGER NOT NULL DEFAULT 0 CHECK (whatsapp_complete IN (0, 1)),
  meta_complete INTEGER NOT NULL DEFAULT 0 CHECK (meta_complete IN (0, 1)),
  email_complete INTEGER NOT NULL DEFAULT 0 CHECK (email_complete IN (0, 1)),
  last_applied_at TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO message_analytics_projection_state(singleton_id, projection_version, status)
VALUES (1, 1, 'backfilling')
ON CONFLICT(singleton_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS message_analytics_change_queue (
  source_kind TEXT NOT NULL CHECK (source_kind IN ('whatsapp', 'meta', 'email')),
  source_message_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  active_applied_revision INTEGER NOT NULL DEFAULT 0 CHECK (active_applied_revision >= 0),
  building_applied_revision INTEGER NOT NULL DEFAULT 0 CHECK (building_applied_revision >= 0),
  enqueued_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (source_kind, source_message_id)
);

CREATE INDEX IF NOT EXISTS idx_message_analytics_change_queue_order
  ON message_analytics_change_queue(enqueued_at, source_kind, source_message_id);

CREATE TABLE IF NOT EXISTS message_analytics_contact_queue (
  contact_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  cursor_message_id TEXT NOT NULL DEFAULT '',
  enqueued_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_message_analytics_contact_queue_order
  ON message_analytics_contact_queue(enqueued_at, contact_id);

CREATE TABLE IF NOT EXISTS message_analytics_generation_gc (
  generation INTEGER PRIMARY KEY,
  eligible_at TEXT NOT NULL,
  enqueued_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_message_analytics_generation_gc_due
  ON message_analytics_generation_gc(eligible_at, generation);

CREATE TABLE IF NOT EXISTS message_analytics_fact (
  generation INTEGER NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('whatsapp', 'meta', 'email')),
  source_message_id TEXT NOT NULL,
  projection_version INTEGER NOT NULL DEFAULT 1,
  included INTEGER NOT NULL DEFAULT 0 CHECK (included IN (0, 1)),
  occurred_at TEXT,
  business_date TEXT,
  identity_key TEXT NOT NULL DEFAULT '',
  contact_id TEXT,
  contact_key TEXT NOT NULL DEFAULT '',
  channel TEXT NOT NULL DEFAULT '',
  channel_label TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  attributed INTEGER NOT NULL DEFAULT 0 CHECK (attributed IN (0, 1)),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (generation, source_kind, source_message_id)
);

CREATE INDEX IF NOT EXISTS idx_message_analytics_fact_date
  ON message_analytics_fact(
    generation, business_date, channel, source, identity_key, contact_key,
    occurred_at, source_kind, source_message_id
  )
  WHERE included = 1;
CREATE INDEX IF NOT EXISTS idx_message_analytics_fact_contact
  ON message_analytics_fact(generation, contact_id)
  WHERE included = 1 AND contact_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS message_analytics_daily_identity (
  generation INTEGER NOT NULL,
  business_date TEXT NOT NULL,
  channel TEXT NOT NULL,
  source TEXT NOT NULL,
  identity_key TEXT NOT NULL,
  contact_key TEXT NOT NULL DEFAULT '',
  contact_id TEXT,
  channel_label TEXT NOT NULL DEFAULT '',
  message_count INTEGER NOT NULL DEFAULT 0 CHECK (message_count >= 0),
  attributed_message_count INTEGER NOT NULL DEFAULT 0
    CHECK (attributed_message_count >= 0 AND attributed_message_count <= message_count),
  first_occurred_at TEXT NOT NULL,
  first_source_kind TEXT NOT NULL,
  first_source_message_id TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (generation, business_date, channel, source, identity_key, contact_key)
);

CREATE INDEX IF NOT EXISTS idx_message_analytics_daily_metrics
  ON message_analytics_daily_identity(
    generation, business_date, identity_key, message_count, attributed_message_count
  );
CREATE INDEX IF NOT EXISTS idx_message_analytics_daily_channel
  ON message_analytics_daily_identity(
    generation, business_date, channel, identity_key, channel_label
  );
CREATE INDEX IF NOT EXISTS idx_message_analytics_daily_source
  ON message_analytics_daily_identity(generation, business_date, source, identity_key);
CREATE INDEX IF NOT EXISTS idx_message_analytics_daily_contact
  ON message_analytics_daily_identity(generation, contact_id, business_date);
CREATE INDEX IF NOT EXISTS idx_message_analytics_whatsapp_contact_cursor
  ON whatsapp_api_messages(contact_id, id);

-- Fuentes de mensajes: INSERT/UPDATE/DELETE solo deduplican una llave.
DROP TRIGGER IF EXISTS trg_message_analytics_whatsapp_insert;
CREATE TRIGGER trg_message_analytics_whatsapp_insert AFTER INSERT ON whatsapp_api_messages BEGIN
  INSERT INTO message_analytics_change_queue(source_kind, source_message_id, revision, enqueued_at)
  VALUES ('whatsapp', NEW.id, 1, CURRENT_TIMESTAMP)
  ON CONFLICT(source_kind, source_message_id) DO UPDATE SET
    revision = message_analytics_change_queue.revision + 1,
    enqueued_at = CURRENT_TIMESTAMP;
END;
DROP TRIGGER IF EXISTS trg_message_analytics_whatsapp_update;
CREATE TRIGGER trg_message_analytics_whatsapp_update
AFTER UPDATE OF contact_id, phone, whatsapp_api_contact_id, direction,
  message_timestamp, created_at, detected_ctwa_clid, detected_source_id,
  detected_source_url, detected_source_type, detected_source_app,
  detected_entry_point
ON whatsapp_api_messages
WHEN NEW.contact_id IS NOT OLD.contact_id
  OR NEW.phone IS NOT OLD.phone
  OR NEW.whatsapp_api_contact_id IS NOT OLD.whatsapp_api_contact_id
  OR NEW.direction IS NOT OLD.direction
  OR NEW.message_timestamp IS NOT OLD.message_timestamp
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.detected_ctwa_clid IS NOT OLD.detected_ctwa_clid
  OR NEW.detected_source_id IS NOT OLD.detected_source_id
  OR NEW.detected_source_url IS NOT OLD.detected_source_url
  OR NEW.detected_source_type IS NOT OLD.detected_source_type
  OR NEW.detected_source_app IS NOT OLD.detected_source_app
  OR NEW.detected_entry_point IS NOT OLD.detected_entry_point
BEGIN
  INSERT INTO message_analytics_change_queue(source_kind, source_message_id, revision, enqueued_at)
  VALUES ('whatsapp', NEW.id, 1, CURRENT_TIMESTAMP)
  ON CONFLICT(source_kind, source_message_id) DO UPDATE SET
    revision = message_analytics_change_queue.revision + 1,
    enqueued_at = CURRENT_TIMESTAMP;
END;
DROP TRIGGER IF EXISTS trg_message_analytics_whatsapp_delete;
CREATE TRIGGER trg_message_analytics_whatsapp_delete AFTER DELETE ON whatsapp_api_messages BEGIN
  INSERT INTO message_analytics_change_queue(source_kind, source_message_id, revision, enqueued_at)
  VALUES ('whatsapp', OLD.id, 1, CURRENT_TIMESTAMP)
  ON CONFLICT(source_kind, source_message_id) DO UPDATE SET
    revision = message_analytics_change_queue.revision + 1,
    enqueued_at = CURRENT_TIMESTAMP;
END;

DROP TRIGGER IF EXISTS trg_message_analytics_meta_insert;
CREATE TRIGGER trg_message_analytics_meta_insert AFTER INSERT ON meta_social_messages BEGIN
  INSERT INTO message_analytics_change_queue(source_kind, source_message_id, revision, enqueued_at)
  VALUES ('meta', NEW.id, 1, CURRENT_TIMESTAMP)
  ON CONFLICT(source_kind, source_message_id) DO UPDATE SET
    revision = message_analytics_change_queue.revision + 1,
    enqueued_at = CURRENT_TIMESTAMP;
END;
DROP TRIGGER IF EXISTS trg_message_analytics_meta_update;
CREATE TRIGGER trg_message_analytics_meta_update
AFTER UPDATE OF platform, meta_social_contact_id, contact_id, sender_id,
  direction, message_timestamp, created_at, referral_json
ON meta_social_messages
WHEN NEW.platform IS NOT OLD.platform
  OR NEW.meta_social_contact_id IS NOT OLD.meta_social_contact_id
  OR NEW.contact_id IS NOT OLD.contact_id
  OR NEW.sender_id IS NOT OLD.sender_id
  OR NEW.direction IS NOT OLD.direction
  OR NEW.message_timestamp IS NOT OLD.message_timestamp
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.referral_json IS NOT OLD.referral_json
BEGIN
  INSERT INTO message_analytics_change_queue(source_kind, source_message_id, revision, enqueued_at)
  VALUES ('meta', NEW.id, 1, CURRENT_TIMESTAMP)
  ON CONFLICT(source_kind, source_message_id) DO UPDATE SET
    revision = message_analytics_change_queue.revision + 1,
    enqueued_at = CURRENT_TIMESTAMP;
END;
DROP TRIGGER IF EXISTS trg_message_analytics_meta_delete;
CREATE TRIGGER trg_message_analytics_meta_delete AFTER DELETE ON meta_social_messages BEGIN
  INSERT INTO message_analytics_change_queue(source_kind, source_message_id, revision, enqueued_at)
  VALUES ('meta', OLD.id, 1, CURRENT_TIMESTAMP)
  ON CONFLICT(source_kind, source_message_id) DO UPDATE SET
    revision = message_analytics_change_queue.revision + 1,
    enqueued_at = CURRENT_TIMESTAMP;
END;

DROP TRIGGER IF EXISTS trg_message_analytics_email_insert;
CREATE TRIGGER trg_message_analytics_email_insert AFTER INSERT ON email_messages BEGIN
  INSERT INTO message_analytics_change_queue(source_kind, source_message_id, revision, enqueued_at)
  VALUES ('email', NEW.id, 1, CURRENT_TIMESTAMP)
  ON CONFLICT(source_kind, source_message_id) DO UPDATE SET
    revision = message_analytics_change_queue.revision + 1,
    enqueued_at = CURRENT_TIMESTAMP;
END;
DROP TRIGGER IF EXISTS trg_message_analytics_email_update;
CREATE TRIGGER trg_message_analytics_email_update
AFTER UPDATE OF contact_id, direction, from_email, message_timestamp, created_at
ON email_messages
WHEN NEW.contact_id IS NOT OLD.contact_id
  OR NEW.direction IS NOT OLD.direction
  OR NEW.from_email IS NOT OLD.from_email
  OR NEW.message_timestamp IS NOT OLD.message_timestamp
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  INSERT INTO message_analytics_change_queue(source_kind, source_message_id, revision, enqueued_at)
  VALUES ('email', NEW.id, 1, CURRENT_TIMESTAMP)
  ON CONFLICT(source_kind, source_message_id) DO UPDATE SET
    revision = message_analytics_change_queue.revision + 1,
    enqueued_at = CURRENT_TIMESTAMP;
END;
DROP TRIGGER IF EXISTS trg_message_analytics_email_delete;
CREATE TRIGGER trg_message_analytics_email_delete AFTER DELETE ON email_messages BEGIN
  INSERT INTO message_analytics_change_queue(source_kind, source_message_id, revision, enqueued_at)
  VALUES ('email', OLD.id, 1, CURRENT_TIMESTAMP)
  ON CONFLICT(source_kind, source_message_id) DO UPDATE SET
    revision = message_analytics_change_queue.revision + 1,
    enqueued_at = CURRENT_TIMESTAMP;
END;

-- Varias filas de atribucion para un mensaje siguen produciendo una sola llave
-- de trabajo. El worker combina todas las señales de forma determinista.
DROP TRIGGER IF EXISTS trg_message_analytics_attribution_insert;
CREATE TRIGGER trg_message_analytics_attribution_insert
AFTER INSERT ON whatsapp_api_attribution
WHEN NEW.whatsapp_api_message_id IS NOT NULL
BEGIN
  INSERT INTO message_analytics_change_queue(source_kind, source_message_id, revision, enqueued_at)
  VALUES ('whatsapp', NEW.whatsapp_api_message_id, 1, CURRENT_TIMESTAMP)
  ON CONFLICT(source_kind, source_message_id) DO UPDATE SET
    revision = message_analytics_change_queue.revision + 1,
    enqueued_at = CURRENT_TIMESTAMP;
END;
DROP TRIGGER IF EXISTS trg_message_analytics_attribution_update;
CREATE TRIGGER trg_message_analytics_attribution_update
AFTER UPDATE OF whatsapp_api_message_id, detected_source_id, detected_ctwa_clid,
  detected_source_url, detected_source_type, detected_source_app,
  detected_entry_point
ON whatsapp_api_attribution
WHEN NEW.whatsapp_api_message_id IS NOT OLD.whatsapp_api_message_id
  OR NEW.detected_source_id IS NOT OLD.detected_source_id
  OR NEW.detected_ctwa_clid IS NOT OLD.detected_ctwa_clid
  OR NEW.detected_source_url IS NOT OLD.detected_source_url
  OR NEW.detected_source_type IS NOT OLD.detected_source_type
  OR NEW.detected_source_app IS NOT OLD.detected_source_app
  OR NEW.detected_entry_point IS NOT OLD.detected_entry_point
BEGIN
  INSERT INTO message_analytics_change_queue(source_kind, source_message_id, revision, enqueued_at)
  SELECT 'whatsapp', OLD.whatsapp_api_message_id, 1, CURRENT_TIMESTAMP
  WHERE OLD.whatsapp_api_message_id IS NOT NULL
  ON CONFLICT(source_kind, source_message_id) DO UPDATE SET
    revision = message_analytics_change_queue.revision + 1,
    enqueued_at = CURRENT_TIMESTAMP;
  INSERT INTO message_analytics_change_queue(source_kind, source_message_id, revision, enqueued_at)
  SELECT 'whatsapp', NEW.whatsapp_api_message_id, 1, CURRENT_TIMESTAMP
  WHERE NEW.whatsapp_api_message_id IS NOT NULL
    AND NEW.whatsapp_api_message_id IS NOT OLD.whatsapp_api_message_id
  ON CONFLICT(source_kind, source_message_id) DO UPDATE SET
    revision = message_analytics_change_queue.revision + 1,
    enqueued_at = CURRENT_TIMESTAMP;
END;
DROP TRIGGER IF EXISTS trg_message_analytics_attribution_delete;
CREATE TRIGGER trg_message_analytics_attribution_delete
AFTER DELETE ON whatsapp_api_attribution
WHEN OLD.whatsapp_api_message_id IS NOT NULL
BEGIN
  INSERT INTO message_analytics_change_queue(source_kind, source_message_id, revision, enqueued_at)
  VALUES ('whatsapp', OLD.whatsapp_api_message_id, 1, CURRENT_TIMESTAMP)
  ON CONFLICT(source_kind, source_message_id) DO UPDATE SET
    revision = message_analytics_change_queue.revision + 1,
    enqueued_at = CURRENT_TIMESTAMP;
END;

-- Un cambio de atribucion del contacto se expande en lotes por el worker; el
-- trigger nunca hace fanout sobre mensajes.
DROP TRIGGER IF EXISTS trg_message_analytics_contact_attribution_update;
CREATE TRIGGER trg_message_analytics_contact_attribution_update
AFTER UPDATE OF source, attribution_url, attribution_session_source,
  attribution_medium, attribution_ctwa_clid, attribution_ad_id
ON contacts
WHEN NEW.source IS NOT OLD.source
  OR NEW.attribution_url IS NOT OLD.attribution_url
  OR NEW.attribution_session_source IS NOT OLD.attribution_session_source
  OR NEW.attribution_medium IS NOT OLD.attribution_medium
  OR NEW.attribution_ctwa_clid IS NOT OLD.attribution_ctwa_clid
  OR NEW.attribution_ad_id IS NOT OLD.attribution_ad_id
BEGIN
  INSERT INTO message_analytics_contact_queue(contact_id, revision, cursor_message_id, enqueued_at)
  VALUES (NEW.id, 1, '', CURRENT_TIMESTAMP)
  ON CONFLICT(contact_id) DO UPDATE SET
    revision = message_analytics_contact_queue.revision + 1,
    cursor_message_id = '',
    enqueued_at = CURRENT_TIMESTAMP;
END;
