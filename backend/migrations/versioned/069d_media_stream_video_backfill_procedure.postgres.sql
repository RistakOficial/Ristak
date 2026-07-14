CREATE OR REPLACE PROCEDURE ristak_backfill_media_stream_video_ids(batch_size INTEGER DEFAULT 2000)
LANGUAGE plpgsql
AS $$
DECLARE
  cursor_id TEXT := '';
  batch_last_id TEXT := '';
  batch_rows INTEGER := 0;
BEGIN
  LOOP
    WITH batch AS (
      SELECT id
      FROM media_assets
      WHERE id > cursor_id
        AND stream_video_id IS NULL
        AND ristak_media_stream_video_id_from_metadata(metadata_json) IS NOT NULL
      ORDER BY id
      LIMIT GREATEST(1, LEAST(batch_size, 10000))
      -- Esperamos locks puntuales para no saltar IDs legacy para siempre.
      FOR UPDATE
    ), updated AS (
      UPDATE media_assets AS target
      SET stream_video_id = ristak_media_stream_video_id_from_metadata(target.metadata_json),
          module = COALESCE(ristak_media_stream_module_from_metadata(target.metadata_json), target.module)
      FROM batch
      WHERE target.id = batch.id
      RETURNING target.id
    )
    SELECT COALESCE(MAX(batch.id), cursor_id), COUNT(*)
    INTO batch_last_id, batch_rows
    FROM batch;

    COMMIT;
    EXIT WHEN batch_rows = 0;
    cursor_id := batch_last_id;
    PERFORM pg_sleep(0.01);
  END LOOP;
END;
$$;
