CREATE TABLE IF NOT EXISTS payment_list_revisions (
  scope TEXT PRIMARY KEY,
  revision INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO payment_list_revisions (scope, revision) VALUES ('subscriptions', 0);
INSERT OR IGNORE INTO payment_list_revisions (scope, revision) VALUES ('payment_plans', 0);

CREATE TABLE IF NOT EXISTS payment_list_summary_cache (
  account_scope TEXT NOT NULL,
  scope TEXT NOT NULL,
  source_revision INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  built_at TEXT NOT NULL,
  last_accessed_at TEXT NOT NULL,
  PRIMARY KEY (account_scope, scope)
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_cursor_next
  ON subscriptions((CASE WHEN next_run_at IS NULL THEN 1 ELSE 0 END), next_run_at, (COALESCE(updated_at, created_at)), id)
  WHERE COALESCE(status, '') <> 'deleted';
CREATE INDEX IF NOT EXISTS idx_subscriptions_cursor_name
  ON subscriptions((CASE WHEN name IS NULL THEN 1 ELSE 0 END), name, (COALESCE(updated_at, created_at)), id)
  WHERE COALESCE(status, '') <> 'deleted';
CREATE INDEX IF NOT EXISTS idx_subscriptions_cursor_contact
  ON subscriptions((CASE WHEN contact_name IS NULL THEN 1 ELSE 0 END), contact_name, (COALESCE(updated_at, created_at)), id)
  WHERE COALESCE(status, '') <> 'deleted';
CREATE INDEX IF NOT EXISTS idx_subscriptions_cursor_amount
  ON subscriptions((CASE WHEN amount IS NULL THEN 1 ELSE 0 END), amount, (COALESCE(updated_at, created_at)), id)
  WHERE COALESCE(status, '') <> 'deleted';
CREATE INDEX IF NOT EXISTS idx_subscriptions_cursor_updated
  ON subscriptions((CASE WHEN updated_at IS NULL THEN 1 ELSE 0 END), updated_at, (COALESCE(updated_at, created_at)), id)
  WHERE COALESCE(status, '') <> 'deleted';

CREATE INDEX IF NOT EXISTS idx_subscriptions_cursor_status
  ON subscriptions((CASE WHEN status IS NULL THEN 1 ELSE 0 END), status, (COALESCE(updated_at, created_at)), id)
  WHERE COALESCE(status, '') <> 'deleted';
CREATE INDEX IF NOT EXISTS idx_subscriptions_cursor_interval
  ON subscriptions((CASE WHEN interval_type IS NULL THEN 1 ELSE 0 END), interval_type, (COALESCE(updated_at, created_at)), id)
  WHERE COALESCE(status, '') <> 'deleted';
CREATE INDEX IF NOT EXISTS idx_subscriptions_cursor_method
  ON subscriptions((CASE WHEN payment_method IS NULL THEN 1 ELSE 0 END), payment_method, (COALESCE(updated_at, created_at)), id)
  WHERE COALESCE(status, '') <> 'deleted';
CREATE INDEX IF NOT EXISTS idx_subscriptions_cursor_created
  ON subscriptions((CASE WHEN created_at IS NULL THEN 1 ELSE 0 END), created_at, (COALESCE(updated_at, created_at)), id)
  WHERE COALESCE(status, '') <> 'deleted';

CREATE INDEX IF NOT EXISTS idx_payment_plans_total_cursor
  ON payment_plans((CASE WHEN total IS NULL THEN 1 ELSE 0 END), total, (COALESCE(next_run_at, updated_at, created_at, '')), id);
CREATE INDEX IF NOT EXISTS idx_payment_plans_email_cursor
  ON payment_plans((LOWER(COALESCE(email, ''))), (COALESCE(next_run_at, updated_at, created_at, '')), id);

DROP TRIGGER IF EXISTS trg_payment_list_subscriptions_insert;
DROP TRIGGER IF EXISTS trg_payment_list_subscriptions_update;
DROP TRIGGER IF EXISTS trg_payment_list_subscriptions_delete;
DROP TRIGGER IF EXISTS trg_payment_list_plans_insert;
DROP TRIGGER IF EXISTS trg_payment_list_plans_update;
DROP TRIGGER IF EXISTS trg_payment_list_plans_delete;

CREATE TRIGGER trg_payment_list_subscriptions_insert AFTER INSERT ON subscriptions BEGIN
  UPDATE payment_list_revisions SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE scope = 'subscriptions';
END;
CREATE TRIGGER trg_payment_list_subscriptions_update AFTER UPDATE ON subscriptions BEGIN
  UPDATE payment_list_revisions SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE scope = 'subscriptions';
END;
CREATE TRIGGER trg_payment_list_subscriptions_delete AFTER DELETE ON subscriptions BEGIN
  UPDATE payment_list_revisions SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE scope = 'subscriptions';
END;

CREATE TRIGGER trg_payment_list_plans_insert AFTER INSERT ON payment_plans BEGIN
  UPDATE payment_list_revisions SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE scope = 'payment_plans';
END;
CREATE TRIGGER trg_payment_list_plans_update AFTER UPDATE ON payment_plans BEGIN
  UPDATE payment_list_revisions SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE scope = 'payment_plans';
END;
CREATE TRIGGER trg_payment_list_plans_delete AFTER DELETE ON payment_plans BEGIN
  UPDATE payment_list_revisions SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE scope = 'payment_plans';
END;
