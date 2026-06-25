-- (CNT-007 / DB-003) Soft-delete de contactos. Al "eliminar" un contacto se marca
-- deleted_at en vez de borrarlo físicamente: así se CONSERVAN sus pagos e historial
-- (no se dispara el ON DELETE CASCADE) y el contacto queda recuperable desde la papelera.
-- Aditiva e idempotente vía el runner versionado.
ALTER TABLE contacts ADD COLUMN deleted_at DATETIME;
