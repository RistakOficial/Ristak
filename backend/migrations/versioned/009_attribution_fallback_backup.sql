-- (TRK-006) Respaldo y marca del fallback de atribución. Antes el fallback
-- sobrescribía attribution_ad_id sin guardar el valor original ni dejar rastro
-- de que la atribución fue automática. Estas columnas aditivas permiten:
--   * attribution_ad_id_original: conservar el ad_id que tenía el contacto antes
--     del primer fallback (se llena con COALESCE para no pisar respaldos previos).
--   * attribution_is_fallback: marcar (1) que la atribución actual vino del fallback.
-- Aditiva e idempotente vía el runner versionado (tolera "duplicate column").
-- INTEGER DEFAULT 0 es seguro en SQLite y PostgreSQL; NO se usa CURRENT_TIMESTAMP.
ALTER TABLE contacts ADD COLUMN attribution_ad_id_original TEXT;
ALTER TABLE contacts ADD COLUMN attribution_is_fallback INTEGER DEFAULT 0;
