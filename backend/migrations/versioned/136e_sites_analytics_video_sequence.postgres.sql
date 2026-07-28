CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_video_events_playback_sequence
  ON video_playback_events(playback_id, event_sequence)
  WHERE event_sequence IS NOT NULL;
