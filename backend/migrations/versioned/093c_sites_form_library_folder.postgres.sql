CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_public_sites_form_library_folder_page
  ON public_sites(
    COALESCE(
      NULLIF(BTRIM(COALESCE(ristak_safe_jsonb(theme_json) ->> 'libraryFolderId', '')), ''),
      CASE CASE
        WHEN LOWER(BTRIM(COALESCE(ristak_safe_jsonb(theme_json) ->> 'librarySource', '')))
          IN ('site_embed', 'html', 'video_gate', 'calendar', 'manual')
          THEN LOWER(BTRIM(COALESCE(ristak_safe_jsonb(theme_json) ->> 'librarySource', '')))
        WHEN BTRIM(COALESCE(ristak_safe_jsonb(theme_json) ->> 'importedHtmlSource', '')) != ''
          OR BTRIM(COALESCE(ristak_safe_jsonb(theme_json) ->> 'importedHtml', '')) != ''
          THEN 'html'
        ELSE 'manual'
      END
        WHEN 'site_embed' THEN 'system-site-forms'
        WHEN 'html' THEN 'system-html-forms'
        WHEN 'video_gate' THEN 'system-video-forms'
        WHEN 'calendar' THEN 'system-calendar-forms'
        ELSE '__root__'
      END
    ),
    (COALESCE(updated_at, created_at, TIMESTAMP '1970-01-01 00:00:00')) DESC,
    id DESC
  )
  WHERE site_type IN ('standard_form', 'interactive_form');
