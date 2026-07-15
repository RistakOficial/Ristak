-- Primer inbound por identidad. El ledger conserva tambien sentinels outbound o
-- sin fecha para que readiness demuestre cobertura total de las tres fuentes.
CREATE TABLE IF NOT EXISTS message_first_seen_ledger (
  source_kind TEXT NOT NULL CHECK (source_kind IN ('whatsapp', 'meta', 'email')),
  source_message_id TEXT NOT NULL,
  projection_version INTEGER NOT NULL DEFAULT 1,
  included INTEGER NOT NULL DEFAULT 0,
  identity_key TEXT NOT NULL,
  contact_id TEXT,
  first_seen_at DATETIME,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (source_kind, source_message_id)
);

CREATE TABLE IF NOT EXISTS message_identity_first_seen_global (
  identity_key TEXT PRIMARY KEY,
  first_seen_at DATETIME NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('whatsapp', 'meta', 'email')),
  source_message_id TEXT NOT NULL,
  contact_id TEXT,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS message_identity_first_seen_source (
  source_kind TEXT NOT NULL CHECK (source_kind IN ('whatsapp', 'meta', 'email')),
  identity_key TEXT NOT NULL,
  first_seen_at DATETIME NOT NULL,
  source_message_id TEXT NOT NULL,
  contact_id TEXT,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (source_kind, identity_key)
);

