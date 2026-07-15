CREATE TABLE automation_review_projection_staging (
  run_token TEXT NOT NULL,
  automation_id TEXT NOT NULL,
  automation_name TEXT NOT NULL,
  automation_status TEXT NOT NULL,
  issue_count INTEGER NOT NULL,
  summary TEXT NOT NULL,
  issues_json JSONB NOT NULL,
  automation_updated_at TIMESTAMPTZ,
  projected_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (run_token, automation_id)
);

CREATE INDEX idx_automation_review_projection_staging_abandoned
  ON automation_review_projection_staging(projected_at, run_token, automation_id);
