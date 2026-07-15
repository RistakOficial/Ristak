-- Proyeccion incremental del inbox. Cada mensaje fuente deja una fila, incluso
-- cuando esta excluido o aun no puede resolverse a un contacto. Ese sentinel
-- permite demostrar cobertura completa antes de habilitar el fast path.
CREATE TABLE IF NOT EXISTS chat_message_activity (
  source_kind TEXT NOT NULL CHECK (source_kind IN ('whatsapp', 'meta', 'email')),
  source_message_id TEXT NOT NULL,
  projection_version INTEGER NOT NULL DEFAULT 1,
  included INTEGER NOT NULL DEFAULT 0,
  contact_id TEXT,
  scope_key TEXT,
  direction TEXT,
  message_sort REAL NOT NULL DEFAULT 0,
  created_sort REAL NOT NULL DEFAULT 0,
  message_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (source_kind, source_message_id)
);

CREATE TABLE IF NOT EXISTS chat_contact_activity (
  contact_id TEXT PRIMARY KEY,
  message_count INTEGER NOT NULL DEFAULT 0,
  last_message_sort REAL NOT NULL DEFAULT 0,
  last_created_sort REAL NOT NULL DEFAULT 0,
  last_source_kind TEXT NOT NULL,
  last_source_message_id TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS chat_contact_scope_activity (
  contact_id TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  last_message_sort REAL NOT NULL DEFAULT 0,
  last_created_sort REAL NOT NULL DEFAULT 0,
  last_source_kind TEXT NOT NULL,
  last_source_message_id TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (contact_id, scope_key)
);

CREATE TABLE IF NOT EXISTS chat_activity_projection_state (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  projection_version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'backfilling'
    CHECK (status IN ('backfilling', 'dirty', 'ready', 'failed')),
  whatsapp_cursor TEXT NOT NULL DEFAULT '',
  meta_cursor TEXT NOT NULL DEFAULT '',
  email_cursor TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO chat_activity_projection_state (singleton_id, projection_version, status)
VALUES (1, 1, 'backfilling')
ON CONFLICT(singleton_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS chat_activity_identity_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  identity_kind TEXT NOT NULL,
  identity_value TEXT NOT NULL DEFAULT '',
  generation INTEGER NOT NULL DEFAULT 1,
  cursor_message_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_chat_message_activity_contact_latest
  ON chat_message_activity(contact_id, message_sort DESC, created_sort DESC, source_kind DESC, source_message_id DESC)
  WHERE included = 1;
CREATE INDEX IF NOT EXISTS idx_chat_message_activity_scope_latest
  ON chat_message_activity(scope_key, contact_id, message_sort DESC, created_sort DESC, source_kind DESC, source_message_id DESC)
  WHERE included = 1;
CREATE INDEX IF NOT EXISTS idx_chat_message_activity_inbound_latest
  ON chat_message_activity(contact_id, direction, message_sort DESC, created_sort DESC, source_message_id DESC)
  WHERE included = 1 AND source_kind = 'whatsapp';
CREATE INDEX IF NOT EXISTS idx_whatsapp_api_messages_chat_projection_pending
  ON whatsapp_api_messages(id) WHERE chat_projection_version < 1;
CREATE INDEX IF NOT EXISTS idx_meta_social_messages_chat_projection_pending
  ON meta_social_messages(id) WHERE chat_projection_version < 1;
CREATE INDEX IF NOT EXISTS idx_email_messages_chat_projection_pending
  ON email_messages(id) WHERE chat_projection_version < 1;
CREATE INDEX IF NOT EXISTS idx_whatsapp_api_messages_chat_unresolved_profile
  ON whatsapp_api_messages(whatsapp_api_contact_id, id)
  WHERE NULLIF(TRIM(COALESCE(contact_id, '')), '') IS NULL
    AND whatsapp_api_contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_whatsapp_api_messages_chat_unresolved_phone
  ON whatsapp_api_messages(phone, id)
  WHERE NULLIF(TRIM(COALESCE(contact_id, '')), '') IS NULL
    AND phone IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_whatsapp_api_messages_chat_unresolved_from_phone
  ON whatsapp_api_messages(from_phone, id)
  WHERE NULLIF(TRIM(COALESCE(contact_id, '')), '') IS NULL
    AND from_phone IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_whatsapp_api_messages_chat_unresolved_to_phone
  ON whatsapp_api_messages(to_phone, id)
  WHERE NULLIF(TRIM(COALESCE(contact_id, '')), '') IS NULL
    AND to_phone IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_chat_contact_activity_page
  ON chat_contact_activity(last_message_sort DESC, contact_id DESC);
CREATE INDEX IF NOT EXISTS idx_chat_contact_scope_activity_page
  ON chat_contact_scope_activity(scope_key, last_message_sort DESC, contact_id DESC);
CREATE INDEX IF NOT EXISTS idx_chat_activity_identity_queue_order
  ON chat_activity_identity_queue(id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_activity_identity_queue_key
  ON chat_activity_identity_queue(identity_kind, identity_value);

DROP VIEW IF EXISTS ristak_chat_business_phone_aliases;
CREATE VIEW ristak_chat_business_phone_aliases AS
WITH alias_values AS (
  SELECT id, phone_number AS phone_value FROM whatsapp_api_phone_numbers
  UNION ALL SELECT id, display_phone_number FROM whatsapp_api_phone_numbers
  UNION ALL SELECT id, qr_connected_phone FROM whatsapp_api_phone_numbers
), alias_digits AS (
  SELECT id,
    REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
      TRIM(COALESCE(phone_value, '')), '+', ''), ' ', ''), '-', ''), '(', ''), ')', ''), '.', ''), '/', '') AS raw_digits
  FROM alias_values
), stripped AS (
  SELECT id, CASE WHEN raw_digits LIKE '00%' THEN SUBSTR(raw_digits, 3) ELSE raw_digits END AS digits
  FROM alias_digits
)
SELECT DISTINCT id,
  CASE
    WHEN LENGTH(digits) < 7 THEN ''
    WHEN (digits LIKE '521%' AND LENGTH(digits) >= 13)
      OR (digits LIKE '52%' AND LENGTH(digits) >= 12) THEN '+52' || SUBSTR(digits, -10)
    WHEN LENGTH(digits) = 10 THEN '+52' || digits
    ELSE '+' || digits
  END AS canonical_phone
