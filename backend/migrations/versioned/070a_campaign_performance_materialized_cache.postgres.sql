CREATE TABLE IF NOT EXISTS campaign_performance_revision (
  id SMALLINT PRIMARY KEY CHECK (id = 1),
  core_revision BIGINT NOT NULL DEFAULT 0,
  visitor_revision BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO campaign_performance_revision (id, core_revision, visitor_revision)
VALUES (1, 0, 0)
ON CONFLICT (id) DO NOTHING;

-- Las sesiones públicas son append-heavy. Una secuencia evita serializar cada
-- INSERT contra una sola fila caliente de revisión.
CREATE SEQUENCE IF NOT EXISTS campaign_performance_visitor_revision_seq AS BIGINT;

CREATE TABLE IF NOT EXISTS campaign_performance_cache_entries (
  account_scope TEXT NOT NULL,
  cache_key TEXT NOT NULL,
  source_revision TEXT NOT NULL,
  level TEXT NOT NULL,
  total_items BIGINT NOT NULL DEFAULT 0,
  built_at TIMESTAMPTZ NOT NULL,
  last_accessed_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (account_scope, cache_key, source_revision)
);

CREATE TABLE IF NOT EXISTS campaign_performance_cache_rows (
  account_scope TEXT NOT NULL,
  cache_key TEXT NOT NULL,
  source_revision TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  name TEXT,
  spend DOUBLE PRECISION NOT NULL DEFAULT 0,
  reach DOUBLE PRECISION NOT NULL DEFAULT 0,
  clicks DOUBLE PRECISION NOT NULL DEFAULT 0,
  cpc DOUBLE PRECISION NOT NULL DEFAULT 0,
  cpm DOUBLE PRECISION NOT NULL DEFAULT 0,
  revenue DOUBLE PRECISION NOT NULL DEFAULT 0,
  roas DOUBLE PRECISION NOT NULL DEFAULT 0,
  sales BIGINT NOT NULL DEFAULT 0,
  leads BIGINT NOT NULL DEFAULT 0,
  appointments BIGINT NOT NULL DEFAULT 0,
  attendances BIGINT NOT NULL DEFAULT 0,
  visitors BIGINT NOT NULL DEFAULT 0,
  last_active_date DATE,
  payload_json TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
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

CREATE OR REPLACE FUNCTION ristak_bump_campaign_performance_revision()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE campaign_performance_revision
  SET core_revision = core_revision + 1, updated_at = CURRENT_TIMESTAMP
  WHERE id = 1;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ristak_bump_campaign_performance_visitor_revision()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM nextval('campaign_performance_visitor_revision_seq');
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_campaign_perf_meta_ads ON meta_ads;
DROP TRIGGER IF EXISTS trg_campaign_perf_meta_ads_mutation ON meta_ads;
DROP TRIGGER IF EXISTS trg_campaign_perf_meta_ads_update ON meta_ads;
DROP TRIGGER IF EXISTS trg_campaign_perf_contacts ON contacts;
DROP TRIGGER IF EXISTS trg_campaign_perf_contacts_mutation ON contacts;
DROP TRIGGER IF EXISTS trg_campaign_perf_contacts_update ON contacts;
DROP TRIGGER IF EXISTS trg_campaign_perf_payments ON payments;
DROP TRIGGER IF EXISTS trg_campaign_perf_payments_mutation ON payments;
DROP TRIGGER IF EXISTS trg_campaign_perf_payments_update ON payments;
DROP TRIGGER IF EXISTS trg_campaign_perf_appointments ON appointments;
DROP TRIGGER IF EXISTS trg_campaign_perf_appointments_mutation ON appointments;
DROP TRIGGER IF EXISTS trg_campaign_perf_appointments_update ON appointments;
DROP TRIGGER IF EXISTS trg_campaign_perf_attendance ON appointment_attendance_signals;
DROP TRIGGER IF EXISTS trg_campaign_perf_attendance_mutation ON appointment_attendance_signals;
DROP TRIGGER IF EXISTS trg_campaign_perf_attendance_update ON appointment_attendance_signals;
DROP TRIGGER IF EXISTS trg_campaign_perf_sessions_mutation ON sessions;
DROP TRIGGER IF EXISTS trg_campaign_perf_sessions_update ON sessions;

CREATE TRIGGER trg_campaign_perf_meta_ads_mutation
AFTER INSERT OR DELETE ON meta_ads
FOR EACH STATEMENT EXECUTE FUNCTION ristak_bump_campaign_performance_revision();
CREATE TRIGGER trg_campaign_perf_meta_ads_update
AFTER UPDATE OF
  date, campaign_id, campaign_name, adset_id, adset_name, ad_id, ad_name,
  creative_id, creative_type, creative_thumbnail_url, creative_image_url,
  creative_video_id, creative_video_url, creative_preview_url,
  spend, reach, clicks, cpc, cpm
ON meta_ads
FOR EACH STATEMENT EXECUTE FUNCTION ristak_bump_campaign_performance_revision();

CREATE TRIGGER trg_campaign_perf_contacts_mutation
AFTER INSERT OR DELETE ON contacts
FOR EACH STATEMENT EXECUTE FUNCTION ristak_bump_campaign_performance_revision();
CREATE TRIGGER trg_campaign_perf_contacts_update
AFTER UPDATE OF
  attribution_ad_id, created_at, purchases_count, total_paid, appointment_date,
  full_name, email, phone
ON contacts
FOR EACH STATEMENT EXECUTE FUNCTION ristak_bump_campaign_performance_revision();

CREATE TRIGGER trg_campaign_perf_payments_mutation
AFTER INSERT OR DELETE ON payments
FOR EACH STATEMENT EXECUTE FUNCTION ristak_bump_campaign_performance_revision();
CREATE TRIGGER trg_campaign_perf_payments_update
AFTER UPDATE OF contact_id, status, amount, payment_mode ON payments
FOR EACH STATEMENT EXECUTE FUNCTION ristak_bump_campaign_performance_revision();

CREATE TRIGGER trg_campaign_perf_appointments_mutation
AFTER INSERT OR DELETE ON appointments
FOR EACH STATEMENT EXECUTE FUNCTION ristak_bump_campaign_performance_revision();
CREATE TRIGGER trg_campaign_perf_appointments_update
AFTER UPDATE OF contact_id, calendar_id, status, appointment_status ON appointments
FOR EACH STATEMENT EXECUTE FUNCTION ristak_bump_campaign_performance_revision();

CREATE TRIGGER trg_campaign_perf_attendance_mutation
AFTER INSERT OR DELETE ON appointment_attendance_signals
FOR EACH STATEMENT EXECUTE FUNCTION ristak_bump_campaign_performance_revision();
CREATE TRIGGER trg_campaign_perf_attendance_update
AFTER UPDATE OF contact_id ON appointment_attendance_signals
FOR EACH STATEMENT EXECUTE FUNCTION ristak_bump_campaign_performance_revision();

CREATE TRIGGER trg_campaign_perf_sessions_mutation
AFTER INSERT OR DELETE ON sessions
FOR EACH STATEMENT EXECUTE FUNCTION ristak_bump_campaign_performance_visitor_revision();
CREATE TRIGGER trg_campaign_perf_sessions_update
AFTER UPDATE OF campaign_id, adset_id, ad_id, started_at, contact_id, visitor_id, session_id ON sessions
FOR EACH STATEMENT EXECUTE FUNCTION ristak_bump_campaign_performance_visitor_revision();
