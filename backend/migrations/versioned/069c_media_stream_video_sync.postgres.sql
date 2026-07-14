CREATE OR REPLACE FUNCTION ristak_media_stream_video_id_from_metadata(value TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
  IF value IS NULL OR BTRIM(value) = '' THEN RETURN NULL; END IF;
  RETURN NULLIF(value::jsonb #>> '{stream,videoId}', '');
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION ristak_media_stream_module_from_metadata(value TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  source_module TEXT;
BEGIN
  IF value IS NULL OR BTRIM(value) = '' THEN RETURN NULL; END IF;
  source_module := value::jsonb #>> '{stream,source,module}';
  IF source_module IN ('sites', 'forms') THEN RETURN source_module; END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION ristak_sync_media_stream_video_id()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.stream_video_id := ristak_media_stream_video_id_from_metadata(NEW.metadata_json);
  NEW.module := COALESCE(ristak_media_stream_module_from_metadata(NEW.metadata_json), NEW.module);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_media_stream_video_insert ON media_assets;
DROP TRIGGER IF EXISTS trg_media_stream_video_update ON media_assets;

CREATE TRIGGER trg_media_stream_video_insert
BEFORE INSERT ON media_assets
FOR EACH ROW EXECUTE FUNCTION ristak_sync_media_stream_video_id();

CREATE TRIGGER trg_media_stream_video_update
BEFORE UPDATE OF metadata_json ON media_assets
FOR EACH ROW EXECUTE FUNCTION ristak_sync_media_stream_video_id();
