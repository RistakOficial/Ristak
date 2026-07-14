CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_meta_ads_adset_date_ad
  ON meta_ads(adset_id, date, ad_id);
