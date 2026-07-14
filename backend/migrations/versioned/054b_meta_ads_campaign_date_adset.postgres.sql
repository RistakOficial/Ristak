CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_meta_ads_campaign_date_adset
  ON meta_ads(campaign_id, date, adset_id);
