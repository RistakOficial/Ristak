-- La cuenta administrada de Bunny incluye exactamente 1 GB. Los archivos
-- existentes se conservan; si ya superan el límite, sólo se bloquean cargas
-- nuevas hasta liberar espacio o conectar una cuenta Bunny propia.

UPDATE storage_settings
SET default_storage_quota_gb = 1,
    updated_at = CURRENT_TIMESTAMP
WHERE id = 1;

UPDATE storage_quotas
SET quota_gb = 1,
    quota_bytes = 1073741824,
    extra_quota_gb = 0,
    updated_at = CURRENT_TIMESTAMP;

CREATE TABLE IF NOT EXISTS media_quota_reservations (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL DEFAULT 'default',
  quota_size BIGINT NOT NULL DEFAULT 0,
  expires_at_ms BIGINT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_media_quota_reservations_business_expiry
ON media_quota_reservations(business_id, expires_at_ms);
