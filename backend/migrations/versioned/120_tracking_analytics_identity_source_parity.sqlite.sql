-- Separa la categoría normalizada de Origin del valor exacto usado por los
-- filtros legacy. La versión 4 también distingue contact_id NULL de ''.
ALTER TABLE tracking_analytics_dimensions
  ADD COLUMN source_filter_value TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_tracking_analytics_dimensions_source_filter
  ON tracking_analytics_dimensions(LOWER(source_filter_value));

-- Fence de rolling deploy: BEGIN IMMEDIATE del runner espera cualquier writer
-- v3. Después del rename, el binario viejo sólo encuentra una vista vacía y
-- sale unavailable antes de ejecutar su primer DELETE. V4 conserva la fila
-- durable en un nombre generacional propio y hace el reset desde su worker.
ALTER TABLE tracking_analytics_projection_state
  RENAME TO tracking_analytics_projection_state_v4;

CREATE VIEW tracking_analytics_projection_state AS
SELECT *
FROM tracking_analytics_projection_state_v4
WHERE 0;

UPDATE tracking_analytics_projection_state_v4
SET projection_version = 4,
    account_timezone = '',
    status = 'backfilling',
    backfill_cursor = NULL,
    backfill_complete = 0,
    range_status = 'pending',
    range_compile_cursor = NULL,
    range_backfill_complete = 0,
    last_applied_at = NULL,
    last_error = NULL,
    updated_at = CURRENT_TIMESTAMP
WHERE singleton_id = 1;
