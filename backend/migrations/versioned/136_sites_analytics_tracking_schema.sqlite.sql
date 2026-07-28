-- SQLite no admite ADD COLUMN IF NOT EXISTS. Antes de evaluar el marcador del
-- bootstrap, sitesAnalyticsSchemaCompatibility agrega únicamente las columnas
-- faltantes. Estas lecturas hacen fallar cerrado la migración si ese contrato no
-- quedó completo.
SELECT event_id, client_started_at, timestamp_adjusted
FROM sessions
LIMIT 0;

SELECT
  event_sequence,
  ingestion_version,
  payload_hash,
  tracking_source,
  context_verified,
  event_time_quality,
  watch_from_seconds,
  watch_to_seconds,
  client_event_at
FROM video_playback_events
LIMIT 0;

CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_event_id_unique
  ON sessions(event_id)
  WHERE event_id IS NOT NULL AND event_id != '';

CREATE INDEX IF NOT EXISTS idx_sessions_site_tracking_started
  ON sessions(site_id, tracking_source, event_name, started_at);

CREATE INDEX IF NOT EXISTS idx_sessions_form_tracking_started
  ON sessions(form_site_id, tracking_source, event_name, started_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_video_events_playback_sequence
  ON video_playback_events(playback_id, event_sequence)
  WHERE event_sequence IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_video_events_asset_time_type
  ON video_playback_events(media_asset_id, event_at, event_name, playback_id);

CREATE INDEX IF NOT EXISTS idx_video_events_site_time_type
  ON video_playback_events(site_id, event_at, event_name, media_asset_id, playback_id);

CREATE INDEX IF NOT EXISTS idx_video_events_playback_type_time
  ON video_playback_events(playback_id, event_name, event_at, id);

CREATE INDEX IF NOT EXISTS idx_video_events_visitor_time
  ON video_playback_events(visitor_id, event_at, playback_id);
