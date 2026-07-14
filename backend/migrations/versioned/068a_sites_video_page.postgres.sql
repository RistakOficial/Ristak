CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_media_assets_sites_video_page
  ON media_assets(
    business_id,
    module,
    media_type,
    status,
    (COALESCE(created_at, TIMESTAMP '1970-01-01 00:00:00')) DESC,
    id DESC
  )
  WHERE deleted_at IS NULL;
