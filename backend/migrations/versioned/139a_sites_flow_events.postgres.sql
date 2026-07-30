-- Ledger append-only para recorrido de formularios y Sites. Se mantiene fuera
-- de sessions para no contaminar las proyecciones globales de tracking.
CREATE TABLE IF NOT EXISTS site_flow_events (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  payload_hash TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  event_sequence INTEGER NOT NULL
    CHECK (event_sequence BETWEEN 1 AND 2147483647),
  event_name TEXT NOT NULL CHECK (event_name IN (
    'attempt_start',
    'step_view',
    'field_answered',
    'step_complete',
    'attempt_completed',
    'attempt_terminal'
  )),
  visitor_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  contact_id TEXT,
  site_id TEXT NOT NULL,
  form_site_id TEXT NOT NULL,
  public_page_id TEXT,
  flow_revision TEXT NOT NULL,
  step_id TEXT,
  target_step_id TEXT,
  field_id TEXT,
  step_index INTEGER CHECK (step_index IS NULL OR step_index > 0),
  step_total INTEGER CHECK (step_total IS NULL OR step_total > 0),
  step_kind TEXT,
  outcome TEXT,
  submission_id TEXT,
  client_event_at TIMESTAMPTZ,
  event_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  timestamp_adjusted INTEGER NOT NULL DEFAULT 0
    CHECK (timestamp_adjusted IN (0, 1)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (attempt_id, event_sequence),
  CHECK (step_index IS NULL OR step_total IS NULL OR step_index <= step_total)
);
