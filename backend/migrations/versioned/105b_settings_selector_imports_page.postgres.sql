CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_public_site_imports_form_catalog_page
  ON public_site_imports(
    (COALESCE(updated_at, created_at, TIMESTAMP '1970-01-01 00:00:00')) DESC,
    site_id DESC
  );
