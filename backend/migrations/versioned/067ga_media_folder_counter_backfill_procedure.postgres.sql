CREATE OR REPLACE PROCEDURE ristak_backfill_media_folder_counters(batch_size INTEGER DEFAULT 2000)
LANGUAGE plpgsql
AS $$
DECLARE
  cursor_id TEXT := '';
  batch_last_id TEXT := '';
  batch_rows INTEGER := 0;
BEGIN
  LOOP
    WITH batch AS (
      SELECT
        media.id AS asset_id,
        media.business_id,
        COALESCE(media.folder_path, '') AS folder_path,
        COALESCE(NULLIF(media.media_type, ''), 'other') AS media_type,
        COALESCE(NULLIF(media.module, ''), 'other') AS module,
        COALESCE(NULLIF(media.status, ''), 'ready') AS status,
        COALESCE(media.quota_size, 0) AS used_bytes
      FROM media_assets AS media
      LEFT JOIN media_folder_usage_ledger AS ledger ON ledger.asset_id = media.id
      WHERE media.id > cursor_id
        AND ledger.asset_id IS NULL
        AND media.deleted_at IS NULL
        AND media.status != 'deleted'
      ORDER BY media.id
      LIMIT GREATEST(1, LEAST(batch_size, 10000))
      FOR UPDATE OF media
    ), claimed AS (
      INSERT INTO media_folder_usage_ledger (
        asset_id, business_id, folder_path, media_type, module, status, used_bytes
      )
      SELECT asset_id, business_id, folder_path, media_type, module, status, used_bytes
      FROM batch
      ON CONFLICT (asset_id) DO NOTHING
      RETURNING business_id, folder_path, media_type, module, status, used_bytes
    ), aggregated AS (
      SELECT
        business_id, folder_path, media_type, module, status,
        COUNT(*) AS files_count,
        SUM(used_bytes) AS used_bytes
      FROM claimed
      GROUP BY business_id, folder_path, media_type, module, status
    ), applied AS (
      INSERT INTO media_folder_usage_counters (
        business_id, folder_path, media_type, module, status,
        files_count, used_bytes, updated_at
      )
      SELECT
        business_id, folder_path, media_type, module, status,
        files_count, used_bytes, CURRENT_TIMESTAMP
      FROM aggregated
      ON CONFLICT (business_id, folder_path, media_type, module, status) DO UPDATE SET
        files_count = media_folder_usage_counters.files_count + EXCLUDED.files_count,
        used_bytes = media_folder_usage_counters.used_bytes + EXCLUDED.used_bytes,
        updated_at = CURRENT_TIMESTAMP
      RETURNING 1
    )
    SELECT COALESCE(MAX(batch.asset_id), cursor_id), COUNT(*)
    INTO batch_last_id, batch_rows
    FROM batch;

    COMMIT;
    EXIT WHEN batch_rows = 0;
    cursor_id := batch_last_id;
    PERFORM pg_sleep(0.01);
  END LOOP;
END;
$$;

