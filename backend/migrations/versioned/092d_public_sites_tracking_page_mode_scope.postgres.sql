CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_public_sites_tracking_page_mode_scope
  ON public_sites(
    site_type,
    status,
    (COALESCE(ristak_safe_jsonb(theme_json) ->> 'pageMode', 'funnel')),
    updated_at DESC,
    id DESC
  )
  WHERE site_type = 'landing_page';
