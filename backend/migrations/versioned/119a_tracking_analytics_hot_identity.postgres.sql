-- Estado durable y membresias angostas para mantener COUNT DISTINCT por
-- predecessor/successor. El historico 113 conserva facts/presence; 119 solo
-- recompila el grid de rangos con el algoritmo nuevo.
ALTER TABLE tracking_analytics_projection_state
  ADD COLUMN IF NOT EXISTS range_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (range_status IN ('pending', 'compiling_ranges', 'ready'));
ALTER TABLE tracking_analytics_projection_state
  ADD COLUMN IF NOT EXISTS range_compile_cursor TEXT;
ALTER TABLE tracking_analytics_projection_state
  ADD COLUMN IF NOT EXISTS range_backfill_complete BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS tracking_analytics_identity_day (
  entity_type TEXT NOT NULL CHECK (entity_type IN ('visitor', 'session', 'contact')),
  identity_key TEXT NOT NULL,
  business_date DATE NOT NULL,
  ref_count BIGINT NOT NULL CHECK (ref_count > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (entity_type, identity_key, business_date)
);

CREATE TABLE IF NOT EXISTS tracking_analytics_facet_identity_day (
  facet_type TEXT NOT NULL,
  facet_value TEXT NOT NULL,
  visitor_key TEXT NOT NULL,
  business_date DATE NOT NULL,
  ref_count BIGINT NOT NULL CHECK (ref_count > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (facet_type, facet_value, visitor_key, business_date)
);

CREATE TABLE IF NOT EXISTS tracking_analytics_visitor_session_day (
  visitor_key TEXT NOT NULL,
  business_date DATE NOT NULL,
  session_key TEXT NOT NULL,
  ref_count BIGINT NOT NULL CHECK (ref_count > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (visitor_key, business_date, session_key)
);
CREATE INDEX IF NOT EXISTS idx_tracking_analytics_visitor_session_tail
  ON tracking_analytics_visitor_session_day(visitor_key, session_key, business_date);

CREATE TABLE IF NOT EXISTS tracking_analytics_returning_point (
  visitor_key TEXT NOT NULL,
  start_boundary DATE NOT NULL,
  occurrence_date DATE NOT NULL,
  range_delta BIGINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (visitor_key, start_boundary, occurrence_date)
);

CREATE TABLE IF NOT EXISTS tracking_analytics_returning_dirty_queue (
  visitor_key TEXT PRIMARY KEY,
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  enqueued_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_tracking_analytics_returning_dirty_order
  ON tracking_analytics_returning_dirty_queue(enqueued_at, visitor_key);

UPDATE tracking_analytics_event_fact
SET projection_version = 3
WHERE projection_version != 3;

UPDATE tracking_analytics_projection_state
SET projection_version = 3,
    status = 'backfilling',
    range_status = 'pending',
    range_compile_cursor = NULL,
    range_backfill_complete = FALSE,
    last_error = NULL,
    updated_at = CURRENT_TIMESTAMP
WHERE singleton_id = 1;
