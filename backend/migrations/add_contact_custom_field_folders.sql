CREATE TABLE IF NOT EXISTS contact_custom_field_folders (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  sort_order INTEGER DEFAULT 0,
  archived INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE contact_custom_field_definitions
  ADD COLUMN IF NOT EXISTS folder_id TEXT REFERENCES contact_custom_field_folders(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_contact_custom_field_folders_archived
  ON contact_custom_field_folders(archived);

CREATE INDEX IF NOT EXISTS idx_contact_custom_field_folders_sort
  ON contact_custom_field_folders(sort_order, name);

CREATE INDEX IF NOT EXISTS idx_contact_custom_field_definitions_folder
  ON contact_custom_field_definitions(folder_id);
