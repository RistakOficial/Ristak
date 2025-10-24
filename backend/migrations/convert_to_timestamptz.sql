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
  ALTER COLUMN updated_at TYPE timestamptz USING updated_at AT TIME ZONE 'UTC';

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
-- La columna 'date' es tipo DATE (solo fecha sin hora), no necesita cambio
-- Pero created_at y updated_at sí
ALTER TABLE meta_ads
  ALTER COLUMN created_at TYPE timestamptz USING created_at AT TIME ZONE 'UTC',
  ALTER COLUMN updated_at TYPE timestamptz USING updated_at AT TIME ZONE 'UTC';

-- ============================================================================
-- TABLA: highlevel_config
-- ============================================================================
ALTER TABLE highlevel_config
  ALTER COLUMN created_at TYPE timestamptz USING created_at AT TIME ZONE 'UTC',
  ALTER COLUMN updated_at TYPE timestamptz USING updated_at AT TIME ZONE 'UTC';

-- ============================================================================
-- TABLA: meta_config
-- ============================================================================
ALTER TABLE meta_config
  ALTER COLUMN updated_at TYPE timestamptz USING updated_at AT TIME ZONE 'UTC';

-- ============================================================================
-- TABLA: app_config (si existe)
-- ============================================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'app_config') THEN
    ALTER TABLE app_config
      ALTER COLUMN updated_at TYPE timestamptz USING updated_at AT TIME ZONE 'UTC';
  END IF;
END $$;

-- ============================================================================
-- Verificar la conversión
-- ============================================================================
SELECT
  table_name,
  column_name,
  data_type
FROM information_schema.columns
WHERE table_schema = 'public'
  AND (column_name LIKE '%_at' OR column_name LIKE '%time%' OR column_name = 'date')
  AND table_name IN ('contacts', 'payments', 'appointments', 'sessions', 'meta_ads', 'highlevel_config', 'meta_config', 'app_config')
ORDER BY table_name, column_name;

COMMIT;

-- ============================================================================
-- NOTAS POST-MIGRACIÓN:
-- ============================================================================
-- 1. Todos los timestamps ahora están en timestamptz (timezone-aware)
-- 2. PostgreSQL los guarda internamente en UTC
-- 3. Al hacer queries, PostgreSQL convierte automáticamente al timezone de la sesión
-- 4. En el frontend, debes convertir al timezone de HighLevel al mostrar
-- 5. Al insertar datos, SIEMPRE usa timestamps en UTC (como vienen de HighLevel)
