CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_meta_ads_overview_date_cover
  ON meta_ads(date)
  INCLUDE (spend, clicks, reach);
