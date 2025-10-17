-- Limpieza: Eliminar pagos duplicados con contactId = locationId
-- Fecha: 2025-10-16
-- Razón: Transacciones mal sincronizadas usando locationId en vez de contactId

-- IMPORTANTE: Reemplaza 'cAEl3p2eZROgv2GFvMZM' con tu locationId real

-- Ver cuántos pagos duplicados hay
-- SELECT COUNT(*) FROM payments WHERE contact_id = 'cAEl3p2eZROgv2GFvMZM';

-- ELIMINAR pagos con locationId como contactId
DELETE FROM payments WHERE contact_id = 'cAEl3p2eZROgv2GFvMZM';

-- Verificar que se eliminaron
-- SELECT COUNT(*) FROM payments WHERE contact_id = 'cAEl3p2eZROgv2GFvMZM';
-- Debe devolver 0
