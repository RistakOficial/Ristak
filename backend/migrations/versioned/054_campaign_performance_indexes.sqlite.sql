CREATE INDEX IF NOT EXISTS idx_meta_ads_date_campaign
  ON meta_ads(date, campaign_id);

CREATE INDEX IF NOT EXISTS idx_meta_ads_campaign_date_adset
  ON meta_ads(campaign_id, date, adset_id);

CREATE INDEX IF NOT EXISTS idx_meta_ads_adset_date_ad
  ON meta_ads(adset_id, date, ad_id);

CREATE INDEX IF NOT EXISTS idx_contacts_attribution_ad_created
  ON contacts(attribution_ad_id, created_at);

CREATE INDEX IF NOT EXISTS idx_sessions_campaign_started
  ON sessions(campaign_id, started_at);

CREATE INDEX IF NOT EXISTS idx_sessions_adset_started
  ON sessions(adset_id, started_at);

CREATE INDEX IF NOT EXISTS idx_sessions_ad_started
  ON sessions(ad_id, started_at);
