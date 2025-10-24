-- Migración: Convertir todos los timestamps a timestamptz (timestamp WITH time zone)
--
-- IMPORTANTE: Esta migración asume que todos los timestamps actuales están en UTC
-- (como vienen de HighLevel API). PostgreSQL los convertirá correctamente a timestamptz.
--
-- Fecha: 2025-10-24
-- Razón: Solucionar problemas de timezone donde timestamps sin zona horaria causaban
--        inconsistencias al filtrar datos por fecha.

BEGIN;

-- ============================================================================
-- TABLA: contacts
-- ============================================================================
ALTER TABLE contacts
  ALTER COLUMN created_at TYPE timestamptz USING created_at AT TIME ZONE 'UTC',
  ALTER COLUMN updated_at TYPE timestamptz USING updated_at AT TIME ZONE 'UTC',
  ALTER COLUMN appointment_date TYPE timestamptz USING appointment_date AT TIME ZONE 'UTC',
  ALTER COLUMN last_purchase_date TYPE timestamptz USING last_purchase_date AT TIME ZONE 'UTC';

-- ============================================================================
-- TABLA: payments
-- ============================================================================
ALTER TABLE payments
  ALTER COLUMN date TYPE timestamptz USING date AT TIME ZONE 'UTC',
  ALTER COLUMN created_at TYPE timestamptz USING created_at AT TIME ZONE 'UTC',
  ALTER COLUMN due_date TYPE timestamptz USING due_date AT TIME ZONE 'UTC',
  ALTER COLUMN sent_at TYPE timestamptz USING sent_at AT TIME ZONE 'UTC';

-- ============================================================================
-- TABLA: appointments
-- ============================================================================
ALTER TABLE appointments
  ALTER COLUMN start_time TYPE timestamptz USING start_time AT TIME ZONE 'UTC',
  ALTER COLUMN end_time TYPE timestamptz USING end_time AT TIME ZONE 'UTC',
  ALTER COLUMN date_added TYPE timestamptz USING date_added AT TIME ZONE 'UTC',
  ALTER COLUMN date_updated TYPE timestamptz USING date_updated AT TIME ZONE 'UTC';

-- ============================================================================
-- TABLA: sessions (tracking)
-- ============================================================================
ALTER TABLE sessions
  ALTER COLUMN started_at TYPE timestamptz USING started_at AT TIME ZONE 'UTC',
  ALTER COLUMN created_at TYPE timestamptz USING created_at AT TIME ZONE 'UTC';

-- ============================================================================
-- TABLA: meta_ads
-- ============================================================================
ALTER TABLE meta_ads
  ALTER COLUMN created_at TYPE timestamptz USING created_at AT TIME ZONE 'UTC',
  ALTER COLUMN updated_at TYPE timestamptz USING updated_at AT TIME ZONE 'UTC';

-- ============================================================================
-- TABLA: highlevel_config
-- ============================================================================
ALTER TABLE highlevel_config
  ALTER COLUMN created_at TYPE timestamptz USING created_at AT TIME ZONE 'UTC';

-- ============================================================================
-- TABLA: meta_config
-- ============================================================================
ALTER TABLE meta_config
  ALTER COLUMN created_at TYPE timestamptz USING created_at AT TIME ZONE 'UTC',
  ALTER COLUMN updated_at TYPE timestamptz USING updated_at AT TIME ZONE 'UTC',
  ALTER COLUMN token_expires_at TYPE timestamptz USING token_expires_at AT TIME ZONE 'UTC';

-- ============================================================================
-- TABLA: app_config
-- ============================================================================
ALTER TABLE app_config
  ALTER COLUMN created_at TYPE timestamptz USING created_at AT TIME ZONE 'UTC',
  ALTER COLUMN updated_at TYPE timestamptz USING updated_at AT TIME ZONE 'UTC';

-- ============================================================================
-- Verificar la conversión
-- ============================================================================
SELECT
  table_name,
  column_name,
  data_type
FROM information_schema.columns
WHERE table_schema = 'public'
  AND data_type LIKE '%timestamp%'
  AND table_name IN ('contacts', 'payments', 'appointments', 'sessions', 'meta_ads', 'highlevel_config', 'meta_config', 'app_config')
ORDER BY table_name, column_name;

COMMIT;

-- ============================================================================
-- RESULTADO ESPERADO:
-- ============================================================================
-- Todas las columnas de timestamp ahora deberían mostrar:
-- data_type = 'timestamp with time zone'
--
-- NOTAS POST-MIGRACIÓN:
-- 1. Todos los timestamps ahora están en timestamptz (timezone-aware)
-- 2. PostgreSQL los guarda internamente en UTC
-- 3. Al hacer queries, PostgreSQL convierte automáticamente según necesites
-- 4. En el frontend, debes convertir al timezone de HighLevel al mostrar
-- 5. Al insertar datos, SIEMPRE usa ISO strings con 'Z' (UTC)
