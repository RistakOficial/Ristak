CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_video_events_asset_time_type
  ON video_playback_events(media_asset_id, event_at, event_name, playback_id);
