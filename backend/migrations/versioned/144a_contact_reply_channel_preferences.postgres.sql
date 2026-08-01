CREATE TABLE IF NOT EXISTS contact_reply_channel_preferences (
  contact_id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  route_id TEXT,
  route_label TEXT,
  selected_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  selected_by_user_id TEXT,
  selection_source TEXT NOT NULL DEFAULT 'manual',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
);

INSERT INTO contact_reply_channel_preferences (
  contact_id,
  channel,
  selected_at,
  selected_by_user_id,
  selection_source,
  created_at,
  updated_at
)
SELECT
  contact_id,
  channel,
  selected_at,
  selected_by_user_id,
  selection_source,
  created_at,
  updated_at
FROM contact_conversational_channel_preferences
ON CONFLICT(contact_id) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_contact_reply_channel_preference_selected
  ON contact_reply_channel_preferences(channel, selected_at);
