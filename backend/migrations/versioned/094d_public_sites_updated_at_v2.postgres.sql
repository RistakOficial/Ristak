CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_public_sites_updated_at_id_v2
  ON public_sites(
    (COALESCE(updated_at, created_at, TIMESTAMP '1970-01-01 00:00:00')) DESC,
    id DESC
  );
