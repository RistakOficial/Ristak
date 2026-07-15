CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_public_site_submissions_form_site
  ON public_site_submissions(form_site_id, created_at);
