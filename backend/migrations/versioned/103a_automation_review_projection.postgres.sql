CREATE TABLE automation_review_projection_state (
  singleton SMALLINT PRIMARY KEY CHECK (singleton = 1),
  source_revision BIGINT NOT NULL DEFAULT 0,
  projected_revision BIGINT NOT NULL DEFAULT -1,
  status TEXT NOT NULL DEFAULT 'pending',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO automation_review_projection_state (
  singleton, source_revision, projected_revision, status
) VALUES (1, 0, -1, 'pending');

CREATE TABLE automation_review_projection (
  automation_id TEXT PRIMARY KEY,
  automation_name TEXT NOT NULL,
  automation_status TEXT NOT NULL,
  issue_count INTEGER NOT NULL,
  summary TEXT NOT NULL,
  issues_json JSONB NOT NULL,
  automation_updated_at TIMESTAMPTZ,
  projected_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX idx_automation_review_projection_problem_page
  ON automation_review_projection(automation_updated_at DESC, automation_id DESC);

CREATE OR REPLACE FUNCTION ristak_mark_automation_review_pending()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE automation_review_projection_state
  SET source_revision = source_revision + 1,
      status = 'pending',
      updated_at = CURRENT_TIMESTAMP
  WHERE singleton = 1;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_automation_review_automations
AFTER INSERT OR UPDATE OR DELETE ON automations
FOR EACH STATEMENT EXECUTE FUNCTION ristak_mark_automation_review_pending();
CREATE TRIGGER trg_automation_review_contact_tags
AFTER INSERT OR UPDATE OR DELETE ON contact_tags
FOR EACH STATEMENT EXECUTE FUNCTION ristak_mark_automation_review_pending();
CREATE TRIGGER trg_automation_review_custom_fields
AFTER INSERT OR UPDATE OR DELETE ON contact_custom_field_definitions
FOR EACH STATEMENT EXECUTE FUNCTION ristak_mark_automation_review_pending();
CREATE TRIGGER trg_automation_review_users
AFTER INSERT OR UPDATE OR DELETE ON users
FOR EACH STATEMENT EXECUTE FUNCTION ristak_mark_automation_review_pending();
CREATE TRIGGER trg_automation_review_calendars
AFTER INSERT OR UPDATE OR DELETE ON calendars
FOR EACH STATEMENT EXECUTE FUNCTION ristak_mark_automation_review_pending();
CREATE TRIGGER trg_automation_review_trigger_links
AFTER INSERT OR UPDATE OR DELETE ON trigger_links
FOR EACH STATEMENT EXECUTE FUNCTION ristak_mark_automation_review_pending();
CREATE TRIGGER trg_automation_review_wa_numbers
AFTER INSERT OR UPDATE OR DELETE ON whatsapp_api_phone_numbers
FOR EACH STATEMENT EXECUTE FUNCTION ristak_mark_automation_review_pending();
CREATE TRIGGER trg_automation_review_wa_templates
AFTER INSERT OR UPDATE OR DELETE ON whatsapp_api_templates
FOR EACH STATEMENT EXECUTE FUNCTION ristak_mark_automation_review_pending();
CREATE TRIGGER trg_automation_review_sites
AFTER INSERT OR UPDATE OR DELETE ON public_sites
FOR EACH STATEMENT EXECUTE FUNCTION ristak_mark_automation_review_pending();
CREATE TRIGGER trg_automation_review_site_blocks
AFTER INSERT OR UPDATE OR DELETE ON public_site_blocks
FOR EACH STATEMENT EXECUTE FUNCTION ristak_mark_automation_review_pending();
CREATE TRIGGER trg_automation_review_site_imports
AFTER INSERT OR UPDATE OR DELETE ON public_site_imports
FOR EACH STATEMENT EXECUTE FUNCTION ristak_mark_automation_review_pending();
CREATE TRIGGER trg_automation_review_highlevel
AFTER INSERT OR UPDATE OR DELETE ON highlevel_config
FOR EACH STATEMENT EXECUTE FUNCTION ristak_mark_automation_review_pending();
