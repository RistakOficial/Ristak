CREATE TABLE IF NOT EXISTS site_video_placements (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  block_id TEXT NOT NULL,
  media_asset_id TEXT NOT NULL,
  canonical_asset_id TEXT NOT NULL,
  public_page_id TEXT,
  page_title TEXT,
  page_path TEXT,
  asset_name TEXT,
  asset_public_url TEXT,
  stream_video_id TEXT,
  activated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deactivated_at TIMESTAMPTZ,
  deactivation_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_site_video_placements_active_block
ON site_video_placements(site_id, block_id)
WHERE deactivated_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_site_video_placements_canonical
ON site_video_placements(canonical_asset_id, site_id, deactivated_at);

CREATE INDEX IF NOT EXISTS idx_site_video_placements_asset
ON site_video_placements(media_asset_id, site_id, deactivated_at);

WITH video_blocks AS (
  SELECT
    block.id,
    block.site_id,
    block.label,
    block.content,
    block.created_at,
    ristak_safe_jsonb(block.settings_json) AS settings_json,
    COALESCE(
      NULLIF(BTRIM(ristak_safe_jsonb(block.settings_json) ->> 'mediaAssetId'), ''),
      NULLIF(BTRIM(ristak_safe_jsonb(block.settings_json) ->> 'media_asset_id'), '')
    ) AS explicit_asset_id,
    COALESCE(
      NULLIF(BTRIM(ristak_safe_jsonb(block.settings_json) ->> 'mediaUrl'), ''),
      NULLIF(BTRIM(ristak_safe_jsonb(block.settings_json) ->> 'media_url'), ''),
      NULLIF(BTRIM(COALESCE(block.content, '')), '')
    ) AS media_url,
    COALESCE(
      NULLIF(BTRIM(ristak_safe_jsonb(block.settings_json) ->> 'pageId'), ''),
      NULLIF(BTRIM(ristak_safe_jsonb(block.settings_json) ->> 'page_id'), ''),
      'page-1'
    ) AS public_page_id
  FROM public_site_blocks block
  WHERE block.block_type = 'video'
), resolved_blocks AS (
  SELECT
    video_blocks.*,
    media.id AS media_asset_id,
    media.original_filename,
    media.stored_filename,
    media.public_url,
    media.stream_video_id
  FROM video_blocks
  INNER JOIN media_assets media
    ON (
      video_blocks.explicit_asset_id IS NOT NULL
      AND media.id = video_blocks.explicit_asset_id
    ) OR (
      video_blocks.explicit_asset_id IS NULL
      AND video_blocks.media_url IS NOT NULL
      AND media.public_url = video_blocks.media_url
    )
  WHERE media.media_type = 'video'
)
INSERT INTO site_video_placements (
  id, site_id, block_id, media_asset_id, canonical_asset_id,
  public_page_id, page_title, page_path, asset_name, asset_public_url,
  stream_video_id, activated_at, deactivated_at, deactivation_reason,
  created_at, updated_at
)
SELECT
  'site_video_placement_' || md5(random()::text || clock_timestamp()::text || resolved.id || resolved.media_asset_id),
  resolved.site_id,
  resolved.id,
  resolved.media_asset_id,
  COALESCE(lineage.canonical_asset_id, resolved.media_asset_id),
  resolved.public_page_id,
  NULL,
  NULL,
  COALESCE(NULLIF(resolved.original_filename, ''), NULLIF(resolved.stored_filename, ''), NULLIF(resolved.label, ''), 'Video'),
  resolved.public_url,
  resolved.stream_video_id,
  COALESCE(resolved.created_at, CURRENT_TIMESTAMP),
  NULL,
  NULL,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM resolved_blocks resolved
LEFT JOIN site_video_metric_lineage lineage
  ON lineage.site_id = resolved.site_id
  AND lineage.block_id = resolved.id
  AND lineage.asset_id = resolved.media_asset_id
ON CONFLICT DO NOTHING;

INSERT INTO site_video_placements (
  id, site_id, block_id, media_asset_id, canonical_asset_id,
  public_page_id, page_title, page_path, asset_name, asset_public_url,
  stream_video_id, activated_at, deactivated_at, deactivation_reason,
  created_at, updated_at
)
SELECT
  'site_video_placement_' || md5(random()::text || clock_timestamp()::text || binding.id || media.id),
  binding.site_id,
  'content_asset:' || binding.id,
  media.id,
  media.id,
  'page-1',
  'Página HTML',
  '/',
  COALESCE(NULLIF(media.original_filename, ''), NULLIF(media.stored_filename, ''), NULLIF(binding.label, ''), 'Video'),
  media.public_url,
  media.stream_video_id,
  COALESCE(binding.created_at, CURRENT_TIMESTAMP),
  NULL,
  NULL,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM public_site_content_assets binding
INNER JOIN media_assets media ON media.id = binding.media_asset_id
WHERE media.media_type = 'video'
ON CONFLICT DO NOTHING;

WITH resolved_events AS (
  SELECT
    event.site_id,
    COALESCE(NULLIF(event.block_id, ''), 'legacy_event:' || media.id || ':' || COALESCE(NULLIF(event.public_page_id, ''), 'unknown')) AS block_id,
    media.id AS media_asset_id,
    COALESCE(NULLIF(event.public_page_id, ''), 'page-1') AS public_page_id,
    MIN(event.page_url) AS page_url,
    MIN(event.event_at) AS activated_at,
    MAX(event.event_at) AS deactivated_at,
    MIN(media.original_filename) AS original_filename,
    MIN(media.stored_filename) AS stored_filename,
    MIN(media.public_url) AS public_url,
    MIN(media.stream_video_id) AS stream_video_id
  FROM video_playback_events event
  INNER JOIN media_assets media
    ON media.id = NULLIF(event.media_asset_id, '')
    OR (
      (event.media_asset_id IS NULL OR event.media_asset_id = '')
      AND event.stream_video_id IS NOT NULL
      AND event.stream_video_id != ''
      AND media.stream_video_id = event.stream_video_id
    )
  WHERE event.site_id IS NOT NULL
    AND event.site_id != ''
    AND media.media_type = 'video'
    AND (event.tracking_source IS NULL OR event.tracking_source = '' OR event.tracking_source = 'native_site_video')
  GROUP BY event.site_id, block_id, media.id, public_page_id
)
INSERT INTO site_video_placements (
  id, site_id, block_id, media_asset_id, canonical_asset_id,
  public_page_id, page_title, page_path, asset_name, asset_public_url,
  stream_video_id, activated_at, deactivated_at, deactivation_reason,
  created_at, updated_at
)
SELECT
  'site_video_placement_' || md5(random()::text || clock_timestamp()::text || history.site_id || history.block_id || history.media_asset_id),
  history.site_id,
  history.block_id,
  history.media_asset_id,
  COALESCE(lineage.canonical_asset_id, history.media_asset_id),
  history.public_page_id,
  NULL,
  history.page_url,
  COALESCE(NULLIF(history.original_filename, ''), NULLIF(history.stored_filename, ''), 'Video histórico'),
  history.public_url,
  history.stream_video_id,
  history.activated_at,
  history.deactivated_at,
  'historical_event',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM resolved_events history
LEFT JOIN site_video_metric_lineage lineage
  ON lineage.site_id = history.site_id
  AND lineage.block_id = history.block_id
  AND lineage.asset_id = history.media_asset_id
WHERE NOT EXISTS (
  SELECT 1
  FROM site_video_placements active
  WHERE active.site_id = history.site_id
    AND active.block_id = history.block_id
    AND active.media_asset_id = history.media_asset_id
    AND active.public_page_id = history.public_page_id
    AND active.deactivated_at IS NULL
);
