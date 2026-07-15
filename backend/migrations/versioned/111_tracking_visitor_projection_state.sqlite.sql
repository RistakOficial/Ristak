CREATE TABLE IF NOT EXISTS tracking_visitor_projection_state (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  projection_version INTEGER NOT NULL DEFAULT 3,
  status TEXT NOT NULL DEFAULT 'backfilling'
    CHECK (status IN ('backfilling', 'ready', 'failed')),
  last_error TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO tracking_visitor_projection_state (
  singleton_id,
  projection_version,
  status
) VALUES (1, 3, 'backfilling')
ON CONFLICT(singleton_id) DO UPDATE SET
  status = CASE
    WHEN tracking_visitor_projection_state.projection_version = excluded.projection_version
      THEN tracking_visitor_projection_state.status
    ELSE 'backfilling'
  END,
  projection_version = excluded.projection_version,
  last_error = CASE
    WHEN tracking_visitor_projection_state.projection_version = excluded.projection_version
      THEN tracking_visitor_projection_state.last_error
    ELSE NULL
  END,
  updated_at = CURRENT_TIMESTAMP;
