CREATE TABLE IF NOT EXISTS public_site_content_assets (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  asset_key TEXT NOT NULL,
  label TEXT,
  kind TEXT DEFAULT 'other',
  media_asset_id TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (site_id) REFERENCES public_sites(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_public_site_content_assets_site_key
  ON public_site_content_assets(site_id, asset_key);

CREATE INDEX IF NOT EXISTS idx_public_site_content_assets_media
  ON public_site_content_assets(media_asset_id);