FROM stripped
WHERE LENGTH(digits) >= 7;

DROP VIEW IF EXISTS ristak_chat_whatsapp_projection_source;
CREATE VIEW ristak_chat_whatsapp_projection_source AS
WITH message_digits AS (
  SELECT id,
    REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
      TRIM(COALESCE(business_phone, '')), '+', ''), ' ', ''), '-', ''), '(', ''), ')', ''), '.', ''), '/', '') AS raw_digits
  FROM whatsapp_api_messages
), message_stripped AS (
  SELECT id, CASE WHEN raw_digits LIKE '00%' THEN SUBSTR(raw_digits, 3) ELSE raw_digits END AS digits
  FROM message_digits
), message_phone AS (
  SELECT id,
    CASE
      WHEN LENGTH(digits) < 7 THEN ''
      WHEN (digits LIKE '521%' AND LENGTH(digits) >= 13)
        OR (digits LIKE '52%' AND LENGTH(digits) >= 12) THEN '+52' || SUBSTR(digits, -10)
      WHEN LENGTH(digits) = 10 THEN '+52' || digits
      ELSE '+' || digits
    END AS canonical_phone
  FROM message_stripped
), resolved AS (
  SELECT
    msg.id AS source_message_id,
    COALESCE(
      NULLIF(TRIM(msg.contact_id), ''),
      NULLIF(TRIM(api_profile.contact_id), ''),
      (
        SELECT MIN(phone_match.contact_id)
        FROM (
          SELECT c.id AS contact_id
          FROM contacts c
          WHERE TRIM(COALESCE(c.phone, '')) != ''
            AND c.phone IN (msg.phone, msg.from_phone, msg.to_phone, api_profile.phone)
          UNION ALL
          SELECT cpn.contact_id
          FROM contact_phone_numbers cpn
          WHERE TRIM(COALESCE(cpn.phone, '')) != ''
            AND cpn.phone IN (msg.phone, msg.from_phone, msg.to_phone, api_profile.phone)
        ) phone_match
      )
    ) AS resolved_contact_id,
    LOWER(COALESCE(msg.message_type, '')) <> 'status' AS is_message,
    CASE
      WHEN TRIM(COALESCE(msg.business_phone_number_id, '')) != ''
        THEN 'id:' || TRIM(msg.business_phone_number_id)
      WHEN message_phone.canonical_phone != '' THEN
        COALESCE(
          (
            SELECT 'id:' || aliases.id
            FROM ristak_chat_business_phone_aliases aliases
            WHERE aliases.canonical_phone = message_phone.canonical_phone
            ORDER BY aliases.id
            LIMIT 1
          ),
          'phone:' || message_phone.canonical_phone
        )
      ELSE NULL
    END AS scope_key,
    msg.direction AS direction,
    COALESCE(julianday(COALESCE(msg.message_timestamp, msg.created_at)), 0) AS message_sort,
    COALESCE(julianday(msg.created_at), 0) AS created_sort,
    COALESCE(msg.message_timestamp, msg.created_at) AS message_at
  FROM whatsapp_api_messages msg
  JOIN message_phone ON message_phone.id = msg.id
  LEFT JOIN whatsapp_api_contacts api_profile
    ON api_profile.id = msg.whatsapp_api_contact_id
)
SELECT
  'whatsapp' AS source_kind,
  source_message_id,
  1 AS projection_version,
  CASE WHEN is_message AND resolved_contact_id IS NOT NULL THEN 1 ELSE 0 END AS included,
  resolved_contact_id AS contact_id,
  scope_key,
  direction,
  message_sort,
  created_sort,
  message_at
FROM resolved;

DROP VIEW IF EXISTS ristak_chat_meta_projection_source;
CREATE VIEW ristak_chat_meta_projection_source AS
SELECT
  'meta' AS source_kind,
  id AS source_message_id,
  1 AS projection_version,
  CASE WHEN NULLIF(TRIM(contact_id), '') IS NOT NULL THEN 1 ELSE 0 END AS included,
  NULLIF(TRIM(contact_id), '') AS contact_id,
  NULL AS scope_key,
  direction,
  COALESCE(julianday(COALESCE(message_timestamp, created_at)), 0) AS message_sort,
  COALESCE(julianday(created_at), 0) AS created_sort,
  COALESCE(message_timestamp, created_at) AS message_at
FROM meta_social_messages;

