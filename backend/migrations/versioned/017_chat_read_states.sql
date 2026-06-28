CREATE TABLE IF NOT EXISTS chat_read_states (
  user_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  unread_count INTEGER DEFAULT 0,
  last_read_at DATETIME,
  last_unread_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, contact_id)
);

CREATE INDEX IF NOT EXISTS idx_chat_read_states_contact
  ON chat_read_states (contact_id);

CREATE INDEX IF NOT EXISTS idx_chat_read_states_user_unread
  ON chat_read_states (user_id, unread_count);
