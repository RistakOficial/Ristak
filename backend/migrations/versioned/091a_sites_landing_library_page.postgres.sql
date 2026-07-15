CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_public_sites_landing_library_page
  ON public_sites((COALESCE(updated_at, created_at, TIMESTAMP '1970-01-01 00:00:00')) DESC, id DESC)
  WHERE site_type = 'landing_page';
