CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_conversational_agent_state_metrics_pending
  ON conversational_agent_state(id)
  WHERE agent_metrics_projection_version < 1;

