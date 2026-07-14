CREATE TABLE IF NOT EXISTS campaign_performance_revision (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  core_revision INTEGER NOT NULL DEFAULT 0,
  visitor_revision INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO campaign_performance_revision (id, core_revision, visitor_revision)
VALUES (1, 0, 0);

CREATE TABLE IF NOT EXISTS campaign_performance_cache_entries (
  account_scope TEXT NOT NULL,
  cache_key TEXT NOT NULL,
  source_revision TEXT NOT NULL,
  level TEXT NOT NULL,
  total_items INTEGER NOT NULL DEFAULT 0,
  built_at TEXT NOT NULL,
  last_accessed_at TEXT NOT NULL,
  PRIMARY KEY (account_scope, cache_key, source_revision)
);

CREATE TABLE IF NOT EXISTS campaign_performance_cache_rows (
  account_scope TEXT NOT NULL,
  cache_key TEXT NOT NULL,
  source_revision TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  name TEXT,
  spend REAL NOT NULL DEFAULT 0,
  reach REAL NOT NULL DEFAULT 0,
  clicks REAL NOT NULL DEFAULT 0,
  cpc REAL NOT NULL DEFAULT 0,
  cpm REAL NOT NULL DEFAULT 0,
  revenue REAL NOT NULL DEFAULT 0,
  roas REAL NOT NULL DEFAULT 0,
  sales INTEGER NOT NULL DEFAULT 0,
  leads INTEGER NOT NULL DEFAULT 0,
  appointments INTEGER NOT NULL DEFAULT 0,
  attendances INTEGER NOT NULL DEFAULT 0,
  visitors INTEGER NOT NULL DEFAULT 0,
  last_active_date TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_scope, cache_key, source_revision, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_campaign_perf_cache_entry_lru
  ON campaign_performance_cache_entries(account_scope, last_accessed_at DESC);
CREATE INDEX IF NOT EXISTS idx_campaign_perf_cache_revenue
  ON campaign_performance_cache_rows(account_scope, cache_key, source_revision, revenue DESC, entity_id DESC);
CREATE INDEX IF NOT EXISTS idx_campaign_perf_cache_sales
  ON campaign_performance_cache_rows(account_scope, cache_key, source_revision, sales DESC, entity_id DESC);
CREATE INDEX IF NOT EXISTS idx_campaign_perf_cache_leads
  ON campaign_performance_cache_rows(account_scope, cache_key, source_revision, leads DESC, entity_id DESC);
CREATE INDEX IF NOT EXISTS idx_campaign_perf_cache_appointments
  ON campaign_performance_cache_rows(account_scope, cache_key, source_revision, appointments DESC, entity_id DESC);
CREATE INDEX IF NOT EXISTS idx_campaign_perf_cache_attendances
  ON campaign_performance_cache_rows(account_scope, cache_key, source_revision, attendances DESC, entity_id DESC);
CREATE INDEX IF NOT EXISTS idx_campaign_perf_cache_visitors
  ON campaign_performance_cache_rows(account_scope, cache_key, source_revision, visitors DESC, entity_id DESC);
CREATE INDEX IF NOT EXISTS idx_campaign_perf_cache_roas
  ON campaign_performance_cache_rows(account_scope, cache_key, source_revision, roas DESC, entity_id DESC);

DROP TRIGGER IF EXISTS trg_campaign_perf_meta_ads_insert;
DROP TRIGGER IF EXISTS trg_campaign_perf_meta_ads_update;
DROP TRIGGER IF EXISTS trg_campaign_perf_meta_ads_delete;
DROP TRIGGER IF EXISTS trg_campaign_perf_contacts_insert;
DROP TRIGGER IF EXISTS trg_campaign_perf_contacts_update;
DROP TRIGGER IF EXISTS trg_campaign_perf_contacts_delete;
DROP TRIGGER IF EXISTS trg_campaign_perf_payments_insert;
DROP TRIGGER IF EXISTS trg_campaign_perf_payments_update;
DROP TRIGGER IF EXISTS trg_campaign_perf_payments_delete;
DROP TRIGGER IF EXISTS trg_campaign_perf_appointments_insert;
DROP TRIGGER IF EXISTS trg_campaign_perf_appointments_update;
DROP TRIGGER IF EXISTS trg_campaign_perf_appointments_delete;
DROP TRIGGER IF EXISTS trg_campaign_perf_attendance_insert;
DROP TRIGGER IF EXISTS trg_campaign_perf_attendance_update;
DROP TRIGGER IF EXISTS trg_campaign_perf_attendance_delete;
DROP TRIGGER IF EXISTS trg_campaign_perf_sessions_update;
DROP TRIGGER IF EXISTS trg_campaign_perf_sessions_delete;
DROP TRIGGER IF EXISTS trg_campaign_perf_sessions_insert;

CREATE TRIGGER trg_campaign_perf_meta_ads_insert AFTER INSERT ON meta_ads BEGIN
  UPDATE campaign_performance_revision SET core_revision = core_revision + 1, updated_at = CURRENT_TIMESTAMP WHERE id = 1;
END;
CREATE TRIGGER trg_campaign_perf_meta_ads_update AFTER UPDATE OF
  date, campaign_id, campaign_name, adset_id, adset_name, ad_id, ad_name,
  creative_id, creative_type, creative_thumbnail_url, creative_image_url,
  creative_video_id, creative_video_url, creative_preview_url,
  spend, reach, clicks, cpc, cpm
ON meta_ads BEGIN
  UPDATE campaign_performance_revision SET core_revision = core_revision + 1, updated_at = CURRENT_TIMESTAMP WHERE id = 1;
END;
CREATE TRIGGER trg_campaign_perf_meta_ads_delete AFTER DELETE ON meta_ads BEGIN
  UPDATE campaign_performance_revision SET core_revision = core_revision + 1, updated_at = CURRENT_TIMESTAMP WHERE id = 1;
END;

CREATE TRIGGER trg_campaign_perf_contacts_insert AFTER INSERT ON contacts BEGIN
  UPDATE campaign_performance_revision SET core_revision = core_revision + 1, updated_at = CURRENT_TIMESTAMP WHERE id = 1;
END;
CREATE TRIGGER trg_campaign_perf_contacts_update AFTER UPDATE OF
  attribution_ad_id, created_at, purchases_count, total_paid, appointment_date,
  full_name, email, phone
ON contacts BEGIN
  UPDATE campaign_performance_revision SET core_revision = core_revision + 1, updated_at = CURRENT_TIMESTAMP WHERE id = 1;
END;
CREATE TRIGGER trg_campaign_perf_contacts_delete AFTER DELETE ON contacts BEGIN
  UPDATE campaign_performance_revision SET core_revision = core_revision + 1, updated_at = CURRENT_TIMESTAMP WHERE id = 1;
END;

CREATE TRIGGER trg_campaign_perf_payments_insert AFTER INSERT ON payments BEGIN
  UPDATE campaign_performance_revision SET core_revision = core_revision + 1, updated_at = CURRENT_TIMESTAMP WHERE id = 1;
END;
CREATE TRIGGER trg_campaign_perf_payments_update AFTER UPDATE OF
  contact_id, status, amount, payment_mode
ON payments BEGIN
  UPDATE campaign_performance_revision SET core_revision = core_revision + 1, updated_at = CURRENT_TIMESTAMP WHERE id = 1;
END;
CREATE TRIGGER trg_campaign_perf_payments_delete AFTER DELETE ON payments BEGIN
  UPDATE campaign_performance_revision SET core_revision = core_revision + 1, updated_at = CURRENT_TIMESTAMP WHERE id = 1;
END;

CREATE TRIGGER trg_campaign_perf_appointments_insert AFTER INSERT ON appointments BEGIN
  UPDATE campaign_performance_revision SET core_revision = core_revision + 1, updated_at = CURRENT_TIMESTAMP WHERE id = 1;
END;
CREATE TRIGGER trg_campaign_perf_appointments_update AFTER UPDATE OF
  contact_id, calendar_id, status, appointment_status
ON appointments BEGIN
  UPDATE campaign_performance_revision SET core_revision = core_revision + 1, updated_at = CURRENT_TIMESTAMP WHERE id = 1;
END;
CREATE TRIGGER trg_campaign_perf_appointments_delete AFTER DELETE ON appointments BEGIN
  UPDATE campaign_performance_revision SET core_revision = core_revision + 1, updated_at = CURRENT_TIMESTAMP WHERE id = 1;
END;

CREATE TRIGGER trg_campaign_perf_attendance_insert AFTER INSERT ON appointment_attendance_signals BEGIN
  UPDATE campaign_performance_revision SET core_revision = core_revision + 1, updated_at = CURRENT_TIMESTAMP WHERE id = 1;
END;
CREATE TRIGGER trg_campaign_perf_attendance_update AFTER UPDATE OF contact_id ON appointment_attendance_signals BEGIN
  UPDATE campaign_performance_revision SET core_revision = core_revision + 1, updated_at = CURRENT_TIMESTAMP WHERE id = 1;
END;
CREATE TRIGGER trg_campaign_perf_attendance_delete AFTER DELETE ON appointment_attendance_signals BEGIN
  UPDATE campaign_performance_revision SET core_revision = core_revision + 1, updated_at = CURRENT_TIMESTAMP WHERE id = 1;
END;

CREATE TRIGGER trg_campaign_perf_sessions_update AFTER UPDATE OF
  campaign_id, adset_id, ad_id, started_at, contact_id, visitor_id, session_id
ON sessions BEGIN
  UPDATE campaign_performance_revision SET visitor_revision = visitor_revision + 1, updated_at = CURRENT_TIMESTAMP WHERE id = 1;
END;
CREATE TRIGGER trg_campaign_perf_sessions_delete AFTER DELETE ON sessions BEGIN
  UPDATE campaign_performance_revision SET visitor_revision = visitor_revision + 1, updated_at = CURRENT_TIMESTAMP WHERE id = 1;
END;
CREATE TRIGGER trg_campaign_perf_sessions_insert AFTER INSERT ON sessions BEGIN
  UPDATE campaign_performance_revision SET visitor_revision = visitor_revision + 1, updated_at = CURRENT_TIMESTAMP WHERE id = 1;
END;
