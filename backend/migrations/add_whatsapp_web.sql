-- WhatsApp Web / Baileys receiver tables.
-- This is intentionally separate from WhatsApp Business API tables and
-- from whatsapp_attribution, because this connector is not the official API.

CREATE TABLE IF NOT EXISTS whatsapp_web_sessions (
  id TEXT PRIMARY KEY,
  label TEXT,
  status TEXT DEFAULT 'disconnected',
  phone TEXT,
  jid TEXT,
  push_name TEXT,
  qr_code TEXT,
  qr_image TEXT,
  last_error TEXT,
  connected_at TIMESTAMP,
  disconnected_at TIMESTAMP,
  last_qr_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS whatsapp_web_auth_state (
  session_id TEXT NOT NULL,
  auth_key TEXT NOT NULL,
  value_json TEXT,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (session_id, auth_key),
  FOREIGN KEY (session_id) REFERENCES whatsapp_web_sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS whatsapp_web_contacts (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  contact_id TEXT,
  remote_jid TEXT,
  phone TEXT,
  push_name TEXT,
  display_name TEXT,
  first_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  message_count INTEGER DEFAULT 0,
  raw_profile_json TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(session_id, remote_jid),
  FOREIGN KEY (session_id) REFERENCES whatsapp_web_sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS whatsapp_web_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  whatsapp_web_contact_id TEXT,
  contact_id TEXT,
  remote_jid TEXT,
  phone TEXT,
  message_id TEXT,
  direction TEXT,
  message_type TEXT,
  message_text TEXT,
  push_name TEXT,
  message_timestamp TIMESTAMP,
  raw_payload_json TEXT,
  context_info_json TEXT,
  detected_ctwa_clid TEXT,
  detected_source_id TEXT,
  detected_source_url TEXT,
  detected_source_type TEXT,
  detected_source_app TEXT,
  detected_entry_point TEXT,
  detected_conversion_data TEXT,
  detected_ctwa_payload TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (session_id) REFERENCES whatsapp_web_sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (whatsapp_web_contact_id) REFERENCES whatsapp_web_contacts(id) ON DELETE SET NULL,
  FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS whatsapp_web_attribution (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  whatsapp_web_message_id TEXT,
  whatsapp_web_contact_id TEXT,
  contact_id TEXT,
  remote_jid TEXT,
  phone TEXT,
  message_id TEXT,
  detected_ctwa_clid TEXT,
  detected_source_id TEXT,
  detected_source_url TEXT,
  detected_source_type TEXT,
  detected_source_app TEXT,
  detected_entry_point TEXT,
  detected_conversion_data TEXT,
  detected_ctwa_payload TEXT,
  external_ad_reply_json TEXT,
  context_info_json TEXT,
  raw_payload_json TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (session_id) REFERENCES whatsapp_web_sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (whatsapp_web_message_id) REFERENCES whatsapp_web_messages(id) ON DELETE CASCADE,
  FOREIGN KEY (whatsapp_web_contact_id) REFERENCES whatsapp_web_contacts(id) ON DELETE SET NULL,
  FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_web_sessions_status ON whatsapp_web_sessions(status);
CREATE INDEX IF NOT EXISTS idx_whatsapp_web_contacts_phone ON whatsapp_web_contacts(phone);
CREATE INDEX IF NOT EXISTS idx_whatsapp_web_contacts_contact ON whatsapp_web_contacts(contact_id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_web_messages_contact ON whatsapp_web_messages(contact_id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_web_messages_remote ON whatsapp_web_messages(remote_jid);
CREATE INDEX IF NOT EXISTS idx_whatsapp_web_messages_created ON whatsapp_web_messages(created_at);
CREATE INDEX IF NOT EXISTS idx_whatsapp_web_attr_contact ON whatsapp_web_attribution(contact_id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_web_attr_ctwa ON whatsapp_web_attribution(detected_ctwa_clid);
CREATE INDEX IF NOT EXISTS idx_whatsapp_web_attr_source ON whatsapp_web_attribution(detected_source_id);

