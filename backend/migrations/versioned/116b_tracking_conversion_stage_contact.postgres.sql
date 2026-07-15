CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tracking_conversion_contact_fact_stage_contact
  ON tracking_conversion_contact_fact(stage, contact_id);
