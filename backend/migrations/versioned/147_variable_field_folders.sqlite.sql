CREATE TABLE IF NOT EXISTS variable_field_folders (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  sort_order INTEGER DEFAULT 0,
  archived INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_variable_field_folders_archived
  ON variable_field_folders(archived);

CREATE INDEX IF NOT EXISTS idx_variable_field_folders_sort
  ON variable_field_folders(sort_order, name);

CREATE INDEX IF NOT EXISTS idx_variable_fields_folder
  ON variable_fields(folder_id);
