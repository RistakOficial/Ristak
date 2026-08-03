-- initTables agrega las columnas de forma aditiva antes de las migraciones.
-- La migración versionada sella la unicidad del recurso interno por calendario.

CREATE UNIQUE INDEX IF NOT EXISTS idx_trigger_links_system_owner
  ON trigger_links(system_scope, owner_id);
