CREATE TABLE IF NOT EXISTS media_storage_usage_counters (
  business_id TEXT NOT NULL,
  media_type TEXT NOT NULL,
  module TEXT NOT NULL,
  files_count BIGINT NOT NULL DEFAULT 0,
  used_bytes BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (business_id, media_type, module)
);

-- El ledger hace idempotente el backfill por lotes y también permite que el
-- trigger atienda escrituras concurrentes sin sumar dos veces un asset viejo.
CREATE TABLE IF NOT EXISTS media_storage_usage_ledger (
  asset_id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  media_type TEXT NOT NULL,
  module TEXT NOT NULL,
  used_bytes BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_media_storage_usage_ledger_business
  ON media_storage_usage_ledger (business_id);

CREATE OR REPLACE FUNCTION ristak_sync_media_usage_counter()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  previous media_storage_usage_ledger%ROWTYPE;
  claimed_rows INTEGER := 0;
  target_id TEXT := CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END;
BEGIN
  SELECT * INTO previous
  FROM media_storage_usage_ledger
  WHERE asset_id = target_id
  FOR UPDATE;

  IF TG_OP = 'UPDATE' AND FOUND
    AND OLD.business_id IS NOT DISTINCT FROM NEW.business_id
    AND OLD.media_type IS NOT DISTINCT FROM NEW.media_type
    AND OLD.module IS NOT DISTINCT FROM NEW.module
    AND OLD.quota_size IS NOT DISTINCT FROM NEW.quota_size
    AND OLD.status IS NOT DISTINCT FROM NEW.status
    AND OLD.deleted_at IS NOT DISTINCT FROM NEW.deleted_at
  THEN
    RETURN NEW;
  END IF;

  IF FOUND THEN
    UPDATE media_storage_usage_counters
    SET files_count = GREATEST(files_count - 1, 0),
        used_bytes = GREATEST(used_bytes - previous.used_bytes, 0),
        updated_at = CURRENT_TIMESTAMP
    WHERE business_id = previous.business_id
      AND media_type = previous.media_type
      AND module = previous.module;

    UPDATE storage_quotas
    SET used_bytes = GREATEST(used_bytes - previous.used_bytes, 0),
        updated_at = CURRENT_TIMESTAMP
    WHERE business_id = previous.business_id;

    DELETE FROM media_storage_usage_ledger WHERE asset_id = target_id;
  END IF;

  IF TG_OP != 'DELETE' AND NEW.deleted_at IS NULL AND NEW.status != 'deleted' THEN
    INSERT INTO media_storage_usage_ledger (
      asset_id, business_id, media_type, module, used_bytes, updated_at
    ) VALUES (
      NEW.id,
      NEW.business_id,
      COALESCE(NULLIF(NEW.media_type, ''), 'other'),
      COALESCE(NULLIF(NEW.module, ''), 'other'),
      COALESCE(NEW.quota_size, 0),
      CURRENT_TIMESTAMP
    )
    ON CONFLICT (asset_id) DO NOTHING;
    GET DIAGNOSTICS claimed_rows = ROW_COUNT;

    IF claimed_rows = 1 THEN
      INSERT INTO media_storage_usage_counters (
        business_id, media_type, module, files_count, used_bytes, updated_at
      ) VALUES (
        NEW.business_id,
        COALESCE(NULLIF(NEW.media_type, ''), 'other'),
        COALESCE(NULLIF(NEW.module, ''), 'other'),
        1,
        COALESCE(NEW.quota_size, 0),
        CURRENT_TIMESTAMP
      )
      ON CONFLICT (business_id, media_type, module) DO UPDATE SET
        files_count = media_storage_usage_counters.files_count + 1,
        used_bytes = media_storage_usage_counters.used_bytes + COALESCE(NEW.quota_size, 0),
        updated_at = CURRENT_TIMESTAMP;

      UPDATE storage_quotas
      SET used_bytes = used_bytes + COALESCE(NEW.quota_size, 0),
          updated_at = CURRENT_TIMESTAMP
      WHERE business_id = NEW.business_id;
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_media_usage_counter ON media_assets;

CREATE TRIGGER trg_media_usage_counter
AFTER INSERT OR UPDATE OR DELETE ON media_assets
FOR EACH ROW EXECUTE FUNCTION ristak_sync_media_usage_counter();