CREATE TABLE IF NOT EXISTS message_first_seen_projection_state (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  projection_version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'backfilling'
    CHECK (status IN ('backfilling', 'ready', 'failed')),
  last_error TEXT,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO message_first_seen_projection_state (
  singleton_id, projection_version, status
) VALUES (1, 1, 'backfilling')
ON CONFLICT(singleton_id) DO UPDATE SET
  projection_version = excluded.projection_version,
  status = CASE
    WHEN message_first_seen_projection_state.projection_version = excluded.projection_version
      THEN message_first_seen_projection_state.status
    ELSE 'backfilling'
  END,
  updated_at = CURRENT_TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_message_first_seen_ledger_global_min
  ON message_first_seen_ledger(identity_key, first_seen_at, source_kind, source_message_id)
  WHERE included = 1 AND first_seen_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_message_first_seen_ledger_source_min
  ON message_first_seen_ledger(source_kind, identity_key, first_seen_at, source_message_id)
  WHERE included = 1 AND first_seen_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_message_first_seen_global_range
  ON message_identity_first_seen_global(first_seen_at, identity_key);
CREATE INDEX IF NOT EXISTS idx_message_first_seen_source_range
  ON message_identity_first_seen_source(source_kind, first_seen_at, identity_key);
CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_first_seen_pending
  ON whatsapp_api_messages(id) WHERE first_seen_projection_version < 1;
CREATE INDEX IF NOT EXISTS idx_meta_messages_first_seen_pending
  ON meta_social_messages(id) WHERE first_seen_projection_version < 1;
CREATE INDEX IF NOT EXISTS idx_email_messages_first_seen_pending
  ON email_messages(id) WHERE first_seen_projection_version < 1;

-- Las identidades y defaults son deliberadamente literales: cambiar trim,
-- normalizacion o prioridad aqui alteraria las tarjetas historicas existentes.
DROP VIEW IF EXISTS ristak_message_first_seen_whatsapp_source;
CREATE VIEW ristak_message_first_seen_whatsapp_source AS
SELECT
  'whatsapp' AS source_kind,
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

DROP VIEW IF EXISTS ristak_message_first_seen_meta_source;
CREATE VIEW ristak_message_first_seen_meta_source AS
SELECT
  'meta' AS source_kind,
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

DROP VIEW IF EXISTS ristak_message_first_seen_email_source;
CREATE VIEW ristak_message_first_seen_email_source AS
SELECT
  'email' AS source_kind,
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

-- Insert es O(1): solo compara el candidato contra las dos filas summary.
DROP TRIGGER IF EXISTS trg_message_first_seen_ledger_insert;
CREATE TRIGGER trg_message_first_seen_ledger_insert
AFTER INSERT ON message_first_seen_ledger
WHEN NEW.included = 1 AND NEW.first_seen_at IS NOT NULL
BEGIN
  INSERT INTO message_identity_first_seen_global (
    identity_key, first_seen_at, source_kind, source_message_id, contact_id, updated_at
  ) VALUES (
    NEW.identity_key, NEW.first_seen_at, NEW.source_kind,
    NEW.source_message_id, NEW.contact_id, CURRENT_TIMESTAMP
  )
  ON CONFLICT(identity_key) DO UPDATE SET
    first_seen_at = excluded.first_seen_at,
    source_kind = excluded.source_kind,
    source_message_id = excluded.source_message_id,
    contact_id = excluded.contact_id,
    updated_at = CURRENT_TIMESTAMP
  WHERE excluded.first_seen_at < message_identity_first_seen_global.first_seen_at
     OR (
       excluded.first_seen_at = message_identity_first_seen_global.first_seen_at
       AND excluded.source_kind < message_identity_first_seen_global.source_kind
     )
     OR (
       excluded.first_seen_at = message_identity_first_seen_global.first_seen_at
       AND excluded.source_kind = message_identity_first_seen_global.source_kind
       AND excluded.source_message_id < message_identity_first_seen_global.source_message_id
     );

  INSERT INTO message_identity_first_seen_source (
    source_kind, identity_key, first_seen_at, source_message_id, contact_id, updated_at
  ) VALUES (
    NEW.source_kind, NEW.identity_key, NEW.first_seen_at,
    NEW.source_message_id, NEW.contact_id, CURRENT_TIMESTAMP
  )
  ON CONFLICT(source_kind, identity_key) DO UPDATE SET
    first_seen_at = excluded.first_seen_at,
    source_message_id = excluded.source_message_id,
    contact_id = excluded.contact_id,
    updated_at = CURRENT_TIMESTAMP
  WHERE excluded.first_seen_at < message_identity_first_seen_source.first_seen_at
     OR (
       excluded.first_seen_at = message_identity_first_seen_source.first_seen_at
       AND excluded.source_message_id < message_identity_first_seen_source.source_message_id
     );
END;

-- Delete/update solo busca reemplazo cuando la fila removida era el minimo. El
-- ORDER BY esta cubierto por los dos indices parciales del ledger.
DROP TRIGGER IF EXISTS trg_message_first_seen_ledger_delete;
CREATE TRIGGER trg_message_first_seen_ledger_delete
AFTER DELETE ON message_first_seen_ledger
WHEN OLD.included = 1 AND OLD.first_seen_at IS NOT NULL
BEGIN
  DELETE FROM message_identity_first_seen_global
  WHERE identity_key = OLD.identity_key
    AND source_kind = OLD.source_kind
    AND source_message_id = OLD.source_message_id;

  INSERT OR IGNORE INTO message_identity_first_seen_global (
    identity_key, first_seen_at, source_kind, source_message_id, contact_id, updated_at
  )
  SELECT
    candidate.identity_key, candidate.first_seen_at, candidate.source_kind,
    candidate.source_message_id, candidate.contact_id, CURRENT_TIMESTAMP
  FROM message_first_seen_ledger candidate
  WHERE candidate.identity_key = OLD.identity_key
    AND candidate.included = 1
    AND candidate.first_seen_at IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM message_identity_first_seen_global summary
      WHERE summary.identity_key = OLD.identity_key
    )
  ORDER BY candidate.first_seen_at, candidate.source_kind, candidate.source_message_id
  LIMIT 1;

  DELETE FROM message_identity_first_seen_source
  WHERE source_kind = OLD.source_kind
    AND identity_key = OLD.identity_key
    AND source_message_id = OLD.source_message_id;

  INSERT OR IGNORE INTO message_identity_first_seen_source (
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
    AND NOT EXISTS (
      SELECT 1 FROM message_identity_first_seen_source summary
      WHERE summary.source_kind = OLD.source_kind
        AND summary.identity_key = OLD.identity_key
    )
  ORDER BY candidate.first_seen_at, candidate.source_message_id
  LIMIT 1;
END;

-- Cada UPDATE se modela como old -> new dentro de la misma transaccion.
DROP TRIGGER IF EXISTS trg_message_first_seen_whatsapp_insert;
CREATE TRIGGER trg_message_first_seen_whatsapp_insert
AFTER INSERT ON whatsapp_api_messages
BEGIN
  INSERT INTO message_first_seen_ledger (
    source_kind, source_message_id, projection_version, included,
    identity_key, contact_id, first_seen_at, updated_at
  )
  SELECT source_kind, source_message_id, projection_version, included,
         identity_key, contact_id, first_seen_at, CURRENT_TIMESTAMP
  FROM ristak_message_first_seen_whatsapp_source
  WHERE source_message_id = NEW.id;
  UPDATE whatsapp_api_messages
  SET first_seen_projection_version = 1
  WHERE id = NEW.id;
END;

DROP TRIGGER IF EXISTS trg_message_first_seen_whatsapp_update;
CREATE TRIGGER trg_message_first_seen_whatsapp_update
AFTER UPDATE OF id, contact_id, phone, whatsapp_api_contact_id, direction, message_timestamp, created_at
ON whatsapp_api_messages
BEGIN
  DELETE FROM message_first_seen_ledger
  WHERE source_kind = 'whatsapp' AND source_message_id = OLD.id;
  INSERT INTO message_first_seen_ledger (
    source_kind, source_message_id, projection_version, included,
    identity_key, contact_id, first_seen_at, updated_at
  )
  SELECT source_kind, source_message_id, projection_version, included,
         identity_key, contact_id, first_seen_at, CURRENT_TIMESTAMP
  FROM ristak_message_first_seen_whatsapp_source
  WHERE source_message_id = NEW.id;
  UPDATE whatsapp_api_messages
  SET first_seen_projection_version = 1
  WHERE id = NEW.id;
END;

DROP TRIGGER IF EXISTS trg_message_first_seen_whatsapp_delete;
CREATE TRIGGER trg_message_first_seen_whatsapp_delete
AFTER DELETE ON whatsapp_api_messages
BEGIN
  DELETE FROM message_first_seen_ledger
  WHERE source_kind = 'whatsapp' AND source_message_id = OLD.id;
END;

DROP TRIGGER IF EXISTS trg_message_first_seen_meta_insert;
CREATE TRIGGER trg_message_first_seen_meta_insert
AFTER INSERT ON meta_social_messages
BEGIN
  INSERT INTO message_first_seen_ledger (
    source_kind, source_message_id, projection_version, included,
    identity_key, contact_id, first_seen_at, updated_at
  )
  SELECT source_kind, source_message_id, projection_version, included,
         identity_key, contact_id, first_seen_at, CURRENT_TIMESTAMP
  FROM ristak_message_first_seen_meta_source
  WHERE source_message_id = NEW.id;
  UPDATE meta_social_messages
  SET first_seen_projection_version = 1
  WHERE id = NEW.id;
END;

DROP TRIGGER IF EXISTS trg_message_first_seen_meta_update;
CREATE TRIGGER trg_message_first_seen_meta_update
AFTER UPDATE OF id, contact_id, sender_id, platform, meta_social_contact_id,
  direction, message_timestamp, created_at
ON meta_social_messages
BEGIN
  DELETE FROM message_first_seen_ledger
  WHERE source_kind = 'meta' AND source_message_id = OLD.id;
  INSERT INTO message_first_seen_ledger (
    source_kind, source_message_id, projection_version, included,
    identity_key, contact_id, first_seen_at, updated_at
  )
  SELECT source_kind, source_message_id, projection_version, included,
         identity_key, contact_id, first_seen_at, CURRENT_TIMESTAMP
  FROM ristak_message_first_seen_meta_source
  WHERE source_message_id = NEW.id;
  UPDATE meta_social_messages
  SET first_seen_projection_version = 1
  WHERE id = NEW.id;
END;

DROP TRIGGER IF EXISTS trg_message_first_seen_meta_delete;
CREATE TRIGGER trg_message_first_seen_meta_delete
AFTER DELETE ON meta_social_messages
BEGIN
  DELETE FROM message_first_seen_ledger
  WHERE source_kind = 'meta' AND source_message_id = OLD.id;
END;

DROP TRIGGER IF EXISTS trg_message_first_seen_email_insert;
CREATE TRIGGER trg_message_first_seen_email_insert
AFTER INSERT ON email_messages
BEGIN
  INSERT INTO message_first_seen_ledger (
    source_kind, source_message_id, projection_version, included,
    identity_key, contact_id, first_seen_at, updated_at
  )
  SELECT source_kind, source_message_id, projection_version, included,
         identity_key, contact_id, first_seen_at, CURRENT_TIMESTAMP
  FROM ristak_message_first_seen_email_source
  WHERE source_message_id = NEW.id;
  UPDATE email_messages
  SET first_seen_projection_version = 1
  WHERE id = NEW.id;
END;

DROP TRIGGER IF EXISTS trg_message_first_seen_email_update;
CREATE TRIGGER trg_message_first_seen_email_update
AFTER UPDATE OF id, contact_id, from_email, direction, message_timestamp, created_at
ON email_messages
BEGIN
  DELETE FROM message_first_seen_ledger
  WHERE source_kind = 'email' AND source_message_id = OLD.id;
  INSERT INTO message_first_seen_ledger (
    source_kind, source_message_id, projection_version, included,
    identity_key, contact_id, first_seen_at, updated_at
  )
  SELECT source_kind, source_message_id, projection_version, included,
         identity_key, contact_id, first_seen_at, CURRENT_TIMESTAMP
  FROM ristak_message_first_seen_email_source
  WHERE source_message_id = NEW.id;
  UPDATE email_messages
  SET first_seen_projection_version = 1
  WHERE id = NEW.id;
END;

DROP TRIGGER IF EXISTS trg_message_first_seen_email_delete;
CREATE TRIGGER trg_message_first_seen_email_delete
AFTER DELETE ON email_messages
BEGIN
  DELETE FROM message_first_seen_ledger
  WHERE source_kind = 'email' AND source_message_id = OLD.id;
END;
