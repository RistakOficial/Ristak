ALTER TABLE whatsapp_api_messages
  ADD COLUMN IF NOT EXISTS first_seen_projection_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE meta_social_messages
  ADD COLUMN IF NOT EXISTS first_seen_projection_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE email_messages
  ADD COLUMN IF NOT EXISTS first_seen_projection_version INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS message_first_seen_ledger (
  source_kind TEXT NOT NULL CHECK (source_kind IN ('whatsapp', 'meta', 'email')),
  source_message_id TEXT NOT NULL,
  projection_version INTEGER NOT NULL DEFAULT 1,
  included INTEGER NOT NULL DEFAULT 0,
  identity_key TEXT NOT NULL,
  contact_id TEXT,
  first_seen_at TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (source_kind, source_message_id)
);

CREATE TABLE IF NOT EXISTS message_identity_first_seen_global (
  identity_key TEXT PRIMARY KEY,
  first_seen_at TIMESTAMP NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('whatsapp', 'meta', 'email')),
  source_message_id TEXT NOT NULL,
  contact_id TEXT,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS message_identity_first_seen_source (
  source_kind TEXT NOT NULL CHECK (source_kind IN ('whatsapp', 'meta', 'email')),
  identity_key TEXT NOT NULL,
  first_seen_at TIMESTAMP NOT NULL,
  source_message_id TEXT NOT NULL,
  contact_id TEXT,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (source_kind, identity_key)
);

