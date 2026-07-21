CREATE TABLE IF NOT EXISTS contact_conversational_channel_preferences (
  contact_id TEXT PRIMARY KEY,
  channel TEXT NOT NULL CHECK (channel IN ('whatsapp', 'sms')),
  selected_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  selected_by_user_id TEXT,
  selection_source TEXT NOT NULL DEFAULT 'manual',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_contact_conv_channel_preference_selected
  ON contact_conversational_channel_preferences(channel, selected_at);
