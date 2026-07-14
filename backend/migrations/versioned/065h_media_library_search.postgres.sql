CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_media_assets_library_search_trgm
  ON media_assets
  USING gin (
    (
      LOWER(
        COALESCE(original_filename, '') || ' ' ||
        COALESCE(stored_filename, '') || ' ' ||
        COALESCE(bunny_path, '') || ' ' ||
        COALESCE(public_url, '') || ' ' ||
        COALESCE(mime_type, '') || ' ' ||
        COALESCE(media_type, '') || ' ' ||
        COALESCE(module, '')
      )
    ) gin_trgm_ops
  )
  WHERE deleted_at IS NULL;