DROP VIEW IF EXISTS ristak_chat_email_projection_source;
CREATE VIEW ristak_chat_email_projection_source AS
SELECT
  'email' AS source_kind,
  id AS source_message_id,
  1 AS projection_version,
  CASE WHEN NULLIF(TRIM(contact_id), '') IS NOT NULL THEN 1 ELSE 0 END AS included,
  NULLIF(TRIM(contact_id), '') AS contact_id,
  NULL AS scope_key,
  direction,
  COALESCE(julianday(COALESCE(message_timestamp, created_at)), 0) AS message_sort,
  COALESCE(julianday(created_at), 0) AS created_sort,
  COALESCE(message_timestamp, created_at) AS message_at
FROM email_messages;

-- El ledger es el unico escritor de summaries. INSERT suma O(1); DELETE solo
-- busca un reemplazo por indice cuando quita exactamente la tupla mas reciente.
DROP TRIGGER IF EXISTS trg_chat_activity_ledger_insert;
CREATE TRIGGER trg_chat_activity_ledger_insert
AFTER INSERT ON chat_message_activity
WHEN NEW.included = 1 AND NULLIF(NEW.contact_id, '') IS NOT NULL
BEGIN
  INSERT INTO chat_contact_activity (
    contact_id, message_count, last_message_sort, last_created_sort,
    last_source_kind, last_source_message_id, updated_at
  ) VALUES (
    NEW.contact_id, 1, NEW.message_sort, NEW.created_sort,
    NEW.source_kind, NEW.source_message_id, CURRENT_TIMESTAMP
  )
  ON CONFLICT(contact_id) DO UPDATE SET
    message_count = chat_contact_activity.message_count + 1,
    last_message_sort = CASE
      WHEN (excluded.last_message_sort, excluded.last_created_sort, excluded.last_source_kind, excluded.last_source_message_id) >
           (chat_contact_activity.last_message_sort, chat_contact_activity.last_created_sort, chat_contact_activity.last_source_kind, chat_contact_activity.last_source_message_id)
        THEN excluded.last_message_sort ELSE chat_contact_activity.last_message_sort END,
    last_created_sort = CASE
      WHEN (excluded.last_message_sort, excluded.last_created_sort, excluded.last_source_kind, excluded.last_source_message_id) >
           (chat_contact_activity.last_message_sort, chat_contact_activity.last_created_sort, chat_contact_activity.last_source_kind, chat_contact_activity.last_source_message_id)
        THEN excluded.last_created_sort ELSE chat_contact_activity.last_created_sort END,
    last_source_kind = CASE
      WHEN (excluded.last_message_sort, excluded.last_created_sort, excluded.last_source_kind, excluded.last_source_message_id) >
           (chat_contact_activity.last_message_sort, chat_contact_activity.last_created_sort, chat_contact_activity.last_source_kind, chat_contact_activity.last_source_message_id)
        THEN excluded.last_source_kind ELSE chat_contact_activity.last_source_kind END,
    last_source_message_id = CASE
      WHEN (excluded.last_message_sort, excluded.last_created_sort, excluded.last_source_kind, excluded.last_source_message_id) >
           (chat_contact_activity.last_message_sort, chat_contact_activity.last_created_sort, chat_contact_activity.last_source_kind, chat_contact_activity.last_source_message_id)
        THEN excluded.last_source_message_id ELSE chat_contact_activity.last_source_message_id END,
    updated_at = CURRENT_TIMESTAMP;

  INSERT INTO chat_contact_scope_activity (
    contact_id, scope_key, message_count, last_message_sort, last_created_sort,
    last_source_kind, last_source_message_id, updated_at
  )
  SELECT
    NEW.contact_id, NEW.scope_key, 1, NEW.message_sort, NEW.created_sort,
    NEW.source_kind, NEW.source_message_id, CURRENT_TIMESTAMP
  WHERE NEW.scope_key IS NOT NULL AND NEW.scope_key != ''
  ON CONFLICT(contact_id, scope_key) DO UPDATE SET
    message_count = chat_contact_scope_activity.message_count + 1,
    last_message_sort = CASE
      WHEN (excluded.last_message_sort, excluded.last_created_sort, excluded.last_source_kind, excluded.last_source_message_id) >
           (chat_contact_scope_activity.last_message_sort, chat_contact_scope_activity.last_created_sort, chat_contact_scope_activity.last_source_kind, chat_contact_scope_activity.last_source_message_id)
        THEN excluded.last_message_sort ELSE chat_contact_scope_activity.last_message_sort END,
    last_created_sort = CASE
      WHEN (excluded.last_message_sort, excluded.last_created_sort, excluded.last_source_kind, excluded.last_source_message_id) >
           (chat_contact_scope_activity.last_message_sort, chat_contact_scope_activity.last_created_sort, chat_contact_scope_activity.last_source_kind, chat_contact_scope_activity.last_source_message_id)
        THEN excluded.last_created_sort ELSE chat_contact_scope_activity.last_created_sort END,
    last_source_kind = CASE
      WHEN (excluded.last_message_sort, excluded.last_created_sort, excluded.last_source_kind, excluded.last_source_message_id) >
           (chat_contact_scope_activity.last_message_sort, chat_contact_scope_activity.last_created_sort, chat_contact_scope_activity.last_source_kind, chat_contact_scope_activity.last_source_message_id)
        THEN excluded.last_source_kind ELSE chat_contact_scope_activity.last_source_kind END,
    last_source_message_id = CASE
      WHEN (excluded.last_message_sort, excluded.last_created_sort, excluded.last_source_kind, excluded.last_source_message_id) >
           (chat_contact_scope_activity.last_message_sort, chat_contact_scope_activity.last_created_sort, chat_contact_scope_activity.last_source_kind, chat_contact_scope_activity.last_source_message_id)
        THEN excluded.last_source_message_id ELSE chat_contact_scope_activity.last_source_message_id END,
    updated_at = CURRENT_TIMESTAMP;
