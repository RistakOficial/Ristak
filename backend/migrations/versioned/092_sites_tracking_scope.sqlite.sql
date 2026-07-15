CREATE INDEX IF NOT EXISTS idx_public_sites_tracking_scope
  ON public_sites(site_type, status, updated_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_public_sites_tracking_page_mode_scope
  ON public_sites(
    site_type,
    status,
    (
      CASE
        WHEN json_valid(theme_json)
          THEN COALESCE(json_extract(theme_json, '$.pageMode'), 'funnel')
        ELSE 'funnel'
      END
    ),
    updated_at DESC,
    id DESC
  )
  WHERE site_type = 'landing_page';

CREATE INDEX IF NOT EXISTS idx_sessions_site_created_at
  ON sessions(site_id, created_at)
  WHERE site_id IS NOT NULL AND site_id != '';

CREATE INDEX IF NOT EXISTS idx_sessions_form_site_created_at
  ON sessions(form_site_id, created_at)
  WHERE form_site_id IS NOT NULL AND form_site_id != '';

CREATE INDEX IF NOT EXISTS idx_public_site_submissions_site
  ON public_site_submissions(site_id, created_at);

CREATE INDEX IF NOT EXISTS idx_public_site_submissions_form_site
  ON public_site_submissions(form_site_id, created_at);
