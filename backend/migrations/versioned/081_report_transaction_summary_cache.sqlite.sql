CREATE TABLE IF NOT EXISTS report_transaction_revision (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  revision INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO report_transaction_revision (singleton, revision) VALUES (1, 0);

CREATE TABLE IF NOT EXISTS report_transaction_summary_cache (
  account_scope TEXT NOT NULL,
  cache_key TEXT NOT NULL,
  source_revision INTEGER NOT NULL,
  count_value INTEGER NOT NULL DEFAULT 0,
  total_amount REAL NOT NULL DEFAULT 0,
  built_at TEXT NOT NULL,
  last_accessed_at TEXT NOT NULL,
  PRIMARY KEY (account_scope, cache_key)
);

CREATE INDEX IF NOT EXISTS idx_report_transactions_effective_at_id
  ON payments((COALESCE(date, created_at)) DESC, id DESC)
  WHERE COALESCE(payment_mode, 'live') != 'test';

DROP TRIGGER IF EXISTS trg_report_transaction_revision_insert;
DROP TRIGGER IF EXISTS trg_report_transaction_revision_update;
DROP TRIGGER IF EXISTS trg_report_transaction_revision_delete;

CREATE TRIGGER trg_report_transaction_revision_insert AFTER INSERT ON payments BEGIN
  UPDATE report_transaction_revision
  SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP
  WHERE singleton = 1;
END;

CREATE TRIGGER trg_report_transaction_revision_update AFTER UPDATE ON payments BEGIN
  UPDATE report_transaction_revision
  SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP
  WHERE singleton = 1;
END;

CREATE TRIGGER trg_report_transaction_revision_delete AFTER DELETE ON payments BEGIN
  UPDATE report_transaction_revision
  SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP
  WHERE singleton = 1;
END;
