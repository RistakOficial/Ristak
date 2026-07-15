CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_conversational_agent_state_paused_expiry
  ON conversational_agent_state(paused_until_at, id)
  WHERE status = 'paused' AND paused_until_at IS NOT NULL;

