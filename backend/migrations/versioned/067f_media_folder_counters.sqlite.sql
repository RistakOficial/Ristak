CREATE TABLE IF NOT EXISTS media_folder_usage_counters (
  business_id TEXT NOT NULL,
  folder_path TEXT NOT NULL,
  media_type TEXT NOT NULL,
  module TEXT NOT NULL,
  status TEXT NOT NULL,
  files_count INTEGER NOT NULL DEFAULT 0,
  used_bytes INTEGER NOT NULL DEFAULT 0,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (business_id, folder_path, media_type, module, status)
);

DELETE FROM media_folder_usage_counters;

INSERT INTO media_folder_usage_counters (
  business_id, folder_path, media_type, module, status,
  files_count, used_bytes, updated_at
)
SELECT
  business_id,
  COALESCE(folder_path, ''),
  COALESCE(NULLIF(media_type, ''), 'other'),
  COALESCE(NULLIF(module, ''), 'other'),
  COALESCE(NULLIF(status, ''), 'ready'),
  COUNT(*),
  COALESCE(SUM(quota_size), 0),
  CURRENT_TIMESTAMP
FROM media_assets
WHERE deleted_at IS NULL
  AND status != 'deleted'
GROUP BY
  business_id,
  COALESCE(folder_path, ''),
  COALESCE(NULLIF(media_type, ''), 'other'),
  COALESCE(NULLIF(module, ''), 'other'),
  COALESCE(NULLIF(status, ''), 'ready');

DROP TRIGGER IF EXISTS trg_media_folder_counter_insert;
DROP TRIGGER IF EXISTS trg_media_folder_counter_delete;
DROP TRIGGER IF EXISTS trg_media_folder_counter_update;

CREATE TRIGGER trg_media_folder_counter_insert
AFTER INSERT ON media_assets
WHEN NEW.deleted_at IS NULL AND NEW.status != 'deleted'
BEGIN
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
END;

CREATE TRIGGER trg_media_folder_counter_delete
AFTER DELETE ON media_assets
WHEN OLD.deleted_at IS NULL AND OLD.status != 'deleted'
BEGIN
  UPDATE media_folder_usage_counters
  SET files_count = MAX(files_count - 1, 0),
      used_bytes = MAX(used_bytes - COALESCE(OLD.quota_size, 0), 0),
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
END;

CREATE TRIGGER trg_media_folder_counter_update
AFTER UPDATE OF business_id, folder_path, media_type, module, quota_size, status, deleted_at ON media_assets
BEGIN
  UPDATE media_folder_usage_counters
  SET files_count = MAX(files_count - 1, 0),
      used_bytes = MAX(used_bytes - COALESCE(OLD.quota_size, 0), 0),
      updated_at = CURRENT_TIMESTAMP
  WHERE OLD.deleted_at IS NULL
    AND OLD.status != 'deleted'
    AND business_id = OLD.business_id
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

  INSERT INTO media_folder_usage_counters (
    business_id, folder_path, media_type, module, status,
    files_count, used_bytes, updated_at
  )
  SELECT
    NEW.business_id,
    COALESCE(NEW.folder_path, ''),
    COALESCE(NULLIF(NEW.media_type, ''), 'other'),
    COALESCE(NULLIF(NEW.module, ''), 'other'),
    COALESCE(NULLIF(NEW.status, ''), 'ready'),
    1,
    COALESCE(NEW.quota_size, 0),
    CURRENT_TIMESTAMP
  WHERE NEW.deleted_at IS NULL AND NEW.status != 'deleted'
  ON CONFLICT (business_id, folder_path, media_type, module, status) DO UPDATE SET
    files_count = media_folder_usage_counters.files_count + 1,
    used_bytes = media_folder_usage_counters.used_bytes + COALESCE(NEW.quota_size, 0),
    updated_at = CURRENT_TIMESTAMP;
END;
