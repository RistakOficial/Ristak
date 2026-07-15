CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contact_journey_video_keyset
  ON video_playback_sessions(contact_id, first_event_at DESC, id DESC);

