CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_public_sites_tracking_scope
  ON public_sites(site_type, status, updated_at DESC, id DESC);
