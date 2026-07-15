CREATE TABLE IF NOT EXISTS tracking_analytics_projection_state (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  projection_version INTEGER NOT NULL DEFAULT 2,
  account_timezone TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'backfilling'
    CHECK (status IN ('backfilling', 'replaying', 'ready', 'failed')),
  backfill_cursor TEXT,
  backfill_complete INTEGER NOT NULL DEFAULT 0 CHECK (backfill_complete IN (0, 1)),
  last_applied_at TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO tracking_analytics_projection_state (
  singleton_id,
  projection_version,
  account_timezone,
  status,
  backfill_cursor,
  backfill_complete
) VALUES (1, 2, '', 'backfilling', NULL, 0)
ON CONFLICT(singleton_id) DO UPDATE SET
  account_timezone = CASE
    WHEN tracking_analytics_projection_state.projection_version = excluded.projection_version
      THEN tracking_analytics_projection_state.account_timezone
    ELSE ''
  END,
  status = CASE
    WHEN tracking_analytics_projection_state.projection_version = excluded.projection_version
      THEN tracking_analytics_projection_state.status
    ELSE 'backfilling'
  END,
  backfill_cursor = CASE
    WHEN tracking_analytics_projection_state.projection_version = excluded.projection_version
      THEN tracking_analytics_projection_state.backfill_cursor
    ELSE NULL
  END,
  backfill_complete = CASE
    WHEN tracking_analytics_projection_state.projection_version = excluded.projection_version
      THEN tracking_analytics_projection_state.backfill_complete
    ELSE 0
  END,
  projection_version = excluded.projection_version,
  last_error = CASE
    WHEN tracking_analytics_projection_state.projection_version = excluded.projection_version
      THEN tracking_analytics_projection_state.last_error
    ELSE NULL
  END,
  updated_at = CURRENT_TIMESTAMP;

CREATE TABLE IF NOT EXISTS tracking_analytics_change_queue (
  session_row_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  enqueued_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tracking_analytics_change_queue_order
  ON tracking_analytics_change_queue(enqueued_at, session_row_id);

CREATE TABLE IF NOT EXISTS tracking_analytics_dimensions (
  dimension_key TEXT PRIMARY KEY,
  page_value TEXT NOT NULL DEFAULT '',
  traffic_source TEXT NOT NULL DEFAULT '',
  utm_campaign TEXT NOT NULL DEFAULT '',
  utm_medium TEXT NOT NULL DEFAULT '',
  utm_content TEXT NOT NULL DEFAULT '',
  device_type TEXT NOT NULL DEFAULT '',
  browser TEXT NOT NULL DEFAULT '',
  os TEXT NOT NULL DEFAULT '',
  placement TEXT NOT NULL DEFAULT '',
  ad_platform TEXT NOT NULL DEFAULT '',
  campaign_id TEXT NOT NULL DEFAULT '',
  campaign_label TEXT NOT NULL DEFAULT '',
  adset_id TEXT NOT NULL DEFAULT '',
  adset_label TEXT NOT NULL DEFAULT '',
  ad_id TEXT NOT NULL DEFAULT '',
  ad_label TEXT NOT NULL DEFAULT '',
  tracking_source TEXT NOT NULL DEFAULT '',
  channel TEXT NOT NULL DEFAULT '',
  site_type TEXT NOT NULL DEFAULT '',
  site_id TEXT NOT NULL DEFAULT '',
  site_label TEXT NOT NULL DEFAULT '',
  form_site_id TEXT NOT NULL DEFAULT '',
  form_label TEXT NOT NULL DEFAULT '',
  native_conversion_source TEXT NOT NULL DEFAULT '',
  native_conversion_label TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tracking_analytics_dimensions_page
  ON tracking_analytics_dimensions(LOWER(page_value));
CREATE INDEX IF NOT EXISTS idx_tracking_analytics_dimensions_source
  ON tracking_analytics_dimensions(LOWER(traffic_source));
CREATE INDEX IF NOT EXISTS idx_tracking_analytics_dimensions_utm_campaign
  ON tracking_analytics_dimensions(LOWER(utm_campaign));
CREATE INDEX IF NOT EXISTS idx_tracking_analytics_dimensions_utm_medium
  ON tracking_analytics_dimensions(LOWER(utm_medium));
CREATE INDEX IF NOT EXISTS idx_tracking_analytics_dimensions_utm_content
  ON tracking_analytics_dimensions(LOWER(utm_content));
CREATE INDEX IF NOT EXISTS idx_tracking_analytics_dimensions_device
  ON tracking_analytics_dimensions(LOWER(device_type));
CREATE INDEX IF NOT EXISTS idx_tracking_analytics_dimensions_browser
  ON tracking_analytics_dimensions(LOWER(browser));
CREATE INDEX IF NOT EXISTS idx_tracking_analytics_dimensions_os
  ON tracking_analytics_dimensions(LOWER(os));
CREATE INDEX IF NOT EXISTS idx_tracking_analytics_dimensions_placement
  ON tracking_analytics_dimensions(LOWER(placement));
CREATE INDEX IF NOT EXISTS idx_tracking_analytics_dimensions_ad_platform
  ON tracking_analytics_dimensions(LOWER(ad_platform));
CREATE INDEX IF NOT EXISTS idx_tracking_analytics_dimensions_campaign
  ON tracking_analytics_dimensions(LOWER(campaign_id));
CREATE INDEX IF NOT EXISTS idx_tracking_analytics_dimensions_adset
  ON tracking_analytics_dimensions(LOWER(adset_id));
CREATE INDEX IF NOT EXISTS idx_tracking_analytics_dimensions_ad
  ON tracking_analytics_dimensions(LOWER(ad_id));
CREATE INDEX IF NOT EXISTS idx_tracking_analytics_dimensions_tracking_source
  ON tracking_analytics_dimensions(LOWER(tracking_source));
CREATE INDEX IF NOT EXISTS idx_tracking_analytics_dimensions_channel
  ON tracking_analytics_dimensions(LOWER(channel));
CREATE INDEX IF NOT EXISTS idx_tracking_analytics_dimensions_site_type
  ON tracking_analytics_dimensions(LOWER(COALESCE(NULLIF(site_type, ''), 'unknown')));
CREATE INDEX IF NOT EXISTS idx_tracking_analytics_dimensions_site
  ON tracking_analytics_dimensions(LOWER(site_id));
CREATE INDEX IF NOT EXISTS idx_tracking_analytics_dimensions_form
  ON tracking_analytics_dimensions(LOWER(form_site_id));
CREATE INDEX IF NOT EXISTS idx_tracking_analytics_dimensions_native_conversion
  ON tracking_analytics_dimensions(LOWER(native_conversion_source));

CREATE TABLE IF NOT EXISTS tracking_analytics_event_fact (
  session_row_id TEXT PRIMARY KEY,
  projection_version INTEGER NOT NULL,
  business_date TEXT NOT NULL,
  dimension_key TEXT NOT NULL,
  visitor_key TEXT NOT NULL,
  session_key TEXT NOT NULL DEFAULT '',
  contact_key TEXT NOT NULL DEFAULT '',
  event_count INTEGER NOT NULL DEFAULT 1 CHECK (event_count >= 0),
  view_count INTEGER NOT NULL DEFAULT 0 CHECK (view_count >= 0 AND view_count <= event_count),
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tracking_analytics_event_fact_date
  ON tracking_analytics_event_fact(business_date, dimension_key);
CREATE INDEX IF NOT EXISTS idx_tracking_analytics_event_fact_dimension
  ON tracking_analytics_event_fact(dimension_key);

CREATE TABLE IF NOT EXISTS tracking_analytics_presence (
  business_date TEXT NOT NULL,
  dimension_key TEXT NOT NULL,
  visitor_key TEXT NOT NULL,
  session_key TEXT NOT NULL DEFAULT '',
  contact_key TEXT NOT NULL DEFAULT '',
  event_count INTEGER NOT NULL DEFAULT 0 CHECK (event_count >= 0),
  view_count INTEGER NOT NULL DEFAULT 0 CHECK (view_count >= 0 AND view_count <= event_count),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (visitor_key, business_date, dimension_key, session_key, contact_key)
);

CREATE INDEX IF NOT EXISTS idx_tracking_analytics_presence_dimension_date
  ON tracking_analytics_presence(dimension_key, business_date);

CREATE INDEX IF NOT EXISTS idx_tracking_analytics_presence_session
  ON tracking_analytics_presence(session_key);

CREATE TABLE IF NOT EXISTS tracking_analytics_daily_rollup (
  business_date TEXT PRIMARY KEY,
  page_views INTEGER NOT NULL DEFAULT 0,
  anonymous_views INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tracking_analytics_range_delta (
  entity_type TEXT NOT NULL
    CHECK (entity_type IN ('visitor', 'session', 'contact', 'returning')),
  start_boundary TEXT NOT NULL,
  occurrence_date TEXT NOT NULL,
  range_delta INTEGER NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (entity_type, start_boundary, occurrence_date)
);

CREATE TABLE IF NOT EXISTS tracking_analytics_facet_values (
  facet_value_id INTEGER PRIMARY KEY AUTOINCREMENT,
  facet_type TEXT NOT NULL,
  facet_value TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (facet_type, facet_value)
);

CREATE INDEX IF NOT EXISTS idx_tracking_analytics_facet_values_type
  ON tracking_analytics_facet_values(facet_type, facet_value_id);

CREATE TABLE IF NOT EXISTS tracking_analytics_facet_range_delta (
  facet_value_id INTEGER NOT NULL,
  start_boundary TEXT NOT NULL,
  occurrence_date TEXT NOT NULL,
  range_delta INTEGER NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (facet_value_id, start_boundary, occurrence_date),
  FOREIGN KEY (facet_value_id)
    REFERENCES tracking_analytics_facet_values(facet_value_id) ON DELETE CASCADE
);

CREATE TRIGGER IF NOT EXISTS trg_tracking_analytics_sessions_insert
AFTER INSERT ON sessions
FOR EACH ROW
BEGIN
  INSERT INTO tracking_analytics_change_queue(session_row_id, revision, enqueued_at)
  VALUES (NEW.id, 1, CURRENT_TIMESTAMP)
  ON CONFLICT(session_row_id) DO UPDATE SET
    revision = tracking_analytics_change_queue.revision + 1,
    enqueued_at = CURRENT_TIMESTAMP;
END;

CREATE TRIGGER IF NOT EXISTS trg_tracking_analytics_sessions_update
AFTER UPDATE OF
  session_id, visitor_id, contact_id, event_name, started_at, page_url,
  referrer_url, utm_source, utm_medium, utm_campaign, utm_content, channel,
  source_platform, campaign_id, adset_id, ad_group_id, ad_id, campaign_name,
  adset_name, ad_group_name, ad_name, placement, site_source_name, device_type,
  os, browser, tracking_source, site_id, site_slug, site_name, site_type,
  form_site_id, form_site_name, conversion_type, submission_id
ON sessions
FOR EACH ROW
BEGIN
  INSERT INTO tracking_analytics_change_queue(session_row_id, revision, enqueued_at)
  VALUES (NEW.id, 1, CURRENT_TIMESTAMP)
  ON CONFLICT(session_row_id) DO UPDATE SET
    revision = tracking_analytics_change_queue.revision + 1,
    enqueued_at = CURRENT_TIMESTAMP;
END;

CREATE TRIGGER IF NOT EXISTS trg_tracking_analytics_sessions_delete
AFTER DELETE ON sessions
FOR EACH ROW
BEGIN
  INSERT INTO tracking_analytics_change_queue(session_row_id, revision, enqueued_at)
  VALUES (OLD.id, 1, CURRENT_TIMESTAMP)
  ON CONFLICT(session_row_id) DO UPDATE SET
    revision = tracking_analytics_change_queue.revision + 1,
    enqueued_at = CURRENT_TIMESTAMP;
END;
