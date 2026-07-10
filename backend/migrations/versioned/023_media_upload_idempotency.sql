CREATE TABLE IF NOT EXISTS media_upload_requests (
  business_id TEXT NOT NULL,
  client_upload_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  owner_token TEXT,
  asset_id TEXT,
  response_json TEXT,
  error_status INTEGER,
  error_message TEXT,
  lease_expires_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (business_id, client_upload_id)
);

CREATE INDEX IF NOT EXISTS idx_media_upload_requests_asset
  ON media_upload_requests(asset_id);

CREATE INDEX IF NOT EXISTS idx_media_upload_requests_status
  ON media_upload_requests(status, lease_expires_at);
