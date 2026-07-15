CREATE TABLE IF NOT EXISTS campaign_overview_snapshots (
  account_scope TEXT NOT NULL,
  cache_key TEXT NOT NULL,
  source_revision TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  built_at TEXT NOT NULL,
  last_accessed_at TEXT NOT NULL,
  PRIMARY KEY (account_scope, cache_key)
);

CREATE INDEX IF NOT EXISTS idx_campaign_overview_snapshot_lru
  ON campaign_overview_snapshots(account_scope, last_accessed_at DESC);
