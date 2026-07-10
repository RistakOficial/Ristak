CREATE TABLE IF NOT EXISTS chat_inbound_message_claims (
  channel TEXT NOT NULL,
  message_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  message_timestamp DATETIME,
  claimed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (channel, message_id)
);

CREATE INDEX IF NOT EXISTS idx_chat_inbound_message_claims_contact
  ON chat_inbound_message_claims(contact_id);

INSERT INTO chat_inbound_message_claims (
  channel, message_id, contact_id, message_timestamp, claimed_at
)
SELECT
  'whatsapp',
  id,
  contact_id,
  COALESCE(message_timestamp, created_at),
  COALESCE(created_at, CURRENT_TIMESTAMP)
FROM whatsapp_api_messages
WHERE contact_id IS NOT NULL
  AND LOWER(COALESCE(direction, '')) = 'inbound'
ON CONFLICT(channel, message_id) DO NOTHING;

INSERT INTO chat_inbound_message_claims (
  channel, message_id, contact_id, message_timestamp, claimed_at
)
SELECT
  LOWER(COALESCE(platform, 'meta')),
  id,
  contact_id,
  COALESCE(message_timestamp, created_at),
  COALESCE(created_at, CURRENT_TIMESTAMP)
FROM meta_social_messages
WHERE contact_id IS NOT NULL
  AND LOWER(COALESCE(direction, '')) = 'inbound'
ON CONFLICT(channel, message_id) DO NOTHING;
