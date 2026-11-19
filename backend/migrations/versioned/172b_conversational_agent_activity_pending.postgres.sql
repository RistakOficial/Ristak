CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_conversational_agent_activity_pending
  ON conversational_agent_events(id)
  WHERE activity_metrics_version = 0 AND (
    event_type IN ('reply_sent', 'reply_single_sent', 'reply_part_sent',
      'follow_up_sent', 'payment_resume_reply_sent', 'signal_set')
    OR LOWER(event_type) LIKE '%error%'
    OR LOWER(event_type) LIKE '%failed%'
    OR LOWER(event_type) LIKE '%failure%');
