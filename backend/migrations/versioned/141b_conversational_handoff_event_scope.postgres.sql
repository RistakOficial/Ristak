CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_conv_agent_events_contact_agent_type_created
  ON conversational_agent_events(contact_id, agent_id, event_type, created_at, id);
