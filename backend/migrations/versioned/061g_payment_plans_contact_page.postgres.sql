CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payment_plans_contact_page
  ON payment_plans(
    (LOWER(COALESCE(contact_name, ''))) ASC,
    (COALESCE(next_run_at, updated_at, created_at, TIMESTAMP '1970-01-01 00:00:00')) ASC,
    id ASC
  );
