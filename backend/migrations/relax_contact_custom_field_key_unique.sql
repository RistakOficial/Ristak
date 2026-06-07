DROP INDEX IF EXISTS idx_contact_custom_field_definitions_owner_key;

CREATE UNIQUE INDEX IF NOT EXISTS idx_contact_custom_field_definitions_owner_key
  ON contact_custom_field_definitions(COALESCE(owner_user_id, 0), LOWER(field_key))
  WHERE archived = 0;
