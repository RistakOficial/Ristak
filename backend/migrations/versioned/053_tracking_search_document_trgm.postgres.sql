CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sessions_search_document_trgm
  ON sessions USING GIN ((
    LOWER(
      COALESCE(session_id, '') || ' ' ||
      COALESCE(visitor_id, '') || ' ' ||
      COALESCE(contact_id, '') || ' ' ||
      COALESCE(full_name, '') || ' ' ||
      COALESCE(email, '') || ' ' ||
      COALESCE(event_name, '') || ' ' ||
      COALESCE(page_url, '') || ' ' ||
      COALESCE(referrer_url, '') || ' ' ||
      COALESCE(utm_source, '') || ' ' ||
      COALESCE(utm_campaign, '') || ' ' ||
      COALESCE(utm_content, '') || ' ' ||
      COALESCE(campaign_id, '') || ' ' ||
      COALESCE(ad_id, '') || ' ' ||
      COALESCE(site_name, '')
    )
  ) gin_trgm_ops);
