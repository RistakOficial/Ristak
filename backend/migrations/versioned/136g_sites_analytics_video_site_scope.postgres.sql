CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_video_events_site_time_type
  ON video_playback_events(site_id, event_at, event_name, media_asset_id, playback_id);
