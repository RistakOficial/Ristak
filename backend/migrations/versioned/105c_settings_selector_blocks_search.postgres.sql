CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_public_site_blocks_form_catalog_search
  ON public_site_blocks USING GIN ((
    LOWER(
      COALESCE(id, '') || ' ' ||
      COALESCE(label, '') || ' ' ||
      COALESCE(settings_json, '')
    )
  ) gin_trgm_ops)
  WHERE block_type = 'form_embed';
