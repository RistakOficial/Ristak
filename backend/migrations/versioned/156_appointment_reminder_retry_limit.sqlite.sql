-- initTables repara estas columnas antes de ejecutar migraciones versionadas.
-- Los SELECT fallan cerrado si una instalación SQLite quedó incompleta.
SELECT attempt_count
FROM appointment_reminder_sends
LIMIT 0;

SELECT hidden_from_chat
FROM whatsapp_api_messages
LIMIT 0;

-- No existe historial fiable del número de intentos anterior a esta versión.
-- Un error legacy se trata como agotado para no revivir campañas de reintentos.
UPDATE appointment_reminder_sends
SET attempt_count = 2
WHERE LOWER(COALESCE(status, '')) = 'error';

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
    LOWER(COALESCE(msg.message_type, '')) <> 'status'
      AND COALESCE(msg.hidden_from_chat, 0) = 0 AS is_message,
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

DROP TRIGGER IF EXISTS trg_chat_activity_whatsapp_update;
CREATE TRIGGER trg_chat_activity_whatsapp_update
AFTER UPDATE OF contact_id, whatsapp_api_contact_id, phone, from_phone, to_phone,
  business_phone_number_id, business_phone, direction, message_type, hidden_from_chat,
  message_timestamp, created_at
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
