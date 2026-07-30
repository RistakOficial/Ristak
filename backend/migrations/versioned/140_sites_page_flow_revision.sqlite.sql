-- SQLite no admite ADD COLUMN IF NOT EXISTS. El reparador de compatibilidad de
-- Sites Analytics agrega page_flow_revision antes de que corran las migraciones
-- versionadas. Esta lectura falla cerrado si ese contrato no convergió.
SELECT page_flow_revision, page_journey_id
FROM sessions
LIMIT 0;

CREATE INDEX IF NOT EXISTS idx_sessions_site_page_flow_started
  ON sessions(site_id, page_flow_revision, started_at);