END;

DROP TRIGGER IF EXISTS trg_chat_activity_ledger_delete;
CREATE TRIGGER trg_chat_activity_ledger_delete
AFTER DELETE ON chat_message_activity
WHEN OLD.included = 1 AND NULLIF(OLD.contact_id, '') IS NOT NULL
BEGIN
  UPDATE chat_contact_activity
  SET message_count = message_count - 1,
      updated_at = CURRENT_TIMESTAMP
  WHERE contact_id = OLD.contact_id;

  DELETE FROM chat_contact_activity
  WHERE contact_id = OLD.contact_id AND message_count <= 0;

  UPDATE chat_contact_activity
  SET last_message_sort = COALESCE((
        SELECT next_row.message_sort
        FROM chat_message_activity next_row
        WHERE next_row.included = 1 AND next_row.contact_id = OLD.contact_id
        ORDER BY next_row.message_sort DESC, next_row.created_sort DESC, next_row.source_kind DESC, next_row.source_message_id DESC
        LIMIT 1
      ), 0),
      last_created_sort = COALESCE((
        SELECT next_row.created_sort
        FROM chat_message_activity next_row
        WHERE next_row.included = 1 AND next_row.contact_id = OLD.contact_id
        ORDER BY next_row.message_sort DESC, next_row.created_sort DESC, next_row.source_kind DESC, next_row.source_message_id DESC
        LIMIT 1
      ), 0),
      last_source_kind = COALESCE((
        SELECT next_row.source_kind
        FROM chat_message_activity next_row
        WHERE next_row.included = 1 AND next_row.contact_id = OLD.contact_id
        ORDER BY next_row.message_sort DESC, next_row.created_sort DESC, next_row.source_kind DESC, next_row.source_message_id DESC
        LIMIT 1
      ), ''),
      last_source_message_id = COALESCE((
        SELECT next_row.source_message_id
        FROM chat_message_activity next_row
        WHERE next_row.included = 1 AND next_row.contact_id = OLD.contact_id
        ORDER BY next_row.message_sort DESC, next_row.created_sort DESC, next_row.source_kind DESC, next_row.source_message_id DESC
        LIMIT 1
      ), ''),
      updated_at = CURRENT_TIMESTAMP
  WHERE contact_id = OLD.contact_id
    AND (last_message_sort, last_created_sort, last_source_kind, last_source_message_id) =
        (OLD.message_sort, OLD.created_sort, OLD.source_kind, OLD.source_message_id);

  UPDATE chat_contact_scope_activity
  SET message_count = message_count - 1,
      updated_at = CURRENT_TIMESTAMP
  WHERE contact_id = OLD.contact_id AND scope_key = OLD.scope_key;

  DELETE FROM chat_contact_scope_activity
  WHERE contact_id = OLD.contact_id AND scope_key = OLD.scope_key AND message_count <= 0;

  UPDATE chat_contact_scope_activity
  SET last_message_sort = COALESCE((
        SELECT next_row.message_sort
        FROM chat_message_activity next_row
        WHERE next_row.included = 1
          AND next_row.contact_id = OLD.contact_id
          AND next_row.scope_key = OLD.scope_key
        ORDER BY next_row.message_sort DESC, next_row.created_sort DESC, next_row.source_kind DESC, next_row.source_message_id DESC
        LIMIT 1
      ), 0),
      last_created_sort = COALESCE((
        SELECT next_row.created_sort
        FROM chat_message_activity next_row
        WHERE next_row.included = 1
          AND next_row.contact_id = OLD.contact_id
          AND next_row.scope_key = OLD.scope_key
        ORDER BY next_row.message_sort DESC, next_row.created_sort DESC, next_row.source_kind DESC, next_row.source_message_id DESC
        LIMIT 1
      ), 0),
      last_source_kind = COALESCE((
        SELECT next_row.source_kind
        FROM chat_message_activity next_row
        WHERE next_row.included = 1
          AND next_row.contact_id = OLD.contact_id
          AND next_row.scope_key = OLD.scope_key
        ORDER BY next_row.message_sort DESC, next_row.created_sort DESC, next_row.source_kind DESC, next_row.source_message_id DESC
        LIMIT 1
      ), ''),
      last_source_message_id = COALESCE((
        SELECT next_row.source_message_id
        FROM chat_message_activity next_row
        WHERE next_row.included = 1
          AND next_row.contact_id = OLD.contact_id
          AND next_row.scope_key = OLD.scope_key
        ORDER BY next_row.message_sort DESC, next_row.created_sort DESC, next_row.source_kind DESC, next_row.source_message_id DESC
        LIMIT 1
      ), ''),
      updated_at = CURRENT_TIMESTAMP
  WHERE contact_id = OLD.contact_id AND scope_key = OLD.scope_key
    AND (last_message_sort, last_created_sort, last_source_kind, last_source_message_id) =
        (OLD.message_sort, OLD.created_sort, OLD.source_kind, OLD.source_message_id);
END;

