-- Los cursores nuevos usan expresiones con fallback explícito. Cada reemplazo
-- v2 nace antes de retirar su v1 y el par se procesa completo antes del siguiente,
-- así no hay huecos de cobertura ni un pico de disco por duplicar toda la familia.

CREATE INDEX IF NOT EXISTS idx_contacts_cursor_effective_created_at_id
  ON contacts(
    COALESCE(created_at, '1970-01-01 00:00:00') DESC,
    id DESC
  );

CREATE INDEX IF NOT EXISTS idx_campaign_contacts_cursor_created_at_id
  ON contacts(
    COALESCE(
      NULLIF(
        COALESCE(
          COALESCE(
            julianday(created_at),
            julianday(REPLACE(REPLACE(created_at, 'T', ' '), 'Z', ''))
          ),
          0
        ),
        0
      ),
      julianday('1970-01-01 00:00:00')
    ) DESC,
    id DESC
  );

CREATE INDEX IF NOT EXISTS idx_report_transactions_effective_at_id_v2
  ON payments(
    COALESCE(date, created_at, '1970-01-01 00:00:00') DESC,
    id DESC
  )
  WHERE COALESCE(payment_mode, 'live') != 'test';

DROP INDEX IF EXISTS idx_report_transactions_effective_at_id;

CREATE INDEX IF NOT EXISTS idx_media_assets_library_business_page
  ON media_assets(
    business_id,
    COALESCE(created_at, '1970-01-01 00:00:00') DESC,
    id DESC
  )
  WHERE deleted_at IS NULL AND status != 'deleted';

CREATE INDEX IF NOT EXISTS idx_public_sites_updated_at_id_v2
  ON public_sites(
    COALESCE(updated_at, created_at, '1970-01-01 00:00:00') DESC,
    id DESC
  );

DROP INDEX IF EXISTS idx_public_sites_updated_at_id;

CREATE INDEX IF NOT EXISTS idx_subscriptions_cursor_next_v2
  ON subscriptions(
    (CASE WHEN next_run_at IS NULL THEN 1 ELSE 0 END),
    next_run_at,
    COALESCE(updated_at, created_at, ''),
    id
  )
  WHERE COALESCE(status, '') <> 'deleted';

DROP INDEX IF EXISTS idx_subscriptions_cursor_next;

CREATE INDEX IF NOT EXISTS idx_subscriptions_cursor_name_v2
  ON subscriptions(
    (CASE WHEN name IS NULL THEN 1 ELSE 0 END),
    name,
    COALESCE(updated_at, created_at, ''),
    id
  )
  WHERE COALESCE(status, '') <> 'deleted';

DROP INDEX IF EXISTS idx_subscriptions_cursor_name;

CREATE INDEX IF NOT EXISTS idx_subscriptions_cursor_contact_v2
  ON subscriptions(
    (CASE WHEN contact_name IS NULL THEN 1 ELSE 0 END),
    contact_name,
    COALESCE(updated_at, created_at, ''),
    id
  )
  WHERE COALESCE(status, '') <> 'deleted';

DROP INDEX IF EXISTS idx_subscriptions_cursor_contact;

CREATE INDEX IF NOT EXISTS idx_subscriptions_cursor_amount_v2
  ON subscriptions(
    (CASE WHEN amount IS NULL THEN 1 ELSE 0 END),
    amount,
    COALESCE(updated_at, created_at, ''),
    id
  )
  WHERE COALESCE(status, '') <> 'deleted';

DROP INDEX IF EXISTS idx_subscriptions_cursor_amount;

CREATE INDEX IF NOT EXISTS idx_subscriptions_cursor_updated_v2
  ON subscriptions(
    (CASE WHEN updated_at IS NULL THEN 1 ELSE 0 END),
    updated_at,
    COALESCE(updated_at, created_at, ''),
    id
  )
  WHERE COALESCE(status, '') <> 'deleted';

DROP INDEX IF EXISTS idx_subscriptions_cursor_updated;

CREATE INDEX IF NOT EXISTS idx_subscriptions_cursor_status_v2
  ON subscriptions(
    (CASE WHEN status IS NULL THEN 1 ELSE 0 END),
    status,
    COALESCE(updated_at, created_at, ''),
    id
  )
  WHERE COALESCE(status, '') <> 'deleted';

DROP INDEX IF EXISTS idx_subscriptions_cursor_status;

CREATE INDEX IF NOT EXISTS idx_subscriptions_cursor_interval_v2
  ON subscriptions(
    (CASE WHEN interval_type IS NULL THEN 1 ELSE 0 END),
    interval_type,
    COALESCE(updated_at, created_at, ''),
    id
  )
  WHERE COALESCE(status, '') <> 'deleted';

DROP INDEX IF EXISTS idx_subscriptions_cursor_interval;

CREATE INDEX IF NOT EXISTS idx_subscriptions_cursor_method_v2
  ON subscriptions(
    (CASE WHEN payment_method IS NULL THEN 1 ELSE 0 END),
    payment_method,
    COALESCE(updated_at, created_at, ''),
    id
  )
  WHERE COALESCE(status, '') <> 'deleted';

DROP INDEX IF EXISTS idx_subscriptions_cursor_method;

CREATE INDEX IF NOT EXISTS idx_subscriptions_cursor_created_v2
  ON subscriptions(
    (CASE WHEN created_at IS NULL THEN 1 ELSE 0 END),
    created_at,
    COALESCE(updated_at, created_at, ''),
    id
  )
  WHERE COALESCE(status, '') <> 'deleted';

DROP INDEX IF EXISTS idx_subscriptions_cursor_created;
