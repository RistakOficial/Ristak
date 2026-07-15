CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_public_site_submissions_site
  ON public_site_submissions(site_id, created_at);
