CREATE INDEX IF NOT EXISTS idx_public_site_blocks_form_catalog_page
  ON public_site_blocks(
    COALESCE(updated_at, created_at, '1970-01-01 00:00:00') DESC,
    (site_id || ':form_embed:' || id) DESC
  )
  WHERE block_type = 'form_embed';

CREATE INDEX IF NOT EXISTS idx_public_site_imports_form_catalog_page
  ON public_site_imports(
    COALESCE(updated_at, created_at, '1970-01-01 00:00:00') DESC,
    site_id DESC
  );