-- Source triggers: borrar+insertar transforma cualquier UPDATE en movimiento
-- atomico old→new y conserva summaries correctos para cambio/borrado.
DROP TRIGGER IF EXISTS trg_chat_activity_whatsapp_insert;
CREATE TRIGGER trg_chat_activity_whatsapp_insert
AFTER INSERT ON whatsapp_api_messages
BEGIN
  INSERT INTO chat_message_activity (
    source_kind, source_message_id, projection_version, included,
    contact_id, scope_key, direction, message_sort, created_sort, message_at, updated_at
  )
  SELECT source_kind, source_message_id, projection_version, included,
         contact_id, scope_key, direction, message_sort, created_sort, message_at, CURRENT_TIMESTAMP
  FROM ristak_chat_whatsapp_projection_source
  WHERE source_message_id = NEW.id;
  UPDATE whatsapp_api_messages SET chat_projection_version = 1 WHERE id = NEW.id;
END;

DROP TRIGGER IF EXISTS trg_chat_activity_whatsapp_update;
CREATE TRIGGER trg_chat_activity_whatsapp_update
AFTER UPDATE OF contact_id, whatsapp_api_contact_id, phone, from_phone, to_phone,
  business_phone_number_id, business_phone, direction, message_type, message_timestamp, created_at
ON whatsapp_api_messages
BEGIN
  DELETE FROM chat_message_activity
  WHERE source_kind = 'whatsapp' AND source_message_id = OLD.id;
  INSERT INTO chat_message_activity (
    source_kind, source_message_id, projection_version, included,
    contact_id, scope_key, direction, message_sort, created_sort, message_at, updated_at
  )
  SELECT source_kind, source_message_id, projection_version, included,
         contact_id, scope_key, direction, message_sort, created_sort, message_at, CURRENT_TIMESTAMP
  FROM ristak_chat_whatsapp_projection_source
  WHERE source_message_id = NEW.id;
  UPDATE whatsapp_api_messages SET chat_projection_version = 1 WHERE id = NEW.id;
END;

DROP TRIGGER IF EXISTS trg_chat_activity_whatsapp_delete;
CREATE TRIGGER trg_chat_activity_whatsapp_delete
AFTER DELETE ON whatsapp_api_messages
BEGIN
  DELETE FROM chat_message_activity
  WHERE source_kind = 'whatsapp' AND source_message_id = OLD.id;
END;

DROP TRIGGER IF EXISTS trg_chat_activity_meta_insert;
CREATE TRIGGER trg_chat_activity_meta_insert
AFTER INSERT ON meta_social_messages
BEGIN
  INSERT INTO chat_message_activity (
    source_kind, source_message_id, projection_version, included,
    contact_id, scope_key, direction, message_sort, created_sort, message_at, updated_at
  )
  SELECT source_kind, source_message_id, projection_version, included,
         contact_id, scope_key, direction, message_sort, created_sort, message_at, CURRENT_TIMESTAMP
  FROM ristak_chat_meta_projection_source WHERE source_message_id = NEW.id;
  UPDATE meta_social_messages SET chat_projection_version = 1 WHERE id = NEW.id;
END;

DROP TRIGGER IF EXISTS trg_chat_activity_meta_update;
CREATE TRIGGER trg_chat_activity_meta_update
AFTER UPDATE OF contact_id, message_timestamp, created_at ON meta_social_messages
BEGIN
  DELETE FROM chat_message_activity WHERE source_kind = 'meta' AND source_message_id = OLD.id;
  INSERT INTO chat_message_activity (
    source_kind, source_message_id, projection_version, included,
    contact_id, scope_key, direction, message_sort, created_sort, message_at, updated_at
  )
  SELECT source_kind, source_message_id, projection_version, included,
         contact_id, scope_key, direction, message_sort, created_sort, message_at, CURRENT_TIMESTAMP
  FROM ristak_chat_meta_projection_source WHERE source_message_id = NEW.id;
  UPDATE meta_social_messages SET chat_projection_version = 1 WHERE id = NEW.id;
END;

DROP TRIGGER IF EXISTS trg_chat_activity_meta_delete;
CREATE TRIGGER trg_chat_activity_meta_delete
AFTER DELETE ON meta_social_messages
BEGIN
  DELETE FROM chat_message_activity WHERE source_kind = 'meta' AND source_message_id = OLD.id;
END;

DROP TRIGGER IF EXISTS trg_chat_activity_email_insert;
CREATE TRIGGER trg_chat_activity_email_insert
AFTER INSERT ON email_messages
BEGIN
  INSERT INTO chat_message_activity (
    source_kind, source_message_id, projection_version, included,
    contact_id, scope_key, direction, message_sort, created_sort, message_at, updated_at
  )
  SELECT source_kind, source_message_id, projection_version, included,
         contact_id, scope_key, direction, message_sort, created_sort, message_at, CURRENT_TIMESTAMP
  FROM ristak_chat_email_projection_source WHERE source_message_id = NEW.id;
  UPDATE email_messages SET chat_projection_version = 1 WHERE id = NEW.id;
END;

