CREATE TABLE IF NOT EXISTS media_folder_usage_counters (
  business_id TEXT NOT NULL,
  folder_path TEXT NOT NULL,
  media_type TEXT NOT NULL,
  module TEXT NOT NULL,
  status TEXT NOT NULL,
  files_count BIGINT NOT NULL DEFAULT 0,
  used_bytes BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (business_id, folder_path, media_type, module, status)
);

-- Ledger exclusivamente de bootstrap: hace idempotente el backfill mientras el
-- trigger absorbe escrituras concurrentes. 067gc lo elimina al terminar.
CREATE TABLE IF NOT EXISTS media_folder_usage_ledger (
  asset_id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  folder_path TEXT NOT NULL,
  media_type TEXT NOT NULL,
  module TEXT NOT NULL,
  status TEXT NOT NULL,
  used_bytes BIGINT NOT NULL DEFAULT 0
);

CREATE OR REPLACE FUNCTION ristak_sync_media_folder_counter_bootstrap()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  previous media_folder_usage_ledger%ROWTYPE;
  claimed_rows INTEGER := 0;
  target_id TEXT := CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END;
BEGIN
  SELECT * INTO previous
  FROM media_folder_usage_ledger
  WHERE asset_id = target_id
  FOR UPDATE;

  IF TG_OP = 'UPDATE' AND FOUND
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

  IF FOUND THEN
    UPDATE media_folder_usage_counters
    SET files_count = GREATEST(files_count - 1, 0),
        used_bytes = GREATEST(used_bytes - previous.used_bytes, 0),
        updated_at = CURRENT_TIMESTAMP
    WHERE business_id = previous.business_id
      AND folder_path = previous.folder_path
      AND media_type = previous.media_type
      AND module = previous.module
      AND status = previous.status;

    DELETE FROM media_folder_usage_counters
    WHERE business_id = previous.business_id
      AND folder_path = previous.folder_path
      AND media_type = previous.media_type
      AND module = previous.module
      AND status = previous.status
      AND files_count = 0;
    DELETE FROM media_folder_usage_ledger WHERE asset_id = target_id;
  END IF;

  IF TG_OP != 'DELETE' AND NEW.deleted_at IS NULL AND NEW.status != 'deleted' THEN
    INSERT INTO media_folder_usage_ledger (
      asset_id, business_id, folder_path, media_type, module, status, used_bytes
    ) VALUES (
      NEW.id,
      NEW.business_id,
      COALESCE(NEW.folder_path, ''),
      COALESCE(NULLIF(NEW.media_type, ''), 'other'),
      COALESCE(NULLIF(NEW.module, ''), 'other'),
      COALESCE(NULLIF(NEW.status, ''), 'ready'),
      COALESCE(NEW.quota_size, 0)
    )
    ON CONFLICT (asset_id) DO NOTHING;
    GET DIAGNOSTICS claimed_rows = ROW_COUNT;

    IF claimed_rows = 1 THEN
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
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_media_folder_counter_bootstrap ON media_assets;
CREATE TRIGGER trg_media_folder_counter_bootstrap
AFTER INSERT OR UPDATE OR DELETE ON media_assets
FOR EACH ROW EXECUTE FUNCTION ristak_sync_media_folder_counter_bootstrap();
