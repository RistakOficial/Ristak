ALTER TABLE conversational_agent_state
  ADD COLUMN agent_metrics_projection_version INTEGER NOT NULL DEFAULT 0;

