-- (META-001) Agrega la columna impressions a meta_ads para calcular CPM y CTR
-- correctamente (por impresiones, no por reach). Aditiva e idempotente vía el runner
-- versionado (corre una sola vez; el runner tolera "ya existe" en deploy overlap).
ALTER TABLE meta_ads ADD COLUMN impressions INTEGER DEFAULT 0;
