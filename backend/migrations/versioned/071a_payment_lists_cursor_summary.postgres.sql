CREATE TABLE IF NOT EXISTS payment_list_revisions (
  scope TEXT PRIMARY KEY,
  revision BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO payment_list_revisions (scope, revision) VALUES ('subscriptions', 0)
ON CONFLICT (scope) DO NOTHING;
INSERT INTO payment_list_revisions (scope, revision) VALUES ('payment_plans', 0)
ON CONFLICT (scope) DO NOTHING;

CREATE TABLE IF NOT EXISTS payment_list_summary_cache (
  account_scope TEXT NOT NULL,
  scope TEXT NOT NULL,
  source_revision BIGINT NOT NULL,
  payload_json TEXT NOT NULL,
  built_at TIMESTAMPTZ NOT NULL,
  last_accessed_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (account_scope, scope)
);

CREATE OR REPLACE FUNCTION ristak_bump_payment_list_revision()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE payment_list_revisions
  SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP
  WHERE scope = TG_ARGV[0];
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_payment_list_subscriptions ON subscriptions;
DROP TRIGGER IF EXISTS trg_payment_list_plans ON payment_plans;

CREATE TRIGGER trg_payment_list_subscriptions
AFTER INSERT OR UPDATE OR DELETE ON subscriptions
FOR EACH STATEMENT EXECUTE FUNCTION ristak_bump_payment_list_revision('subscriptions');
CREATE TRIGGER trg_payment_list_plans
AFTER INSERT OR UPDATE OR DELETE ON payment_plans
FOR EACH STATEMENT EXECUTE FUNCTION ristak_bump_payment_list_revision('payment_plans');
