CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_video_sessions_asset_date
  ON video_playback_sessions(media_asset_id, last_event_at);
