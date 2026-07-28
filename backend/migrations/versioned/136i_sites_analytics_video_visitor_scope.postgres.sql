CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_video_events_visitor_time
  ON video_playback_events(visitor_id, event_at, playback_id);
