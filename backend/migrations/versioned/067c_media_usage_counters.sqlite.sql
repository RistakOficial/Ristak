CREATE TABLE IF NOT EXISTS media_storage_usage_counters (
  business_id TEXT NOT NULL,
  media_type TEXT NOT NULL,
  module TEXT NOT NULL,
  files_count INTEGER NOT NULL DEFAULT 0,
  used_bytes INTEGER NOT NULL DEFAULT 0,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (business_id, media_type, module)
);

DELETE FROM media_storage_usage_counters;

INSERT INTO media_storage_usage_counters (
  business_id, media_type, module, files_count, used_bytes, updated_at
)
SELECT
  business_id,
  COALESCE(NULLIF(media_type, ''), 'other'),
  COALESCE(NULLIF(module, ''), 'other'),
  COUNT(*),
  COALESCE(SUM(quota_size), 0),
  CURRENT_TIMESTAMP
FROM media_assets
WHERE deleted_at IS NULL
  AND status != 'deleted'
GROUP BY
  business_id,
  COALESCE(NULLIF(media_type, ''), 'other'),
  COALESCE(NULLIF(module, ''), 'other');

UPDATE storage_quotas
SET used_bytes = COALESCE((
      SELECT SUM(used_bytes)
      FROM media_storage_usage_counters AS counters
      WHERE counters.business_id = storage_quotas.business_id
    ), 0),
    updated_at = CURRENT_TIMESTAMP;

DROP TRIGGER IF EXISTS trg_media_usage_counter_insert;
DROP TRIGGER IF EXISTS trg_media_usage_counter_delete;
DROP TRIGGER IF EXISTS trg_media_usage_counter_update;

CREATE TRIGGER trg_media_usage_counter_insert
AFTER INSERT ON media_assets
WHEN NEW.deleted_at IS NULL AND NEW.status != 'deleted'
BEGIN
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
END;

CREATE TRIGGER trg_media_usage_counter_delete
AFTER DELETE ON media_assets
WHEN OLD.deleted_at IS NULL AND OLD.status != 'deleted'
BEGIN
  UPDATE media_storage_usage_counters
  SET files_count = MAX(files_count - 1, 0),
      used_bytes = MAX(used_bytes - COALESCE(OLD.quota_size, 0), 0),
      updated_at = CURRENT_TIMESTAMP
  WHERE business_id = OLD.business_id
    AND media_type = COALESCE(NULLIF(OLD.media_type, ''), 'other')
    AND module = COALESCE(NULLIF(OLD.module, ''), 'other');

  UPDATE storage_quotas
  SET used_bytes = MAX(used_bytes - COALESCE(OLD.quota_size, 0), 0),
      updated_at = CURRENT_TIMESTAMP
  WHERE business_id = OLD.business_id;
END;

CREATE TRIGGER trg_media_usage_counter_update
AFTER UPDATE OF business_id, media_type, module, quota_size, status, deleted_at ON media_assets
BEGIN
  UPDATE media_storage_usage_counters
  SET files_count = MAX(files_count - 1, 0),
      used_bytes = MAX(used_bytes - COALESCE(OLD.quota_size, 0), 0),
      updated_at = CURRENT_TIMESTAMP
  WHERE OLD.deleted_at IS NULL
    AND OLD.status != 'deleted'
    AND business_id = OLD.business_id
    AND media_type = COALESCE(NULLIF(OLD.media_type, ''), 'other')
    AND module = COALESCE(NULLIF(OLD.module, ''), 'other');

  INSERT INTO media_storage_usage_counters (
    business_id, media_type, module, files_count, used_bytes, updated_at
  )
  SELECT
    NEW.business_id,
    COALESCE(NULLIF(NEW.media_type, ''), 'other'),
    COALESCE(NULLIF(NEW.module, ''), 'other'),
    1,
    COALESCE(NEW.quota_size, 0),
    CURRENT_TIMESTAMP
  WHERE NEW.deleted_at IS NULL AND NEW.status != 'deleted'
  ON CONFLICT (business_id, media_type, module) DO UPDATE SET
    files_count = media_storage_usage_counters.files_count + 1,
    used_bytes = media_storage_usage_counters.used_bytes + COALESCE(NEW.quota_size, 0),
    updated_at = CURRENT_TIMESTAMP;

  UPDATE storage_quotas
  SET used_bytes = MAX(used_bytes - CASE
        WHEN OLD.deleted_at IS NULL AND OLD.status != 'deleted' THEN COALESCE(OLD.quota_size, 0)
        ELSE 0
      END, 0) + CASE
        WHEN NEW.business_id = OLD.business_id
          AND NEW.deleted_at IS NULL
          AND NEW.status != 'deleted'
          THEN COALESCE(NEW.quota_size, 0)
        ELSE 0
      END,
      updated_at = CURRENT_TIMESTAMP
  WHERE business_id = OLD.business_id;

  UPDATE storage_quotas
  SET used_bytes = used_bytes + CASE
        WHEN NEW.deleted_at IS NULL AND NEW.status != 'deleted' THEN COALESCE(NEW.quota_size, 0)
        ELSE 0
      END,
      updated_at = CURRENT_TIMESTAMP
  WHERE NEW.business_id != OLD.business_id
    AND business_id = NEW.business_id;
END;
