-- Directorio ligero de contactos para selectores nativos.
-- Acelera el orden de recientes sin cambiar contratos ni datos existentes.
CREATE INDEX IF NOT EXISTS idx_contacts_picker_recent
  ON contacts(deleted_at, updated_at DESC, created_at DESC, id DESC);
