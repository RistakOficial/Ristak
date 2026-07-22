CREATE TABLE IF NOT EXISTS media_folders (
  business_id TEXT NOT NULL,
  path TEXT NOT NULL,
  parent_path TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  created_by TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (business_id, path)
);

CREATE INDEX IF NOT EXISTS idx_media_folders_parent
  ON media_folders(business_id, parent_path, name);
