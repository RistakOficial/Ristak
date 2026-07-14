CREATE INDEX IF NOT EXISTS idx_media_assets_sites_video_page
  ON media_assets(
    business_id,
    module,
    media_type,
    status,
    (COALESCE(created_at, '1970-01-01 00:00:00')) DESC,
    id DESC
  )
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_media_assets_sites_video_entity_page
  ON media_assets(
    business_id,
    module,
    module_entity_id,
    media_type,
    status,
    (COALESCE(created_at, '1970-01-01 00:00:00')) DESC,
    id DESC
  )
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_video_sessions_site_date_asset
  ON video_playback_sessions(site_id, last_event_at, media_asset_id)
  WHERE site_id IS NOT NULL AND site_id != '';

CREATE INDEX IF NOT EXISTS idx_video_sessions_asset_date
  ON video_playback_sessions(media_asset_id, last_event_at);
