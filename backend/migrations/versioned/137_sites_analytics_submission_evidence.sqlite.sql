SELECT submission_id, tracking_source, event_name, started_at
FROM sessions
LIMIT 0;

CREATE INDEX IF NOT EXISTS idx_sessions_submission_tracking_event
  ON sessions(submission_id, tracking_source, event_name, started_at);
