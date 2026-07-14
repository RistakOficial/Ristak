CREATE INDEX IF NOT EXISTS idx_media_assets_library_folder_page
  ON media_assets(
    business_id,
    folder_path,
    (COALESCE(created_at, '1970-01-01 00:00:00')) DESC,
    id DESC
  )
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_media_assets_library_type_status_page
  ON media_assets(
    business_id,
    media_type,
    status,
    (COALESCE(created_at, '1970-01-01 00:00:00')) DESC,
    id DESC
  )
  WHERE deleted_at IS NULL;