CREATE TABLE IF NOT EXISTS message_first_seen_projection_state (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  projection_version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'backfilling'
    CHECK (status IN ('backfilling', 'ready', 'failed')),
  last_error TEXT,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO message_first_seen_projection_state (
  singleton_id, projection_version, status
) VALUES (1, 1, 'backfilling')
ON CONFLICT(singleton_id) DO UPDATE SET
  projection_version = EXCLUDED.projection_version,
  status = CASE
    WHEN message_first_seen_projection_state.projection_version = EXCLUDED.projection_version
      THEN message_first_seen_projection_state.status
    ELSE 'backfilling'
  END,
  updated_at = CURRENT_TIMESTAMP;

-- Estas tablas nacen vacias; crear sus indices aqui no bloquea historial raw.
CREATE INDEX IF NOT EXISTS idx_message_first_seen_ledger_global_min
  ON message_first_seen_ledger(identity_key, first_seen_at, source_kind, source_message_id)
  INCLUDE (contact_id)
  WHERE included = 1 AND first_seen_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_message_first_seen_ledger_source_min
  ON message_first_seen_ledger(source_kind, identity_key, first_seen_at, source_message_id)
  INCLUDE (contact_id)
  WHERE included = 1 AND first_seen_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_message_first_seen_global_range
  ON message_identity_first_seen_global(first_seen_at, identity_key)
  INCLUDE (contact_id);
CREATE INDEX IF NOT EXISTS idx_message_first_seen_source_range
  ON message_identity_first_seen_source(source_kind, first_seen_at, identity_key)
  INCLUDE (contact_id);

-- Las vistas copian literalmente el contrato legacy de identidad y direccion.
CREATE OR REPLACE VIEW ristak_message_first_seen_whatsapp_source AS
SELECT
  'whatsapp'::text AS source_kind,
  msg.id AS source_message_id,
  1 AS projection_version,
  CASE
    WHEN LOWER(COALESCE(msg.direction, 'inbound')) = 'inbound'
      AND COALESCE(msg.message_timestamp, msg.created_at) IS NOT NULL THEN 1
    ELSE 0
  END AS included,
  CASE
    WHEN COALESCE(msg.contact_id, '') != '' THEN 'contact:' || msg.contact_id
    WHEN COALESCE(msg.phone, '') != '' THEN 'phone:' || msg.phone
    WHEN COALESCE(msg.whatsapp_api_contact_id, '') != '' THEN 'whatsapp-profile:' || msg.whatsapp_api_contact_id
    ELSE 'message:' || msg.id
  END AS identity_key,
  msg.contact_id,
  COALESCE(msg.message_timestamp, msg.created_at) AS first_seen_at
FROM whatsapp_api_messages msg;

CREATE OR REPLACE VIEW ristak_message_first_seen_meta_source AS
SELECT
  'meta'::text AS source_kind,
  msg.id AS source_message_id,
  1 AS projection_version,
  CASE
    WHEN LOWER(COALESCE(msg.direction, 'inbound')) = 'inbound'
      AND COALESCE(msg.message_timestamp, msg.created_at) IS NOT NULL THEN 1
    ELSE 0
  END AS included,
  CASE
    WHEN COALESCE(msg.contact_id, '') != '' THEN 'contact:' || msg.contact_id
    WHEN COALESCE(msg.sender_id, '') != '' THEN 'meta:' || COALESCE(msg.platform, 'messenger') || ':' || msg.sender_id
    WHEN COALESCE(msg.meta_social_contact_id, '') != '' THEN 'meta-profile:' || msg.meta_social_contact_id
    ELSE 'message:' || msg.id
  END AS identity_key,
  msg.contact_id,
  COALESCE(msg.message_timestamp, msg.created_at) AS first_seen_at
FROM meta_social_messages msg;

CREATE OR REPLACE VIEW ristak_message_first_seen_email_source AS
SELECT
  'email'::text AS source_kind,
  msg.id AS source_message_id,
  1 AS projection_version,
  CASE
    WHEN LOWER(COALESCE(msg.direction, 'outbound')) = 'inbound'
      AND COALESCE(msg.message_timestamp, msg.created_at) IS NOT NULL THEN 1
    ELSE 0
  END AS included,
  CASE
    WHEN COALESCE(msg.contact_id, '') != '' THEN 'contact:' || msg.contact_id
    WHEN COALESCE(msg.from_email, '') != '' THEN 'email:' || LOWER(msg.from_email)
    ELSE 'message:' || msg.id
  END AS identity_key,
  msg.contact_id,
  COALESCE(msg.message_timestamp, msg.created_at) AS first_seen_at
FROM email_messages msg;

CREATE OR REPLACE FUNCTION ristak_message_first_seen_ledger_insert()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.included != 1 OR NEW.first_seen_at IS NULL THEN RETURN NEW; END IF;

  INSERT INTO message_identity_first_seen_global (
    identity_key, first_seen_at, source_kind, source_message_id, contact_id, updated_at
  ) VALUES (
    NEW.identity_key, NEW.first_seen_at, NEW.source_kind,
    NEW.source_message_id, NEW.contact_id, CURRENT_TIMESTAMP
  )
  ON CONFLICT(identity_key) DO UPDATE SET
    first_seen_at = EXCLUDED.first_seen_at,
    source_kind = EXCLUDED.source_kind,
    source_message_id = EXCLUDED.source_message_id,
    contact_id = EXCLUDED.contact_id,
    updated_at = CURRENT_TIMESTAMP
  WHERE (
    EXCLUDED.first_seen_at, EXCLUDED.source_kind, EXCLUDED.source_message_id
  ) < (
    message_identity_first_seen_global.first_seen_at,
    message_identity_first_seen_global.source_kind,
    message_identity_first_seen_global.source_message_id
  );

  INSERT INTO message_identity_first_seen_source (
    source_kind, identity_key, first_seen_at, source_message_id, contact_id, updated_at
  ) VALUES (
    NEW.source_kind, NEW.identity_key, NEW.first_seen_at,
    NEW.source_message_id, NEW.contact_id, CURRENT_TIMESTAMP
  )
  ON CONFLICT(source_kind, identity_key) DO UPDATE SET
    first_seen_at = EXCLUDED.first_seen_at,
    source_message_id = EXCLUDED.source_message_id,
    contact_id = EXCLUDED.contact_id,
    updated_at = CURRENT_TIMESTAMP
  WHERE (
    EXCLUDED.first_seen_at, EXCLUDED.source_message_id
  ) < (
    message_identity_first_seen_source.first_seen_at,
    message_identity_first_seen_source.source_message_id
  );

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ristak_message_first_seen_ledger_delete()
RETURNS TRIGGER AS $$
DECLARE
  removed_global BOOLEAN := FALSE;
  removed_source BOOLEAN := FALSE;
BEGIN
  IF OLD.included != 1 OR OLD.first_seen_at IS NULL THEN RETURN OLD; END IF;

  DELETE FROM message_identity_first_seen_global
  WHERE identity_key = OLD.identity_key
    AND source_kind = OLD.source_kind
    AND source_message_id = OLD.source_message_id;
  removed_global := FOUND;

  IF removed_global THEN
    INSERT INTO message_identity_first_seen_global (
      identity_key, first_seen_at, source_kind, source_message_id, contact_id, updated_at
    )
    SELECT
      candidate.identity_key, candidate.first_seen_at, candidate.source_kind,
      candidate.source_message_id, candidate.contact_id, CURRENT_TIMESTAMP
    FROM message_first_seen_ledger candidate
    WHERE candidate.identity_key = OLD.identity_key
      AND candidate.included = 1
      AND candidate.first_seen_at IS NOT NULL
    ORDER BY candidate.first_seen_at, candidate.source_kind, candidate.source_message_id
    LIMIT 1
    ON CONFLICT(identity_key) DO NOTHING;
  END IF;

  DELETE FROM message_identity_first_seen_source
  WHERE source_kind = OLD.source_kind
    AND identity_key = OLD.identity_key
    AND source_message_id = OLD.source_message_id;
  removed_source := FOUND;

  IF removed_source THEN
    INSERT INTO message_identity_first_seen_source (
      source_kind, identity_key, first_seen_at, source_message_id, contact_id, updated_at
    )
    SELECT
      candidate.source_kind, candidate.identity_key, candidate.first_seen_at,
      candidate.source_message_id, candidate.contact_id, CURRENT_TIMESTAMP
    FROM message_first_seen_ledger candidate
    WHERE candidate.source_kind = OLD.source_kind
      AND candidate.identity_key = OLD.identity_key
      AND candidate.included = 1
      AND candidate.first_seen_at IS NOT NULL
    ORDER BY candidate.first_seen_at, candidate.source_message_id
    LIMIT 1
    ON CONFLICT(source_kind, identity_key) DO NOTHING;
  END IF;

  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_message_first_seen_ledger_insert ON message_first_seen_ledger;
CREATE TRIGGER trg_message_first_seen_ledger_insert
AFTER INSERT ON message_first_seen_ledger
FOR EACH ROW EXECUTE FUNCTION ristak_message_first_seen_ledger_insert();
DROP TRIGGER IF EXISTS trg_message_first_seen_ledger_delete ON message_first_seen_ledger;
CREATE TRIGGER trg_message_first_seen_ledger_delete
AFTER DELETE ON message_first_seen_ledger
FOR EACH ROW EXECUTE FUNCTION ristak_message_first_seen_ledger_delete();

CREATE OR REPLACE FUNCTION ristak_message_first_seen_mark_projected()
RETURNS TRIGGER AS $$
BEGIN
  NEW.first_seen_projection_version := 1;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ristak_message_first_seen_reproject_source_row()
RETURNS TRIGGER AS $$
DECLARE
  kind TEXT := CASE TG_TABLE_NAME
    WHEN 'whatsapp_api_messages' THEN 'whatsapp'
    WHEN 'meta_social_messages' THEN 'meta'
    ELSE 'email'
  END;
BEGIN
  IF TG_OP != 'INSERT' THEN
    DELETE FROM message_first_seen_ledger
    WHERE source_kind = kind AND source_message_id = OLD.id;
  END IF;

  IF TG_OP != 'DELETE' THEN
    IF kind = 'whatsapp' THEN
      INSERT INTO message_first_seen_ledger (
        source_kind, source_message_id, projection_version, included,
        identity_key, contact_id, first_seen_at, updated_at
      )
      SELECT source_kind, source_message_id, projection_version, included,
             identity_key, contact_id, first_seen_at, CURRENT_TIMESTAMP
      FROM ristak_message_first_seen_whatsapp_source
      WHERE source_message_id = NEW.id;
    ELSIF kind = 'meta' THEN
      INSERT INTO message_first_seen_ledger (
        source_kind, source_message_id, projection_version, included,
        identity_key, contact_id, first_seen_at, updated_at
      )
      SELECT source_kind, source_message_id, projection_version, included,
             identity_key, contact_id, first_seen_at, CURRENT_TIMESTAMP
      FROM ristak_message_first_seen_meta_source
      WHERE source_message_id = NEW.id;
    ELSE
      INSERT INTO message_first_seen_ledger (
        source_kind, source_message_id, projection_version, included,
        identity_key, contact_id, first_seen_at, updated_at
      )
      SELECT source_kind, source_message_id, projection_version, included,
             identity_key, contact_id, first_seen_at, CURRENT_TIMESTAMP
      FROM ristak_message_first_seen_email_source
      WHERE source_message_id = NEW.id;
    END IF;
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_message_first_seen_whatsapp_version ON whatsapp_api_messages;
CREATE TRIGGER trg_message_first_seen_whatsapp_version
BEFORE INSERT OR UPDATE OF id, contact_id, phone, whatsapp_api_contact_id,
  direction, message_timestamp, created_at
ON whatsapp_api_messages
FOR EACH ROW EXECUTE FUNCTION ristak_message_first_seen_mark_projected();
DROP TRIGGER IF EXISTS trg_message_first_seen_whatsapp_sync ON whatsapp_api_messages;
CREATE TRIGGER trg_message_first_seen_whatsapp_sync
AFTER INSERT OR UPDATE OF id, contact_id, phone, whatsapp_api_contact_id,
  direction, message_timestamp, created_at OR DELETE
ON whatsapp_api_messages
FOR EACH ROW EXECUTE FUNCTION ristak_message_first_seen_reproject_source_row();

DROP TRIGGER IF EXISTS trg_message_first_seen_meta_version ON meta_social_messages;
CREATE TRIGGER trg_message_first_seen_meta_version
BEFORE INSERT OR UPDATE OF id, contact_id, sender_id, platform,
  meta_social_contact_id, direction, message_timestamp, created_at
ON meta_social_messages
FOR EACH ROW EXECUTE FUNCTION ristak_message_first_seen_mark_projected();
DROP TRIGGER IF EXISTS trg_message_first_seen_meta_sync ON meta_social_messages;
CREATE TRIGGER trg_message_first_seen_meta_sync
AFTER INSERT OR UPDATE OF id, contact_id, sender_id, platform,
  meta_social_contact_id, direction, message_timestamp, created_at OR DELETE
ON meta_social_messages
FOR EACH ROW EXECUTE FUNCTION ristak_message_first_seen_reproject_source_row();

DROP TRIGGER IF EXISTS trg_message_first_seen_email_version ON email_messages;
CREATE TRIGGER trg_message_first_seen_email_version
BEFORE INSERT OR UPDATE OF id, contact_id, from_email, direction,
  message_timestamp, created_at
ON email_messages
FOR EACH ROW EXECUTE FUNCTION ristak_message_first_seen_mark_projected();
DROP TRIGGER IF EXISTS trg_message_first_seen_email_sync ON email_messages;
CREATE TRIGGER trg_message_first_seen_email_sync
AFTER INSERT OR UPDATE OF id, contact_id, from_email, direction,
  message_timestamp, created_at OR DELETE
ON email_messages
FOR EACH ROW EXECUTE FUNCTION ristak_message_first_seen_reproject_source_row();
