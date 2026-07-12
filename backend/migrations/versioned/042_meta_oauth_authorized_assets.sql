CREATE TABLE IF NOT EXISTS meta_oauth_authorized_assets (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  payload_encrypted TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_meta_oauth_authorized_assets_connection
  ON meta_oauth_authorized_assets(connection_id);
