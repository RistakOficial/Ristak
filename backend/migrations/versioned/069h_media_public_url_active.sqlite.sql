CREATE INDEX IF NOT EXISTS idx_media_assets_public_url_active
  ON media_assets (public_url)
  WHERE public_url IS NOT NULL
    AND deleted_at IS NULL
    AND status != 'deleted';

