CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_video_sessions_site_date_asset
  ON video_playback_sessions(site_id, last_event_at, media_asset_id)
  WHERE site_id IS NOT NULL AND site_id != '';
