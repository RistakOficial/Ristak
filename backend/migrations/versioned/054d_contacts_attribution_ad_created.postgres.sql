CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contacts_attribution_ad_created
  ON contacts(attribution_ad_id, created_at);
