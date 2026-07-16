-- Debe ser la primera sentencia: usa exactamente el mismo fence que los
-- workers de projectionBackfillScheduler y espera a que cualquier v3 termine.
SELECT pg_advisory_xact_lock(-6793680755275321734);

-- Separa la categoría normalizada de Origin del valor exacto usado por los
-- filtros legacy. La versión 4 también distingue contact_id NULL de ''.
ALTER TABLE tracking_analytics_dimensions
  ADD COLUMN IF NOT EXISTS source_filter_value TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_tracking_analytics_dimensions_source_filter
  ON tracking_analytics_dimensions(LOWER(source_filter_value));

-- El nombre viejo queda como vista vacía: v3 obtiene cero filas de estado y
-- retorna unavailable antes de borrar datos. V4 es la única generación que
-- conoce y puede mutar la tabla durable renombrada.
ALTER TABLE tracking_analytics_projection_state
  RENAME TO tracking_analytics_projection_state_v4;

CREATE VIEW tracking_analytics_projection_state AS
SELECT *
FROM tracking_analytics_projection_state_v4
WHERE FALSE;

UPDATE tracking_analytics_projection_state_v4
SET projection_version = 4,
    account_timezone = '',
    status = 'backfilling',
    backfill_cursor = NULL,
    backfill_complete = FALSE,
    range_status = 'pending',
    range_compile_cursor = NULL,
    range_backfill_complete = FALSE,
    last_applied_at = NULL,
    last_error = NULL,
    updated_at = CURRENT_TIMESTAMP
WHERE singleton_id = 1;
