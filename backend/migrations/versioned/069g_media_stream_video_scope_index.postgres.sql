CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_media_assets_stream_video_scope
  ON media_assets (business_id, module, stream_video_id)
  WHERE stream_video_id IS NOT NULL
    AND media_type = 'video'
    AND deleted_at IS NULL
    AND status != 'deleted';
