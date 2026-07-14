CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_meta_messages_inbound_effective_time
  ON meta_social_messages(
    LOWER(COALESCE(direction, 'inbound')),
    COALESCE(message_timestamp, created_at)
  );
