ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS page_flow_revision TEXT,
  ADD COLUMN IF NOT EXISTS page_journey_id TEXT;
