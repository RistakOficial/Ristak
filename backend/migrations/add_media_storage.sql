-- Centralized multimedia storage metadata for Bunny.net.
-- Safe for existing PostgreSQL installs: creates additive tables only.

CREATE TABLE IF NOT EXISTS media_assets (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL DEFAULT 'default',
  user_id TEXT,
  original_filename TEXT,
  stored_filename TEXT,
  bunny_path TEXT,
  public_url TEXT,
  private_url TEXT,
  mime_type TEXT,
  media_type TEXT,
  extension TEXT,
  size_original BIGINT DEFAULT 0,
  size_processed BIGINT DEFAULT 0,
  quota_size BIGINT DEFAULT 0,
  width INTEGER,
  height INTEGER,
  duration DOUBLE PRECISION,
  status TEXT DEFAULT 'ready',
  storage_provider TEXT DEFAULT 'bunny',
  storage_zone TEXT,
  cdn_base_url TEXT,
  module TEXT DEFAULT 'other',
  module_entity_id TEXT,
  is_public INTEGER DEFAULT 0,
  metadata_json TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_media_assets_business_status ON media_assets(business_id, status);
CREATE INDEX IF NOT EXISTS idx_media_assets_module ON media_assets(module, module_entity_id);
CREATE INDEX IF NOT EXISTS idx_media_assets_type ON media_assets(media_type);
CREATE INDEX IF NOT EXISTS idx_media_assets_deleted ON media_assets(deleted_at);
CREATE INDEX IF NOT EXISTS idx_media_assets_provider_path ON media_assets(storage_provider, bunny_path);

CREATE TABLE IF NOT EXISTS storage_quotas (
  business_id TEXT PRIMARY KEY,
  quota_gb DOUBLE PRECISION DEFAULT 5,
  quota_bytes BIGINT DEFAULT 5368709120,
  used_bytes BIGINT DEFAULT 0,
  extra_quota_gb DOUBLE PRECISION DEFAULT 0,
  storage_enabled INTEGER DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO storage_quotas (business_id, quota_gb, quota_bytes, used_bytes, extra_quota_gb, storage_enabled)
VALUES ('default', 5, 5368709120, 0, 0, 1)
ON CONFLICT (business_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS storage_settings (
  id INTEGER PRIMARY KEY,
  storage_provider TEXT DEFAULT 'bunny',
  storage_enabled INTEGER DEFAULT 1,
  default_storage_quota_gb DOUBLE PRECISION DEFAULT 5,
  compression_enabled INTEGER DEFAULT 1,
  image_optimization_enabled INTEGER DEFAULT 1,
  video_compression_enabled INTEGER DEFAULT 1,
  audio_compression_enabled INTEGER DEFAULT 1,
  bunny_storage_zone TEXT,
  bunny_storage_region TEXT,
  bunny_cdn_base_url TEXT,
  bunny_stream_library_id TEXT,
  max_image_size_mb INTEGER DEFAULT 25,
  max_video_size_mb INTEGER DEFAULT 512,
  max_audio_size_mb INTEGER DEFAULT 100,
  max_document_size_mb INTEGER DEFAULT 50,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO storage_settings (
  id,
  storage_provider,
  storage_enabled,
  default_storage_quota_gb,
  compression_enabled,
  image_optimization_enabled,
  video_compression_enabled,
  audio_compression_enabled,
  max_image_size_mb,
  max_video_size_mb,
  max_audio_size_mb,
  max_document_size_mb
)
VALUES (1, 'bunny', 1, 5, 1, 1, 1, 1, 25, 512, 100, 50)
ON CONFLICT (id) DO NOTHING;

