DROP PROCEDURE IF EXISTS ristak_backfill_media_folder_counters(INTEGER);

DROP TRIGGER IF EXISTS trg_media_folder_counter_bootstrap ON media_assets;
DROP TRIGGER IF EXISTS trg_media_folder_counter_insert ON media_assets;
DROP TRIGGER IF EXISTS trg_media_folder_counter_delete ON media_assets;
DROP TRIGGER IF EXISTS trg_media_folder_counter_update ON media_assets;

CREATE OR REPLACE FUNCTION ristak_sync_media_folder_counter()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  old_is_active BOOLEAN := FALSE;
  new_is_active BOOLEAN := FALSE;
BEGIN
  IF TG_OP = 'UPDATE'
    AND OLD.business_id IS NOT DISTINCT FROM NEW.business_id
    AND OLD.folder_path IS NOT DISTINCT FROM NEW.folder_path
    AND OLD.media_type IS NOT DISTINCT FROM NEW.media_type
    AND OLD.module IS NOT DISTINCT FROM NEW.module
    AND OLD.quota_size IS NOT DISTINCT FROM NEW.quota_size
    AND OLD.status IS NOT DISTINCT FROM NEW.status
    AND OLD.deleted_at IS NOT DISTINCT FROM NEW.deleted_at
  THEN
    RETURN NEW;
  END IF;

  IF TG_OP != 'INSERT' THEN
    old_is_active := OLD.deleted_at IS NULL AND OLD.status != 'deleted';
  END IF;
  IF TG_OP != 'DELETE' THEN
    new_is_active := NEW.deleted_at IS NULL AND NEW.status != 'deleted';
  END IF;

  IF old_is_active THEN
    UPDATE media_folder_usage_counters
    SET files_count = GREATEST(files_count - 1, 0),
        used_bytes = GREATEST(used_bytes - COALESCE(OLD.quota_size, 0), 0),
        updated_at = CURRENT_TIMESTAMP
    WHERE business_id = OLD.business_id
      AND folder_path = COALESCE(OLD.folder_path, '')
      AND media_type = COALESCE(NULLIF(OLD.media_type, ''), 'other')
      AND module = COALESCE(NULLIF(OLD.module, ''), 'other')
      AND status = COALESCE(NULLIF(OLD.status, ''), 'ready');

    DELETE FROM media_folder_usage_counters
    WHERE business_id = OLD.business_id
      AND folder_path = COALESCE(OLD.folder_path, '')
      AND media_type = COALESCE(NULLIF(OLD.media_type, ''), 'other')
      AND module = COALESCE(NULLIF(OLD.module, ''), 'other')
      AND status = COALESCE(NULLIF(OLD.status, ''), 'ready')
      AND files_count = 0;
  END IF;

  IF new_is_active THEN
    INSERT INTO media_folder_usage_counters (
      business_id, folder_path, media_type, module, status,
      files_count, used_bytes, updated_at
    ) VALUES (
      NEW.business_id,
      COALESCE(NEW.folder_path, ''),
      COALESCE(NULLIF(NEW.media_type, ''), 'other'),
      COALESCE(NULLIF(NEW.module, ''), 'other'),
      COALESCE(NULLIF(NEW.status, ''), 'ready'),
      1,
      COALESCE(NEW.quota_size, 0),
      CURRENT_TIMESTAMP
    )
    ON CONFLICT (business_id, folder_path, media_type, module, status) DO UPDATE SET
      files_count = media_folder_usage_counters.files_count + 1,
      used_bytes = media_folder_usage_counters.used_bytes + COALESCE(NEW.quota_size, 0),
      updated_at = CURRENT_TIMESTAMP;
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_media_folder_counter_insert
AFTER INSERT ON media_assets
FOR EACH ROW EXECUTE FUNCTION ristak_sync_media_folder_counter();

CREATE TRIGGER trg_media_folder_counter_delete
AFTER DELETE ON media_assets
FOR EACH ROW EXECUTE FUNCTION ristak_sync_media_folder_counter();

CREATE TRIGGER trg_media_folder_counter_update
AFTER UPDATE OF business_id, folder_path, media_type, module, quota_size, status, deleted_at, metadata_json ON media_assets
FOR EACH ROW EXECUTE FUNCTION ristak_sync_media_folder_counter();

DROP FUNCTION IF EXISTS ristak_sync_media_folder_counter_bootstrap();
DROP TABLE IF EXISTS media_folder_usage_ledger;
