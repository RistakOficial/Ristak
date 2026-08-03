-- Enlaces de videollamada administrados internamente por calendario.
ALTER TABLE trigger_links
  ADD COLUMN IF NOT EXISTS system_managed INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS system_scope TEXT,
  ADD COLUMN IF NOT EXISTS owner_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_trigger_links_system_owner
  ON trigger_links(system_scope, owner_id);