DROP TRIGGER IF EXISTS trg_chat_activity_email_update;
CREATE TRIGGER trg_chat_activity_email_update
AFTER UPDATE OF contact_id, message_timestamp, created_at ON email_messages
BEGIN
  DELETE FROM chat_message_activity WHERE source_kind = 'email' AND source_message_id = OLD.id;
  INSERT INTO chat_message_activity (
    source_kind, source_message_id, projection_version, included,
    contact_id, scope_key, direction, message_sort, created_sort, message_at, updated_at
  )
  SELECT source_kind, source_message_id, projection_version, included,
         contact_id, scope_key, direction, message_sort, created_sort, message_at, CURRENT_TIMESTAMP
  FROM ristak_chat_email_projection_source WHERE source_message_id = NEW.id;
  UPDATE email_messages SET chat_projection_version = 1 WHERE id = NEW.id;
END;

DROP TRIGGER IF EXISTS trg_chat_activity_email_delete;
CREATE TRIGGER trg_chat_activity_email_delete
AFTER DELETE ON email_messages
BEGIN
  DELETE FROM chat_message_activity WHERE source_kind = 'email' AND source_message_id = OLD.id;
END;

-- Cambiar identidades o aliases puede mover mensajes historicos. No se hace
-- trabajo masivo dentro del write: se marca dirty y el worker reproyecta por lotes;
-- mientras tanto el controlador usa el contrato legacy exacto.
DROP TRIGGER IF EXISTS trg_chat_activity_contacts_identity_insert;
CREATE TRIGGER trg_chat_activity_contacts_identity_insert
AFTER INSERT ON contacts WHEN TRIM(COALESCE(NEW.phone, '')) != '' AND (
  EXISTS (
    SELECT 1 FROM whatsapp_api_messages msg
    WHERE NULLIF(TRIM(COALESCE(msg.contact_id, '')), '') IS NULL
      AND msg.phone = NEW.phone LIMIT 1
  ) OR EXISTS (
    SELECT 1 FROM whatsapp_api_messages msg
    WHERE NULLIF(TRIM(COALESCE(msg.contact_id, '')), '') IS NULL
      AND msg.from_phone = NEW.phone LIMIT 1
  ) OR EXISTS (
    SELECT 1 FROM whatsapp_api_messages msg
    WHERE NULLIF(TRIM(COALESCE(msg.contact_id, '')), '') IS NULL
      AND msg.to_phone = NEW.phone LIMIT 1
  ) OR EXISTS (
    SELECT 1
    FROM whatsapp_api_contacts profile
    JOIN whatsapp_api_messages msg ON msg.whatsapp_api_contact_id = profile.id
    WHERE NULLIF(TRIM(COALESCE(msg.contact_id, '')), '') IS NULL
      AND NULLIF(TRIM(COALESCE(profile.contact_id, '')), '') IS NULL
      AND profile.phone = NEW.phone
    LIMIT 1
  )
)
BEGIN
  INSERT INTO chat_activity_identity_queue(identity_kind, identity_value) VALUES ('phone', NEW.phone)
  ON CONFLICT(identity_kind, identity_value) DO UPDATE SET
    generation = chat_activity_identity_queue.generation + 1, cursor_message_id = '', created_at = CURRENT_TIMESTAMP;
  UPDATE chat_activity_projection_state SET status = 'dirty', revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE singleton_id = 1;
END;
DROP TRIGGER IF EXISTS trg_chat_activity_contacts_identity_update;
CREATE TRIGGER trg_chat_activity_contacts_identity_update
AFTER UPDATE OF phone ON contacts WHEN COALESCE(OLD.phone, '') <> COALESCE(NEW.phone, '')
BEGIN
  INSERT INTO chat_activity_identity_queue(identity_kind, identity_value)
    SELECT 'phone', OLD.phone WHERE TRIM(COALESCE(OLD.phone, '')) != ''
    ON CONFLICT(identity_kind, identity_value) DO UPDATE SET
      generation = chat_activity_identity_queue.generation + 1, cursor_message_id = '', created_at = CURRENT_TIMESTAMP;
  INSERT INTO chat_activity_identity_queue(identity_kind, identity_value)
    SELECT 'phone', NEW.phone WHERE TRIM(COALESCE(NEW.phone, '')) != ''
    ON CONFLICT(identity_kind, identity_value) DO UPDATE SET
      generation = chat_activity_identity_queue.generation + 1, cursor_message_id = '', created_at = CURRENT_TIMESTAMP;
  UPDATE chat_activity_projection_state SET status = 'dirty', revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE singleton_id = 1;
END;
DROP TRIGGER IF EXISTS trg_chat_activity_contacts_identity_delete;
CREATE TRIGGER trg_chat_activity_contacts_identity_delete
AFTER DELETE ON contacts WHEN TRIM(COALESCE(OLD.phone, '')) != ''
BEGIN
  INSERT INTO chat_activity_identity_queue(identity_kind, identity_value) VALUES ('phone', OLD.phone)
  ON CONFLICT(identity_kind, identity_value) DO UPDATE SET
    generation = chat_activity_identity_queue.generation + 1, cursor_message_id = '', created_at = CURRENT_TIMESTAMP;
  UPDATE chat_activity_projection_state SET status = 'dirty', revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE singleton_id = 1;
END;

