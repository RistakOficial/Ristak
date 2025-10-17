-- Migración: Eliminar foreign key de payments.contact_id
-- Fecha: 2025-10-16
-- Razón: Permitir guardar invoices sin que el contacto exista en BD local
--        (igual que "High Level - Payments")

-- IMPORTANTE: Ejecutar en SQLite Y PostgreSQL

-- ===== PARA SQLITE =====
-- 1. Deshabilitar foreign keys temporalmente
PRAGMA foreign_keys=OFF;

BEGIN TRANSACTION;

-- 2. Crear tabla temporal con la misma estructura pero SIN foreign key
CREATE TABLE payments_new (
    id TEXT PRIMARY KEY,
    contact_id TEXT,  -- SIN FOREIGN KEY
    amount REAL,
    currency TEXT DEFAULT 'MXN',
    status TEXT,
    payment_method TEXT,
    reference TEXT,
    description TEXT,
    date DATETIME,
    ghl_invoice_id TEXT,
    invoice_number TEXT,
    due_date DATE,
    sent_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 3. Copiar todos los datos
INSERT INTO payments_new
SELECT id, contact_id, amount, currency, status, payment_method, reference,
       description, date, ghl_invoice_id, invoice_number, due_date, sent_at, created_at
FROM payments;

-- 4. Eliminar tabla vieja
DROP TABLE payments;

-- 5. Renombrar tabla nueva
ALTER TABLE payments_new RENAME TO payments;

-- 6. Recrear índices
CREATE INDEX idx_payments_contact ON payments(contact_id);
CREATE INDEX idx_payments_date ON payments(date);
CREATE INDEX idx_payments_status ON payments(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_ghl_invoice ON payments(ghl_invoice_id);

COMMIT;

-- 7. Reactivar foreign keys
PRAGMA foreign_keys=ON;


-- ===== PARA POSTGRESQL (PRODUCCIÓN) =====
-- Descomentar y ejecutar en producción:

-- ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_contact_id_fkey;
