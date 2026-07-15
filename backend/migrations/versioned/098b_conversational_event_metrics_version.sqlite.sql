ALTER TABLE conversational_agent_events
  ADD COLUMN agent_metrics_projection_version INTEGER NOT NULL DEFAULT 0;

