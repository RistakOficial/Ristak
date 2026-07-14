CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_media_assets_library_business_type_page
  ON media_assets (
    business_id,
    media_type,
    (COALESCE(created_at, TIMESTAMP '1970-01-01 00:00:00')) DESC,
    id DESC
  )
  WHERE deleted_at IS NULL AND status != 'deleted';
