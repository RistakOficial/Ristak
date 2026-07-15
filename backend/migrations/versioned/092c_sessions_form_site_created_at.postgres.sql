CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sessions_form_site_created_at
  ON sessions(form_site_id, created_at)
  WHERE form_site_id IS NOT NULL AND form_site_id != '';