DROP TRIGGER IF EXISTS trg_chat_activity_extra_phone_insert;
CREATE TRIGGER trg_chat_activity_extra_phone_insert AFTER INSERT ON contact_phone_numbers
WHEN EXISTS (
  SELECT 1 FROM whatsapp_api_messages msg
  WHERE NULLIF(TRIM(COALESCE(msg.contact_id, '')), '') IS NULL
    AND msg.phone = NEW.phone LIMIT 1
) OR EXISTS (
  SELECT 1 FROM whatsapp_api_messages msg
  WHERE NULLIF(TRIM(COALESCE(msg.contact_id, '')), '') IS NULL
    AND msg.from_phone = NEW.phone LIMIT 1
) OR EXISTS (
  SELECT 1 FROM whatsapp_api_messages msg
  WHERE NULLIF(TRIM(COALESCE(msg.contact_id, '')), '') IS NULL
    AND msg.to_phone = NEW.phone LIMIT 1
) OR EXISTS (
  SELECT 1
  FROM whatsapp_api_contacts profile
  JOIN whatsapp_api_messages msg ON msg.whatsapp_api_contact_id = profile.id
  WHERE NULLIF(TRIM(COALESCE(msg.contact_id, '')), '') IS NULL
    AND NULLIF(TRIM(COALESCE(profile.contact_id, '')), '') IS NULL
    AND profile.phone = NEW.phone
  LIMIT 1
)
BEGIN
  INSERT INTO chat_activity_identity_queue(identity_kind, identity_value) VALUES ('phone', NEW.phone)
  ON CONFLICT(identity_kind, identity_value) DO UPDATE SET
    generation = chat_activity_identity_queue.generation + 1, cursor_message_id = '', created_at = CURRENT_TIMESTAMP;
  UPDATE chat_activity_projection_state SET status = 'dirty', revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE singleton_id = 1;
END;
DROP TRIGGER IF EXISTS trg_chat_activity_extra_phone_update;
CREATE TRIGGER trg_chat_activity_extra_phone_update AFTER UPDATE OF contact_id, phone ON contact_phone_numbers
WHEN COALESCE(OLD.contact_id, '') <> COALESCE(NEW.contact_id, '')
  OR COALESCE(OLD.phone, '') <> COALESCE(NEW.phone, '')
BEGIN
  INSERT INTO chat_activity_identity_queue(identity_kind, identity_value) VALUES ('phone', OLD.phone)
  ON CONFLICT(identity_kind, identity_value) DO UPDATE SET
    generation = chat_activity_identity_queue.generation + 1, cursor_message_id = '', created_at = CURRENT_TIMESTAMP;
  INSERT INTO chat_activity_identity_queue(identity_kind, identity_value) VALUES ('phone', NEW.phone)
  ON CONFLICT(identity_kind, identity_value) DO UPDATE SET
    generation = chat_activity_identity_queue.generation + 1, cursor_message_id = '', created_at = CURRENT_TIMESTAMP;
  UPDATE chat_activity_projection_state SET status = 'dirty', revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE singleton_id = 1;
END;
DROP TRIGGER IF EXISTS trg_chat_activity_extra_phone_delete;
CREATE TRIGGER trg_chat_activity_extra_phone_delete AFTER DELETE ON contact_phone_numbers
BEGIN
  INSERT INTO chat_activity_identity_queue(identity_kind, identity_value) VALUES ('phone', OLD.phone)
  ON CONFLICT(identity_kind, identity_value) DO UPDATE SET
    generation = chat_activity_identity_queue.generation + 1, cursor_message_id = '', created_at = CURRENT_TIMESTAMP;
  UPDATE chat_activity_projection_state SET status = 'dirty', revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE singleton_id = 1;
END;

DROP TRIGGER IF EXISTS trg_chat_activity_api_profile_insert;
CREATE TRIGGER trg_chat_activity_api_profile_insert AFTER INSERT ON whatsapp_api_contacts
BEGIN
  INSERT INTO chat_activity_identity_queue(identity_kind, identity_value) VALUES ('profile', NEW.id)
  ON CONFLICT(identity_kind, identity_value) DO UPDATE SET
    generation = chat_activity_identity_queue.generation + 1, cursor_message_id = '', created_at = CURRENT_TIMESTAMP;
  UPDATE chat_activity_projection_state SET status = 'dirty', revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE singleton_id = 1;
END;
DROP TRIGGER IF EXISTS trg_chat_activity_api_profile_update;
CREATE TRIGGER trg_chat_activity_api_profile_update AFTER UPDATE OF contact_id, phone ON whatsapp_api_contacts
WHEN COALESCE(OLD.contact_id, '') <> COALESCE(NEW.contact_id, '')
  OR COALESCE(OLD.phone, '') <> COALESCE(NEW.phone, '')
BEGIN
  INSERT INTO chat_activity_identity_queue(identity_kind, identity_value) VALUES ('profile', NEW.id)
  ON CONFLICT(identity_kind, identity_value) DO UPDATE SET
    generation = chat_activity_identity_queue.generation + 1, cursor_message_id = '', created_at = CURRENT_TIMESTAMP;
  UPDATE chat_activity_projection_state SET status = 'dirty', revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE singleton_id = 1;
END;
DROP TRIGGER IF EXISTS trg_chat_activity_api_profile_delete;
CREATE TRIGGER trg_chat_activity_api_profile_delete AFTER DELETE ON whatsapp_api_contacts
BEGIN
  INSERT INTO chat_activity_identity_queue(identity_kind, identity_value) VALUES ('profile', OLD.id)
  ON CONFLICT(identity_kind, identity_value) DO UPDATE SET
    generation = chat_activity_identity_queue.generation + 1, cursor_message_id = '', created_at = CURRENT_TIMESTAMP;
  UPDATE chat_activity_projection_state SET status = 'dirty', revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE singleton_id = 1;
END;

