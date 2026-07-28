CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_video_events_playback_type_time
  ON video_playback_events(playback_id, event_name, event_at, id);
