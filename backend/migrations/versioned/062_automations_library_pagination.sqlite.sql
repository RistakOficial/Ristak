CREATE INDEX IF NOT EXISTS idx_automations_updated_page
  ON automations((COALESCE(updated_at, created_at, '1970-01-01 00:00:00')) DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_automations_folder_updated_page
  ON automations(folder_id, (COALESCE(updated_at, created_at, '1970-01-01 00:00:00')) DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_automations_status_updated_page
  ON automations(status, (COALESCE(updated_at, created_at, '1970-01-01 00:00:00')) DESC, id DESC);
