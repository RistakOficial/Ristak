DROP TRIGGER IF EXISTS trg_media_stream_video_insert;
DROP TRIGGER IF EXISTS trg_media_stream_video_update;

CREATE TRIGGER trg_media_stream_video_insert
AFTER INSERT ON media_assets
WHEN json_valid(NEW.metadata_json)
BEGIN
  UPDATE media_assets
  -- No cambiamos module dentro de un AFTER INSERT. Hacer otro UPDATE aqui
  -- dispara el contador de uso y, segun el orden de triggers de SQLite, puede
  -- contabilizar el mismo asset una vez en el modulo viejo y otra en el nuevo.
  SET stream_video_id = NULLIF(json_extract(NEW.metadata_json, '$.stream.videoId'), '')
  WHERE id = NEW.id;
END;

CREATE TRIGGER trg_media_stream_video_update
AFTER UPDATE OF metadata_json ON media_assets
WHEN json_valid(NEW.metadata_json)
BEGIN
  UPDATE media_assets
  SET stream_video_id = NULLIF(json_extract(NEW.metadata_json, '$.stream.videoId'), ''),
      module = CASE
        WHEN json_extract(NEW.metadata_json, '$.stream.source.module') IN ('sites', 'forms')
          THEN json_extract(NEW.metadata_json, '$.stream.source.module')
        ELSE module
      END
  WHERE id = NEW.id;
END;

UPDATE media_assets
SET stream_video_id = NULLIF(json_extract(metadata_json, '$.stream.videoId'), ''),
    module = CASE
      WHEN json_extract(metadata_json, '$.stream.source.module') IN ('sites', 'forms')
        THEN json_extract(metadata_json, '$.stream.source.module')
      ELSE module
    END
WHERE stream_video_id IS NULL
  AND json_valid(metadata_json)
  AND metadata_json LIKE '%"videoId"%';

CREATE INDEX IF NOT EXISTS idx_media_assets_stream_video_scope
  ON media_assets (business_id, module, stream_video_id)
  WHERE stream_video_id IS NOT NULL
    AND media_type = 'video'
    AND deleted_at IS NULL
    AND status != 'deleted';
