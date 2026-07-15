CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_meta_ads_ad_date
  ON meta_ads(ad_id, date);
