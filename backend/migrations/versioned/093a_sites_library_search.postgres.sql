CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_public_sites_library_search_trgm
  ON public_sites USING GIN ((
    LOWER(
      COALESCE(id, '') || ' ' ||
      COALESCE(name, '') || ' ' ||
      COALESCE(title, '') || ' ' ||
      COALESCE(description, '') || ' ' ||
      COALESCE(slug, '') || ' ' ||
      COALESCE(domain, '') || ' ' ||
      COALESCE(site_type, '') || ' ' ||
      COALESCE(status, '')
    )
  ) gin_trgm_ops);