DROP TRIGGER IF EXISTS trg_chat_activity_business_alias_insert;
CREATE TRIGGER trg_chat_activity_business_alias_insert AFTER INSERT ON whatsapp_api_phone_numbers
BEGIN
  INSERT INTO chat_activity_identity_queue(identity_kind, identity_value) VALUES ('business_alias', NEW.id)
  ON CONFLICT(identity_kind, identity_value) DO UPDATE SET
    generation = chat_activity_identity_queue.generation + 1, cursor_message_id = '', created_at = CURRENT_TIMESTAMP;
  INSERT INTO chat_activity_identity_queue(identity_kind, identity_value)
    SELECT 'business_alias_phone', NEW.phone_number WHERE TRIM(COALESCE(NEW.phone_number, '')) != ''
    UNION SELECT 'business_alias_phone', NEW.display_phone_number WHERE TRIM(COALESCE(NEW.display_phone_number, '')) != ''
    UNION SELECT 'business_alias_phone', NEW.qr_connected_phone WHERE TRIM(COALESCE(NEW.qr_connected_phone, '')) != ''
    ON CONFLICT(identity_kind, identity_value) DO UPDATE SET
      generation = chat_activity_identity_queue.generation + 1, cursor_message_id = '', created_at = CURRENT_TIMESTAMP;
  UPDATE chat_activity_projection_state SET status = 'dirty', revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE singleton_id = 1;
END;
DROP TRIGGER IF EXISTS trg_chat_activity_business_alias_update;
CREATE TRIGGER trg_chat_activity_business_alias_update
AFTER UPDATE OF id, phone_number, display_phone_number, qr_connected_phone ON whatsapp_api_phone_numbers
WHEN COALESCE(OLD.id, '') <> COALESCE(NEW.id, '')
  OR COALESCE(OLD.phone_number, '') <> COALESCE(NEW.phone_number, '')
  OR COALESCE(OLD.display_phone_number, '') <> COALESCE(NEW.display_phone_number, '')
  OR COALESCE(OLD.qr_connected_phone, '') <> COALESCE(NEW.qr_connected_phone, '')
BEGIN
  INSERT INTO chat_activity_identity_queue(identity_kind, identity_value) VALUES ('business_alias', OLD.id)
  ON CONFLICT(identity_kind, identity_value) DO UPDATE SET
    generation = chat_activity_identity_queue.generation + 1, cursor_message_id = '', created_at = CURRENT_TIMESTAMP;
  INSERT INTO chat_activity_identity_queue(identity_kind, identity_value) VALUES ('business_alias', NEW.id)
  ON CONFLICT(identity_kind, identity_value) DO UPDATE SET
    generation = chat_activity_identity_queue.generation + 1, cursor_message_id = '', created_at = CURRENT_TIMESTAMP;
  INSERT INTO chat_activity_identity_queue(identity_kind, identity_value)
    SELECT 'business_alias_phone', OLD.phone_number WHERE TRIM(COALESCE(OLD.phone_number, '')) != ''
    UNION SELECT 'business_alias_phone', OLD.display_phone_number WHERE TRIM(COALESCE(OLD.display_phone_number, '')) != ''
    UNION SELECT 'business_alias_phone', OLD.qr_connected_phone WHERE TRIM(COALESCE(OLD.qr_connected_phone, '')) != ''
    UNION SELECT 'business_alias_phone', NEW.phone_number WHERE TRIM(COALESCE(NEW.phone_number, '')) != ''
    UNION SELECT 'business_alias_phone', NEW.display_phone_number WHERE TRIM(COALESCE(NEW.display_phone_number, '')) != ''
    UNION SELECT 'business_alias_phone', NEW.qr_connected_phone WHERE TRIM(COALESCE(NEW.qr_connected_phone, '')) != ''
    ON CONFLICT(identity_kind, identity_value) DO UPDATE SET
      generation = chat_activity_identity_queue.generation + 1, cursor_message_id = '', created_at = CURRENT_TIMESTAMP;
  UPDATE chat_activity_projection_state SET status = 'dirty', revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE singleton_id = 1;
END;
DROP TRIGGER IF EXISTS trg_chat_activity_business_alias_delete;
CREATE TRIGGER trg_chat_activity_business_alias_delete AFTER DELETE ON whatsapp_api_phone_numbers
BEGIN
  INSERT INTO chat_activity_identity_queue(identity_kind, identity_value) VALUES ('business_alias', OLD.id)
  ON CONFLICT(identity_kind, identity_value) DO UPDATE SET
    generation = chat_activity_identity_queue.generation + 1, cursor_message_id = '', created_at = CURRENT_TIMESTAMP;
  INSERT INTO chat_activity_identity_queue(identity_kind, identity_value)
    SELECT 'business_alias_phone', OLD.phone_number WHERE TRIM(COALESCE(OLD.phone_number, '')) != ''
    UNION SELECT 'business_alias_phone', OLD.display_phone_number WHERE TRIM(COALESCE(OLD.display_phone_number, '')) != ''
    UNION SELECT 'business_alias_phone', OLD.qr_connected_phone WHERE TRIM(COALESCE(OLD.qr_connected_phone, '')) != ''
    ON CONFLICT(identity_kind, identity_value) DO UPDATE SET
      generation = chat_activity_identity_queue.generation + 1, cursor_message_id = '', created_at = CURRENT_TIMESTAMP;
  UPDATE chat_activity_projection_state SET status = 'dirty', revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE singleton_id = 1;
END;
