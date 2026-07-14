CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_meta_ads_date_campaign
  ON meta_ads(date, campaign_id);
