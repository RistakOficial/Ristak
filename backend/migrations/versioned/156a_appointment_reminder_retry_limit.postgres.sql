ALTER TABLE appointment_reminder_sends
  ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 1;

ALTER TABLE whatsapp_api_messages
  ADD COLUMN IF NOT EXISTS hidden_from_chat INTEGER NOT NULL DEFAULT 0;

-- No existe historial fiable del número de intentos anterior a esta versión.
-- Un error legacy se trata como agotado para no revivir campañas de reintentos.
UPDATE appointment_reminder_sends
SET attempt_count = 2
WHERE LOWER(COALESCE(status, '')) = 'error';

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
    LOWER(COALESCE(msg.message_type, '')) <> 'status'
      AND COALESCE(msg.hidden_from_chat, 0) = 0 AS is_message,
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

DROP TRIGGER IF EXISTS trg_chat_activity_whatsapp_version ON whatsapp_api_messages;
CREATE TRIGGER trg_chat_activity_whatsapp_version
BEFORE INSERT OR UPDATE OF contact_id, whatsapp_api_contact_id, phone, from_phone, to_phone,
  business_phone_number_id, business_phone, direction, message_type, hidden_from_chat,
  message_timestamp, created_at
ON whatsapp_api_messages FOR EACH ROW EXECUTE FUNCTION ristak_chat_mark_source_projected();

DROP TRIGGER IF EXISTS trg_chat_activity_whatsapp_sync ON whatsapp_api_messages;
CREATE TRIGGER trg_chat_activity_whatsapp_sync
AFTER INSERT OR UPDATE OF contact_id, whatsapp_api_contact_id, phone, from_phone, to_phone,
  business_phone_number_id, business_phone, direction, message_type, hidden_from_chat,
  message_timestamp, created_at OR DELETE
ON whatsapp_api_messages FOR EACH ROW EXECUTE FUNCTION ristak_chat_reproject_source_row();
