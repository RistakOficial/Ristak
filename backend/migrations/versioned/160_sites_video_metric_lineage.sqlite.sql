CREATE TABLE IF NOT EXISTS site_video_metric_lineage (
  site_id TEXT NOT NULL,
  block_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  canonical_asset_id TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (site_id, block_id, asset_id)
);

CREATE INDEX IF NOT EXISTS idx_site_video_metric_lineage_canonical
ON site_video_metric_lineage(canonical_asset_id, site_id, block_id);

CREATE TABLE IF NOT EXISTS site_video_replacements (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  block_id TEXT NOT NULL,
  previous_asset_id TEXT,
  replacement_asset_id TEXT NOT NULL,
  metrics_mode TEXT NOT NULL CHECK (metrics_mode IN ('preserve', 'reset')),
  canonical_asset_id TEXT NOT NULL,
  requested_by_user_id TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_site_video_replacements_block
ON site_video_replacements(site_id, block_id, created_at);

CREATE INDEX IF NOT EXISTS idx_site_video_replacements_assets
ON site_video_replacements(previous_asset_id, replacement_asset_id);
