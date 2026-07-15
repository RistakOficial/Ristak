ALTER TABLE whatsapp_api_messages
  ADD COLUMN IF NOT EXISTS chat_projection_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE meta_social_messages
  ADD COLUMN IF NOT EXISTS chat_projection_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE email_messages
  ADD COLUMN IF NOT EXISTS chat_projection_version INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS chat_message_activity (
  source_kind TEXT NOT NULL CHECK (source_kind IN ('whatsapp', 'meta', 'email')),
  source_message_id TEXT NOT NULL,
  projection_version INTEGER NOT NULL DEFAULT 1,
  included INTEGER NOT NULL DEFAULT 0,
  contact_id TEXT,
  scope_key TEXT,
  direction TEXT,
  message_sort NUMERIC NOT NULL DEFAULT 0,
  created_sort NUMERIC NOT NULL DEFAULT 0,
  message_at TEXT,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (source_kind, source_message_id)
);

CREATE TABLE IF NOT EXISTS chat_contact_activity (
  contact_id TEXT PRIMARY KEY,
  message_count BIGINT NOT NULL DEFAULT 0,
  last_message_sort NUMERIC NOT NULL DEFAULT 0,
  last_created_sort NUMERIC NOT NULL DEFAULT 0,
  last_source_kind TEXT NOT NULL,
  last_source_message_id TEXT NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS chat_contact_scope_activity (
  contact_id TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  message_count BIGINT NOT NULL DEFAULT 0,
  last_message_sort NUMERIC NOT NULL DEFAULT 0,
  last_created_sort NUMERIC NOT NULL DEFAULT 0,
  last_source_kind TEXT NOT NULL,
  last_source_message_id TEXT NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
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
  revision BIGINT NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO chat_activity_projection_state (singleton_id, projection_version, status)
VALUES (1, 1, 'backfilling')
ON CONFLICT (singleton_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS chat_activity_identity_queue (
  id BIGSERIAL PRIMARY KEY,
  identity_kind TEXT NOT NULL,
  identity_value TEXT NOT NULL DEFAULT '',
  generation BIGINT NOT NULL DEFAULT 1,
  cursor_message_id TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (identity_kind, identity_value)
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
CREATE INDEX IF NOT EXISTS idx_chat_contact_activity_page
  ON chat_contact_activity(last_message_sort DESC, contact_id DESC)
  INCLUDE (message_count, last_created_sort, last_source_kind, last_source_message_id);
CREATE INDEX IF NOT EXISTS idx_chat_contact_scope_activity_page
  ON chat_contact_scope_activity(scope_key, last_message_sort DESC, contact_id DESC)
  INCLUDE (message_count, last_created_sort, last_source_kind, last_source_message_id);
CREATE INDEX IF NOT EXISTS idx_chat_activity_identity_queue_order
  ON chat_activity_identity_queue(id);

-- Canonicaliza los formatos comunes con la misma regla de almacenamiento del
-- CRM: E.164, Mexico sin el 1 historico de WhatsApp y +52 para 10 digitos.
CREATE OR REPLACE FUNCTION ristak_chat_normalize_phone(value TEXT)
RETURNS TEXT AS $$
DECLARE
  digits TEXT := regexp_replace(COALESCE(value, ''), '[^0-9]', '', 'g');
BEGIN
  IF digits LIKE '00%' THEN digits := substring(digits FROM 3); END IF;
  IF length(digits) < 7 THEN RETURN ''; END IF;
  IF (digits LIKE '521%' AND length(digits) >= 13)
     OR (digits LIKE '52%' AND length(digits) >= 12) THEN
    RETURN '+52' || right(digits, 10);
  END IF;
  IF length(digits) = 10 THEN RETURN '+52' || digits; END IF;
  RETURN '+' || digits;
END;
$$ LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE;

CREATE OR REPLACE VIEW ristak_chat_business_phone_aliases AS
SELECT DISTINCT
  phone_config.id,
  ristak_chat_normalize_phone(alias.phone_value) AS canonical_phone
FROM whatsapp_api_phone_numbers phone_config
CROSS JOIN LATERAL (
  VALUES (phone_config.phone_number),
         (phone_config.display_phone_number),
         (phone_config.qr_connected_phone)
) alias(phone_value)
WHERE ristak_chat_normalize_phone(alias.phone_value) != '';

CREATE OR REPLACE VIEW ristak_chat_whatsapp_projection_source AS
WITH resolved AS (
  SELECT
    msg.id AS source_message_id,
    COALESCE(
      NULLIF(BTRIM(msg.contact_id), ''),
      NULLIF(BTRIM(api_profile.contact_id), ''),
      (
        SELECT MIN(phone_match.contact_id)
        FROM (
          SELECT c.id AS contact_id
          FROM contacts c
          WHERE BTRIM(COALESCE(c.phone, '')) != ''
            AND c.phone IN (msg.phone, msg.from_phone, msg.to_phone, api_profile.phone)
          UNION ALL
          SELECT cpn.contact_id
          FROM contact_phone_numbers cpn
          WHERE BTRIM(COALESCE(cpn.phone, '')) != ''
            AND cpn.phone IN (msg.phone, msg.from_phone, msg.to_phone, api_profile.phone)
        ) phone_match
      )
    ) AS resolved_contact_id,
    LOWER(COALESCE(msg.message_type, '')) <> 'status' AS is_message,
    CASE
      WHEN BTRIM(COALESCE(msg.business_phone_number_id, '')) != ''
        THEN 'id:' || BTRIM(msg.business_phone_number_id)
      WHEN ristak_chat_normalize_phone(msg.business_phone) != '' THEN
        COALESCE(
          (
            SELECT 'id:' || aliases.id
            FROM ristak_chat_business_phone_aliases aliases
            WHERE aliases.canonical_phone = ristak_chat_normalize_phone(msg.business_phone)
            ORDER BY aliases.id
            LIMIT 1
          ),
          'phone:' || ristak_chat_normalize_phone(msg.business_phone)
        )
      ELSE NULL
    END AS scope_key,
    msg.direction AS direction,
    COALESCE(EXTRACT(EPOCH FROM NULLIF(COALESCE(msg.message_timestamp, msg.created_at)::text, '')::timestamptz), 0) AS message_sort,
    COALESCE(EXTRACT(EPOCH FROM NULLIF(msg.created_at::text, '')::timestamptz), 0) AS created_sort,
    COALESCE(msg.message_timestamp, msg.created_at)::text AS message_at
  FROM whatsapp_api_messages msg
  LEFT JOIN whatsapp_api_contacts api_profile
    ON api_profile.id = msg.whatsapp_api_contact_id
)
SELECT
  'whatsapp'::text AS source_kind,
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

CREATE OR REPLACE VIEW ristak_chat_meta_projection_source AS
SELECT
  'meta'::text AS source_kind,
  id AS source_message_id,
  1 AS projection_version,
  CASE WHEN NULLIF(BTRIM(contact_id), '') IS NOT NULL THEN 1 ELSE 0 END AS included,
  NULLIF(BTRIM(contact_id), '') AS contact_id,
  NULL::text AS scope_key,
  direction,
  COALESCE(EXTRACT(EPOCH FROM NULLIF(COALESCE(message_timestamp, created_at)::text, '')::timestamptz), 0) AS message_sort,
  COALESCE(EXTRACT(EPOCH FROM NULLIF(created_at::text, '')::timestamptz), 0) AS created_sort,
  COALESCE(message_timestamp, created_at)::text AS message_at
FROM meta_social_messages;

CREATE OR REPLACE VIEW ristak_chat_email_projection_source AS
SELECT
  'email'::text AS source_kind,
  id AS source_message_id,
  1 AS projection_version,
  CASE WHEN NULLIF(BTRIM(contact_id), '') IS NOT NULL THEN 1 ELSE 0 END AS included,
  NULLIF(BTRIM(contact_id), '') AS contact_id,
  NULL::text AS scope_key,
  direction,
  COALESCE(EXTRACT(EPOCH FROM NULLIF(COALESCE(message_timestamp, created_at)::text, '')::timestamptz), 0) AS message_sort,
  COALESCE(EXTRACT(EPOCH FROM NULLIF(created_at::text, '')::timestamptz), 0) AS created_sort,
  COALESCE(message_timestamp, created_at)::text AS message_at
FROM email_messages;

CREATE OR REPLACE FUNCTION ristak_chat_activity_ledger_insert()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.included != 1 OR NULLIF(NEW.contact_id, '') IS NULL THEN RETURN NEW; END IF;

  INSERT INTO chat_contact_activity (
    contact_id, message_count, last_message_sort, last_created_sort,
    last_source_kind, last_source_message_id, updated_at
  ) VALUES (
    NEW.contact_id, 1, NEW.message_sort, NEW.created_sort,
    NEW.source_kind, NEW.source_message_id, CURRENT_TIMESTAMP
  )
  ON CONFLICT (contact_id) DO UPDATE SET
    message_count = chat_contact_activity.message_count + 1,
    last_message_sort = CASE WHEN
      (EXCLUDED.last_message_sort, EXCLUDED.last_created_sort, EXCLUDED.last_source_kind, EXCLUDED.last_source_message_id) >
      (chat_contact_activity.last_message_sort, chat_contact_activity.last_created_sort, chat_contact_activity.last_source_kind, chat_contact_activity.last_source_message_id)
      THEN EXCLUDED.last_message_sort ELSE chat_contact_activity.last_message_sort END,
    last_created_sort = CASE WHEN
      (EXCLUDED.last_message_sort, EXCLUDED.last_created_sort, EXCLUDED.last_source_kind, EXCLUDED.last_source_message_id) >
      (chat_contact_activity.last_message_sort, chat_contact_activity.last_created_sort, chat_contact_activity.last_source_kind, chat_contact_activity.last_source_message_id)
      THEN EXCLUDED.last_created_sort ELSE chat_contact_activity.last_created_sort END,
    last_source_kind = CASE WHEN
      (EXCLUDED.last_message_sort, EXCLUDED.last_created_sort, EXCLUDED.last_source_kind, EXCLUDED.last_source_message_id) >
      (chat_contact_activity.last_message_sort, chat_contact_activity.last_created_sort, chat_contact_activity.last_source_kind, chat_contact_activity.last_source_message_id)
      THEN EXCLUDED.last_source_kind ELSE chat_contact_activity.last_source_kind END,
    last_source_message_id = CASE WHEN
      (EXCLUDED.last_message_sort, EXCLUDED.last_created_sort, EXCLUDED.last_source_kind, EXCLUDED.last_source_message_id) >
      (chat_contact_activity.last_message_sort, chat_contact_activity.last_created_sort, chat_contact_activity.last_source_kind, chat_contact_activity.last_source_message_id)
      THEN EXCLUDED.last_source_message_id ELSE chat_contact_activity.last_source_message_id END,
    updated_at = CURRENT_TIMESTAMP;

  IF NULLIF(NEW.scope_key, '') IS NOT NULL THEN
    INSERT INTO chat_contact_scope_activity (
      contact_id, scope_key, message_count, last_message_sort, last_created_sort,
      last_source_kind, last_source_message_id, updated_at
    ) VALUES (
      NEW.contact_id, NEW.scope_key, 1, NEW.message_sort, NEW.created_sort,
      NEW.source_kind, NEW.source_message_id, CURRENT_TIMESTAMP
    )
    ON CONFLICT (contact_id, scope_key) DO UPDATE SET
      message_count = chat_contact_scope_activity.message_count + 1,
      last_message_sort = CASE WHEN
        (EXCLUDED.last_message_sort, EXCLUDED.last_created_sort, EXCLUDED.last_source_kind, EXCLUDED.last_source_message_id) >
        (chat_contact_scope_activity.last_message_sort, chat_contact_scope_activity.last_created_sort, chat_contact_scope_activity.last_source_kind, chat_contact_scope_activity.last_source_message_id)
        THEN EXCLUDED.last_message_sort ELSE chat_contact_scope_activity.last_message_sort END,
      last_created_sort = CASE WHEN
        (EXCLUDED.last_message_sort, EXCLUDED.last_created_sort, EXCLUDED.last_source_kind, EXCLUDED.last_source_message_id) >
        (chat_contact_scope_activity.last_message_sort, chat_contact_scope_activity.last_created_sort, chat_contact_scope_activity.last_source_kind, chat_contact_scope_activity.last_source_message_id)
        THEN EXCLUDED.last_created_sort ELSE chat_contact_scope_activity.last_created_sort END,
      last_source_kind = CASE WHEN
        (EXCLUDED.last_message_sort, EXCLUDED.last_created_sort, EXCLUDED.last_source_kind, EXCLUDED.last_source_message_id) >
        (chat_contact_scope_activity.last_message_sort, chat_contact_scope_activity.last_created_sort, chat_contact_scope_activity.last_source_kind, chat_contact_scope_activity.last_source_message_id)
        THEN EXCLUDED.last_source_kind ELSE chat_contact_scope_activity.last_source_kind END,
      last_source_message_id = CASE WHEN
        (EXCLUDED.last_message_sort, EXCLUDED.last_created_sort, EXCLUDED.last_source_kind, EXCLUDED.last_source_message_id) >
        (chat_contact_scope_activity.last_message_sort, chat_contact_scope_activity.last_created_sort, chat_contact_scope_activity.last_source_kind, chat_contact_scope_activity.last_source_message_id)
        THEN EXCLUDED.last_source_message_id ELSE chat_contact_scope_activity.last_source_message_id END,
      updated_at = CURRENT_TIMESTAMP;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ristak_chat_activity_ledger_delete()
RETURNS TRIGGER AS $$
DECLARE
  replacement chat_message_activity%ROWTYPE;
BEGIN
  IF OLD.included != 1 OR NULLIF(OLD.contact_id, '') IS NULL THEN RETURN OLD; END IF;

  UPDATE chat_contact_activity
  SET message_count = message_count - 1, updated_at = CURRENT_TIMESTAMP
  WHERE contact_id = OLD.contact_id;
  DELETE FROM chat_contact_activity WHERE contact_id = OLD.contact_id AND message_count <= 0;

  IF EXISTS (
    SELECT 1 FROM chat_contact_activity
    WHERE contact_id = OLD.contact_id
      AND (last_message_sort, last_created_sort, last_source_kind, last_source_message_id) =
          (OLD.message_sort, OLD.created_sort, OLD.source_kind, OLD.source_message_id)
  ) THEN
    SELECT * INTO replacement
    FROM chat_message_activity
    WHERE included = 1 AND contact_id = OLD.contact_id
    ORDER BY message_sort DESC, created_sort DESC, source_kind DESC, source_message_id DESC
    LIMIT 1;
    IF FOUND THEN
      UPDATE chat_contact_activity SET
        last_message_sort = replacement.message_sort,
        last_created_sort = replacement.created_sort,
        last_source_kind = replacement.source_kind,
        last_source_message_id = replacement.source_message_id,
        updated_at = CURRENT_TIMESTAMP
      WHERE contact_id = OLD.contact_id;
    END IF;
  END IF;

  IF NULLIF(OLD.scope_key, '') IS NOT NULL THEN
    UPDATE chat_contact_scope_activity
    SET message_count = message_count - 1, updated_at = CURRENT_TIMESTAMP
    WHERE contact_id = OLD.contact_id AND scope_key = OLD.scope_key;
    DELETE FROM chat_contact_scope_activity
    WHERE contact_id = OLD.contact_id AND scope_key = OLD.scope_key AND message_count <= 0;

    IF EXISTS (
      SELECT 1 FROM chat_contact_scope_activity
      WHERE contact_id = OLD.contact_id AND scope_key = OLD.scope_key
        AND (last_message_sort, last_created_sort, last_source_kind, last_source_message_id) =
            (OLD.message_sort, OLD.created_sort, OLD.source_kind, OLD.source_message_id)
    ) THEN
      SELECT * INTO replacement
      FROM chat_message_activity
      WHERE included = 1 AND contact_id = OLD.contact_id AND scope_key = OLD.scope_key
      ORDER BY message_sort DESC, created_sort DESC, source_kind DESC, source_message_id DESC
      LIMIT 1;
      IF FOUND THEN
        UPDATE chat_contact_scope_activity SET
          last_message_sort = replacement.message_sort,
          last_created_sort = replacement.created_sort,
          last_source_kind = replacement.source_kind,
          last_source_message_id = replacement.source_message_id,
          updated_at = CURRENT_TIMESTAMP
        WHERE contact_id = OLD.contact_id AND scope_key = OLD.scope_key;
      END IF;
    END IF;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_chat_activity_ledger_insert ON chat_message_activity;
CREATE TRIGGER trg_chat_activity_ledger_insert
AFTER INSERT ON chat_message_activity
FOR EACH ROW EXECUTE FUNCTION ristak_chat_activity_ledger_insert();
DROP TRIGGER IF EXISTS trg_chat_activity_ledger_delete ON chat_message_activity;
CREATE TRIGGER trg_chat_activity_ledger_delete
AFTER DELETE ON chat_message_activity
FOR EACH ROW EXECUTE FUNCTION ristak_chat_activity_ledger_delete();

CREATE OR REPLACE FUNCTION ristak_chat_reproject_source_row()
RETURNS TRIGGER AS $$
DECLARE
  row_id TEXT := CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END;
  kind TEXT := CASE TG_TABLE_NAME
    WHEN 'whatsapp_api_messages' THEN 'whatsapp'
    WHEN 'meta_social_messages' THEN 'meta'
    ELSE 'email'
  END;
BEGIN
  DELETE FROM chat_message_activity
  WHERE source_kind = kind AND source_message_id = row_id;

  IF TG_OP != 'DELETE' THEN
    IF kind = 'whatsapp' THEN
      INSERT INTO chat_message_activity (
        source_kind, source_message_id, projection_version, included,
        contact_id, scope_key, direction, message_sort, created_sort, message_at, updated_at
      ) SELECT source_kind, source_message_id, projection_version, included,
               contact_id, scope_key, direction, message_sort, created_sort, message_at, CURRENT_TIMESTAMP
        FROM ristak_chat_whatsapp_projection_source WHERE source_message_id = row_id;
    ELSIF kind = 'meta' THEN
      INSERT INTO chat_message_activity (
        source_kind, source_message_id, projection_version, included,
        contact_id, scope_key, direction, message_sort, created_sort, message_at, updated_at
      ) SELECT source_kind, source_message_id, projection_version, included,
               contact_id, scope_key, direction, message_sort, created_sort, message_at, CURRENT_TIMESTAMP
        FROM ristak_chat_meta_projection_source WHERE source_message_id = row_id;
    ELSE
      INSERT INTO chat_message_activity (
        source_kind, source_message_id, projection_version, included,
        contact_id, scope_key, direction, message_sort, created_sort, message_at, updated_at
      ) SELECT source_kind, source_message_id, projection_version, included,
               contact_id, scope_key, direction, message_sort, created_sort, message_at, CURRENT_TIMESTAMP
        FROM ristak_chat_email_projection_source WHERE source_message_id = row_id;
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ristak_chat_mark_source_projected()
RETURNS TRIGGER AS $$
BEGIN
  NEW.chat_projection_version := 1;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_chat_activity_whatsapp_version ON whatsapp_api_messages;
CREATE TRIGGER trg_chat_activity_whatsapp_version
BEFORE INSERT OR UPDATE OF contact_id, whatsapp_api_contact_id, phone, from_phone, to_phone,
  business_phone_number_id, business_phone, direction, message_type, message_timestamp, created_at
ON whatsapp_api_messages FOR EACH ROW EXECUTE FUNCTION ristak_chat_mark_source_projected();
DROP TRIGGER IF EXISTS trg_chat_activity_whatsapp_sync ON whatsapp_api_messages;
CREATE TRIGGER trg_chat_activity_whatsapp_sync
AFTER INSERT OR UPDATE OF contact_id, whatsapp_api_contact_id, phone, from_phone, to_phone,
  business_phone_number_id, business_phone, direction, message_type, message_timestamp, created_at OR DELETE
ON whatsapp_api_messages FOR EACH ROW EXECUTE FUNCTION ristak_chat_reproject_source_row();

DROP TRIGGER IF EXISTS trg_chat_activity_meta_version ON meta_social_messages;
CREATE TRIGGER trg_chat_activity_meta_version
BEFORE INSERT OR UPDATE OF contact_id, message_timestamp, created_at
ON meta_social_messages FOR EACH ROW EXECUTE FUNCTION ristak_chat_mark_source_projected();
DROP TRIGGER IF EXISTS trg_chat_activity_meta_sync ON meta_social_messages;
CREATE TRIGGER trg_chat_activity_meta_sync
AFTER INSERT OR UPDATE OF contact_id, message_timestamp, created_at OR DELETE
ON meta_social_messages FOR EACH ROW EXECUTE FUNCTION ristak_chat_reproject_source_row();

DROP TRIGGER IF EXISTS trg_chat_activity_email_version ON email_messages;
CREATE TRIGGER trg_chat_activity_email_version
BEFORE INSERT OR UPDATE OF contact_id, message_timestamp, created_at
ON email_messages FOR EACH ROW EXECUTE FUNCTION ristak_chat_mark_source_projected();
DROP TRIGGER IF EXISTS trg_chat_activity_email_sync ON email_messages;
CREATE TRIGGER trg_chat_activity_email_sync
AFTER INSERT OR UPDATE OF contact_id, message_timestamp, created_at OR DELETE
ON email_messages FOR EACH ROW EXECUTE FUNCTION ristak_chat_reproject_source_row();

CREATE OR REPLACE FUNCTION ristak_chat_enqueue_identity(kind TEXT, value TEXT)
RETURNS VOID AS $$
BEGIN
  IF NULLIF(BTRIM(COALESCE(value, '')), '') IS NULL THEN RETURN; END IF;
  INSERT INTO chat_activity_identity_queue(identity_kind, identity_value)
  VALUES (kind, value)
  ON CONFLICT (identity_kind, identity_value) DO UPDATE SET
    generation = chat_activity_identity_queue.generation + 1,
    cursor_message_id = '',
    created_at = CURRENT_TIMESTAMP;
  UPDATE chat_activity_projection_state SET
    status = 'dirty', revision = revision + 1, updated_at = CURRENT_TIMESTAMP
  WHERE singleton_id = 1;
END;
$$ LANGUAGE plpgsql;

-- El cambio de telefono ocurre tambien en imports masivos. Cada rama queda
-- separada para que PostgreSQL use los indices parciales por identidad; el OR
-- original sobre columnas de msg + profile degradaba a Parallel Seq Scan de
-- todo whatsapp_api_messages aun cuando no habia coincidencia.
CREATE OR REPLACE FUNCTION ristak_chat_unresolved_phone_exists(lookup_phone TEXT)
RETURNS BOOLEAN AS $$
  SELECT NULLIF(BTRIM(COALESCE(lookup_phone, '')), '') IS NOT NULL AND (
    EXISTS (
      SELECT 1
      FROM whatsapp_api_messages msg
      WHERE NULLIF(BTRIM(COALESCE(msg.contact_id, '')), '') IS NULL
        AND msg.phone = lookup_phone
      LIMIT 1
    )
    OR EXISTS (
      SELECT 1
      FROM whatsapp_api_messages msg
      WHERE NULLIF(BTRIM(COALESCE(msg.contact_id, '')), '') IS NULL
        AND msg.from_phone = lookup_phone
      LIMIT 1
    )
    OR EXISTS (
      SELECT 1
      FROM whatsapp_api_messages msg
      WHERE NULLIF(BTRIM(COALESCE(msg.contact_id, '')), '') IS NULL
        AND msg.to_phone = lookup_phone
      LIMIT 1
    )
    OR EXISTS (
      SELECT 1
      FROM whatsapp_api_contacts profile
      JOIN whatsapp_api_messages msg
        ON msg.whatsapp_api_contact_id = profile.id
      WHERE NULLIF(BTRIM(COALESCE(msg.contact_id, '')), '') IS NULL
        AND NULLIF(BTRIM(COALESCE(profile.contact_id, '')), '') IS NULL
        AND profile.phone = lookup_phone
      LIMIT 1
    )
  );
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION ristak_chat_contacts_identity_dirty()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.phone IS NOT DISTINCT FROM NEW.phone THEN RETURN NEW; END IF;
  IF TG_OP != 'INSERT' AND ristak_chat_unresolved_phone_exists(OLD.phone)
    THEN PERFORM ristak_chat_enqueue_identity('phone', OLD.phone); END IF;
  IF TG_OP != 'DELETE' AND ristak_chat_unresolved_phone_exists(NEW.phone)
    THEN PERFORM ristak_chat_enqueue_identity('phone', NEW.phone); END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ristak_chat_extra_phone_identity_dirty()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.contact_id IS NOT DISTINCT FROM NEW.contact_id
     AND OLD.phone IS NOT DISTINCT FROM NEW.phone THEN RETURN NEW; END IF;
  IF TG_OP != 'INSERT' AND ristak_chat_unresolved_phone_exists(OLD.phone)
    THEN PERFORM ristak_chat_enqueue_identity('phone', OLD.phone); END IF;
  IF TG_OP != 'DELETE' AND ristak_chat_unresolved_phone_exists(NEW.phone)
    THEN PERFORM ristak_chat_enqueue_identity('phone', NEW.phone); END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ristak_chat_api_profile_identity_dirty()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.contact_id IS NOT DISTINCT FROM NEW.contact_id
     AND OLD.phone IS NOT DISTINCT FROM NEW.phone THEN RETURN NEW; END IF;
  PERFORM ristak_chat_enqueue_identity('profile', CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END);
  IF TG_OP != 'INSERT' THEN PERFORM ristak_chat_enqueue_identity('phone', OLD.phone); END IF;
  IF TG_OP != 'DELETE' THEN PERFORM ristak_chat_enqueue_identity('phone', NEW.phone); END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ristak_chat_business_alias_identity_dirty()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.id IS NOT DISTINCT FROM NEW.id
     AND OLD.phone_number IS NOT DISTINCT FROM NEW.phone_number
     AND OLD.display_phone_number IS NOT DISTINCT FROM NEW.display_phone_number
     AND OLD.qr_connected_phone IS NOT DISTINCT FROM NEW.qr_connected_phone THEN RETURN NEW; END IF;
  IF TG_OP != 'INSERT' THEN
    PERFORM ristak_chat_enqueue_identity('business_alias', OLD.id);
    PERFORM ristak_chat_enqueue_identity('business_alias_phone', OLD.phone_number);
    PERFORM ristak_chat_enqueue_identity('business_alias_phone', OLD.display_phone_number);
    PERFORM ristak_chat_enqueue_identity('business_alias_phone', OLD.qr_connected_phone);
  END IF;
  IF TG_OP != 'DELETE' THEN
    PERFORM ristak_chat_enqueue_identity('business_alias', NEW.id);
    PERFORM ristak_chat_enqueue_identity('business_alias_phone', NEW.phone_number);
    PERFORM ristak_chat_enqueue_identity('business_alias_phone', NEW.display_phone_number);
    PERFORM ristak_chat_enqueue_identity('business_alias_phone', NEW.qr_connected_phone);
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_chat_activity_contacts_identity ON contacts;
CREATE TRIGGER trg_chat_activity_contacts_identity
AFTER INSERT OR UPDATE OF phone OR DELETE ON contacts
FOR EACH ROW EXECUTE FUNCTION ristak_chat_contacts_identity_dirty();
DROP TRIGGER IF EXISTS trg_chat_activity_extra_phone_identity ON contact_phone_numbers;
CREATE TRIGGER trg_chat_activity_extra_phone_identity
AFTER INSERT OR UPDATE OF contact_id, phone OR DELETE ON contact_phone_numbers
FOR EACH ROW EXECUTE FUNCTION ristak_chat_extra_phone_identity_dirty();
DROP TRIGGER IF EXISTS trg_chat_activity_api_profile_identity ON whatsapp_api_contacts;
CREATE TRIGGER trg_chat_activity_api_profile_identity
AFTER INSERT OR UPDATE OF contact_id, phone OR DELETE ON whatsapp_api_contacts
FOR EACH ROW EXECUTE FUNCTION ristak_chat_api_profile_identity_dirty();
DROP TRIGGER IF EXISTS trg_chat_activity_business_alias_identity ON whatsapp_api_phone_numbers;
CREATE TRIGGER trg_chat_activity_business_alias_identity
AFTER INSERT OR UPDATE OF id, phone_number, display_phone_number, qr_connected_phone OR DELETE
ON whatsapp_api_phone_numbers FOR EACH ROW EXECUTE FUNCTION ristak_chat_business_alias_identity_dirty();
