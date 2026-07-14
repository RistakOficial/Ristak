CREATE INDEX IF NOT EXISTS idx_payment_plans_status_start_page
  ON payment_plans(
    (CASE
      WHEN LOWER(COALESCE(status, 'active')) IN ('complete', 'completed', 'paid', 'finished', 'finalized', 'finalizado') THEN 'completed'
      WHEN LOWER(COALESCE(status, 'active')) IN ('canceled', 'cancelled') THEN 'cancelled'
      ELSE LOWER(COALESCE(status, 'active'))
    END),
    (COALESCE(start_date, next_run_at, updated_at, created_at, '')) DESC,
    (COALESCE(next_run_at, updated_at, created_at, '')) DESC,
    id DESC
  );

CREATE INDEX IF NOT EXISTS idx_payment_plans_start_page
  ON payment_plans(
    (COALESCE(start_date, next_run_at, updated_at, created_at, '')) DESC,
    (COALESCE(next_run_at, updated_at, created_at, '')) DESC,
    id DESC
  );

CREATE INDEX IF NOT EXISTS idx_payment_plans_next_page
  ON payment_plans(
    (COALESCE(next_run_at, '')) DESC,
    (COALESCE(next_run_at, updated_at, created_at, '')) DESC,
    id DESC
  );

CREATE INDEX IF NOT EXISTS idx_payment_plans_total_page
  ON payment_plans(total DESC, (COALESCE(next_run_at, updated_at, created_at, '')) DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_payment_plans_name_page
  ON payment_plans(
    (LOWER(COALESCE(name, title, ''))) ASC,
    (COALESCE(next_run_at, updated_at, created_at, '')) ASC,
    id ASC
  );

CREATE INDEX IF NOT EXISTS idx_payment_plans_contact_page
  ON payment_plans(
    (LOWER(COALESCE(contact_name, ''))) ASC,
    (COALESCE(next_run_at, updated_at, created_at, '')) ASC,
    id ASC
  );

CREATE INDEX IF NOT EXISTS idx_payment_plans_recurrence_page
  ON payment_plans(
    (LOWER(COALESCE(recurrence_label, ''))) ASC,
    (COALESCE(next_run_at, updated_at, created_at, '')) ASC,
    id ASC
  );

CREATE INDEX IF NOT EXISTS idx_payment_plans_status_page
  ON payment_plans(
    (CASE
      WHEN LOWER(COALESCE(status, 'active')) IN ('complete', 'completed', 'paid', 'finished', 'finalized', 'finalizado') THEN 'completed'
      WHEN LOWER(COALESCE(status, 'active')) IN ('canceled', 'cancelled') THEN 'cancelled'
      ELSE LOWER(COALESCE(status, 'active'))
    END) ASC,
    (COALESCE(next_run_at, updated_at, created_at, '')) ASC,
    id ASC
  );
