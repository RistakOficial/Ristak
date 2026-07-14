CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_public_sites_updated_at_id
  ON public_sites(updated_at DESC, id DESC);
