CREATE INDEX IF NOT EXISTS idx_public_sites_landing_library_folder_page
  ON public_sites(
    COALESCE(
      NULLIF(
        TRIM(CAST(COALESCE(
          json_extract(
            (CASE WHEN json_valid(theme_json) THEN theme_json ELSE '{}' END),
            '$.libraryFolderId'
          ),
          ''
        ) AS TEXT)),
        ''
      ),
      '__root__'
    ),
    COALESCE(updated_at, created_at, '1970-01-01 00:00:00') DESC,
    id DESC
  )
  WHERE site_type = 'landing_page';

CREATE INDEX IF NOT EXISTS idx_public_sites_form_library_folder_page
  ON public_sites(
    COALESCE(
      NULLIF(
        TRIM(CAST(COALESCE(
          json_extract(
            (CASE WHEN json_valid(theme_json) THEN theme_json ELSE '{}' END),
            '$.libraryFolderId'
          ),
          ''
        ) AS TEXT)),
        ''
      ),
      CASE CASE
        WHEN LOWER(TRIM(CAST(COALESCE(
          json_extract(
            (CASE WHEN json_valid(theme_json) THEN theme_json ELSE '{}' END),
            '$.librarySource'
          ),
          ''
        ) AS TEXT))) IN ('site_embed', 'html', 'video_gate', 'calendar', 'manual')
          THEN LOWER(TRIM(CAST(COALESCE(
            json_extract(
              (CASE WHEN json_valid(theme_json) THEN theme_json ELSE '{}' END),
              '$.librarySource'
            ),
            ''
          ) AS TEXT)))
        WHEN TRIM(CAST(COALESCE(
          json_extract(
            (CASE WHEN json_valid(theme_json) THEN theme_json ELSE '{}' END),
            '$.importedHtmlSource'
          ),
          ''
        ) AS TEXT)) != '' OR TRIM(CAST(COALESCE(
          json_extract(
            (CASE WHEN json_valid(theme_json) THEN theme_json ELSE '{}' END),
            '$.importedHtml'
          ),
          ''
        ) AS TEXT)) != '' THEN 'html'
        ELSE 'manual'
      END
        WHEN 'site_embed' THEN 'system-site-forms'
        WHEN 'html' THEN 'system-html-forms'
        WHEN 'video_gate' THEN 'system-video-forms'
        WHEN 'calendar' THEN 'system-calendar-forms'
        ELSE '__root__'
      END
    ),
    COALESCE(updated_at, created_at, '1970-01-01 00:00:00') DESC,
    id DESC
  )
  WHERE site_type IN ('standard_form', 'interactive_form');
