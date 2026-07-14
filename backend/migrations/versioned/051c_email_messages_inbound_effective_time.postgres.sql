CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_email_messages_inbound_effective_time
  ON email_messages(
    LOWER(COALESCE(direction, 'outbound')),
    COALESCE(message_timestamp, created_at)
  );
