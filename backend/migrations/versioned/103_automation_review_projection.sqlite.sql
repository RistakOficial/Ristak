CREATE TABLE automation_review_projection_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  source_revision INTEGER NOT NULL DEFAULT 0,
  projected_revision INTEGER NOT NULL DEFAULT -1,
  status TEXT NOT NULL DEFAULT 'pending',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
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
  issues_json TEXT NOT NULL,
  automation_updated_at TEXT,
  projected_at TEXT NOT NULL
);

CREATE INDEX idx_automation_review_projection_problem_page
  ON automation_review_projection(automation_updated_at DESC, automation_id DESC);

CREATE TRIGGER trg_automation_review_automations_insert
AFTER INSERT ON automations BEGIN
  UPDATE automation_review_projection_state
  SET source_revision = source_revision + 1, status = 'pending', updated_at = CURRENT_TIMESTAMP
  WHERE singleton = 1;
END;
CREATE TRIGGER trg_automation_review_automations_update
AFTER UPDATE ON automations BEGIN
  UPDATE automation_review_projection_state
  SET source_revision = source_revision + 1, status = 'pending', updated_at = CURRENT_TIMESTAMP
  WHERE singleton = 1;
END;
CREATE TRIGGER trg_automation_review_automations_delete
AFTER DELETE ON automations BEGIN
  UPDATE automation_review_projection_state
  SET source_revision = source_revision + 1, status = 'pending', updated_at = CURRENT_TIMESTAMP
  WHERE singleton = 1;
END;

CREATE TRIGGER trg_automation_review_contact_tags_insert AFTER INSERT ON contact_tags BEGIN
  UPDATE automation_review_projection_state SET source_revision = source_revision + 1, status = 'pending', updated_at = CURRENT_TIMESTAMP WHERE singleton = 1;
END;
CREATE TRIGGER trg_automation_review_contact_tags_update AFTER UPDATE ON contact_tags BEGIN
  UPDATE automation_review_projection_state SET source_revision = source_revision + 1, status = 'pending', updated_at = CURRENT_TIMESTAMP WHERE singleton = 1;
END;
CREATE TRIGGER trg_automation_review_contact_tags_delete AFTER DELETE ON contact_tags BEGIN
  UPDATE automation_review_projection_state SET source_revision = source_revision + 1, status = 'pending', updated_at = CURRENT_TIMESTAMP WHERE singleton = 1;
END;

CREATE TRIGGER trg_automation_review_custom_fields_insert AFTER INSERT ON contact_custom_field_definitions BEGIN
  UPDATE automation_review_projection_state SET source_revision = source_revision + 1, status = 'pending', updated_at = CURRENT_TIMESTAMP WHERE singleton = 1;
END;
CREATE TRIGGER trg_automation_review_custom_fields_update AFTER UPDATE ON contact_custom_field_definitions BEGIN
  UPDATE automation_review_projection_state SET source_revision = source_revision + 1, status = 'pending', updated_at = CURRENT_TIMESTAMP WHERE singleton = 1;
END;
CREATE TRIGGER trg_automation_review_custom_fields_delete AFTER DELETE ON contact_custom_field_definitions BEGIN
  UPDATE automation_review_projection_state SET source_revision = source_revision + 1, status = 'pending', updated_at = CURRENT_TIMESTAMP WHERE singleton = 1;
END;

CREATE TRIGGER trg_automation_review_users_insert AFTER INSERT ON users BEGIN
  UPDATE automation_review_projection_state SET source_revision = source_revision + 1, status = 'pending', updated_at = CURRENT_TIMESTAMP WHERE singleton = 1;
END;
CREATE TRIGGER trg_automation_review_users_update AFTER UPDATE ON users BEGIN
  UPDATE automation_review_projection_state SET source_revision = source_revision + 1, status = 'pending', updated_at = CURRENT_TIMESTAMP WHERE singleton = 1;
END;
CREATE TRIGGER trg_automation_review_users_delete AFTER DELETE ON users BEGIN
  UPDATE automation_review_projection_state SET source_revision = source_revision + 1, status = 'pending', updated_at = CURRENT_TIMESTAMP WHERE singleton = 1;
END;

CREATE TRIGGER trg_automation_review_calendars_insert AFTER INSERT ON calendars BEGIN
  UPDATE automation_review_projection_state SET source_revision = source_revision + 1, status = 'pending', updated_at = CURRENT_TIMESTAMP WHERE singleton = 1;
END;
CREATE TRIGGER trg_automation_review_calendars_update AFTER UPDATE ON calendars BEGIN
  UPDATE automation_review_projection_state SET source_revision = source_revision + 1, status = 'pending', updated_at = CURRENT_TIMESTAMP WHERE singleton = 1;
END;
CREATE TRIGGER trg_automation_review_calendars_delete AFTER DELETE ON calendars BEGIN
  UPDATE automation_review_projection_state SET source_revision = source_revision + 1, status = 'pending', updated_at = CURRENT_TIMESTAMP WHERE singleton = 1;
END;

CREATE TRIGGER trg_automation_review_trigger_links_insert AFTER INSERT ON trigger_links BEGIN
  UPDATE automation_review_projection_state SET source_revision = source_revision + 1, status = 'pending', updated_at = CURRENT_TIMESTAMP WHERE singleton = 1;
END;
CREATE TRIGGER trg_automation_review_trigger_links_update AFTER UPDATE ON trigger_links BEGIN
  UPDATE automation_review_projection_state SET source_revision = source_revision + 1, status = 'pending', updated_at = CURRENT_TIMESTAMP WHERE singleton = 1;
END;
CREATE TRIGGER trg_automation_review_trigger_links_delete AFTER DELETE ON trigger_links BEGIN
  UPDATE automation_review_projection_state SET source_revision = source_revision + 1, status = 'pending', updated_at = CURRENT_TIMESTAMP WHERE singleton = 1;
END;

CREATE TRIGGER trg_automation_review_wa_numbers_insert AFTER INSERT ON whatsapp_api_phone_numbers BEGIN
  UPDATE automation_review_projection_state SET source_revision = source_revision + 1, status = 'pending', updated_at = CURRENT_TIMESTAMP WHERE singleton = 1;
END;
CREATE TRIGGER trg_automation_review_wa_numbers_update AFTER UPDATE ON whatsapp_api_phone_numbers BEGIN
  UPDATE automation_review_projection_state SET source_revision = source_revision + 1, status = 'pending', updated_at = CURRENT_TIMESTAMP WHERE singleton = 1;
END;
CREATE TRIGGER trg_automation_review_wa_numbers_delete AFTER DELETE ON whatsapp_api_phone_numbers BEGIN
  UPDATE automation_review_projection_state SET source_revision = source_revision + 1, status = 'pending', updated_at = CURRENT_TIMESTAMP WHERE singleton = 1;
END;

CREATE TRIGGER trg_automation_review_wa_templates_insert AFTER INSERT ON whatsapp_api_templates BEGIN
  UPDATE automation_review_projection_state SET source_revision = source_revision + 1, status = 'pending', updated_at = CURRENT_TIMESTAMP WHERE singleton = 1;
END;
CREATE TRIGGER trg_automation_review_wa_templates_update AFTER UPDATE ON whatsapp_api_templates BEGIN
  UPDATE automation_review_projection_state SET source_revision = source_revision + 1, status = 'pending', updated_at = CURRENT_TIMESTAMP WHERE singleton = 1;
END;
CREATE TRIGGER trg_automation_review_wa_templates_delete AFTER DELETE ON whatsapp_api_templates BEGIN
  UPDATE automation_review_projection_state SET source_revision = source_revision + 1, status = 'pending', updated_at = CURRENT_TIMESTAMP WHERE singleton = 1;
END;

CREATE TRIGGER trg_automation_review_sites_insert AFTER INSERT ON public_sites BEGIN
  UPDATE automation_review_projection_state SET source_revision = source_revision + 1, status = 'pending', updated_at = CURRENT_TIMESTAMP WHERE singleton = 1;
END;
CREATE TRIGGER trg_automation_review_sites_update AFTER UPDATE ON public_sites BEGIN
  UPDATE automation_review_projection_state SET source_revision = source_revision + 1, status = 'pending', updated_at = CURRENT_TIMESTAMP WHERE singleton = 1;
END;
CREATE TRIGGER trg_automation_review_sites_delete AFTER DELETE ON public_sites BEGIN
  UPDATE automation_review_projection_state SET source_revision = source_revision + 1, status = 'pending', updated_at = CURRENT_TIMESTAMP WHERE singleton = 1;
END;

CREATE TRIGGER trg_automation_review_site_blocks_insert AFTER INSERT ON public_site_blocks BEGIN
  UPDATE automation_review_projection_state SET source_revision = source_revision + 1, status = 'pending', updated_at = CURRENT_TIMESTAMP WHERE singleton = 1;
END;
CREATE TRIGGER trg_automation_review_site_blocks_update AFTER UPDATE ON public_site_blocks BEGIN
  UPDATE automation_review_projection_state SET source_revision = source_revision + 1, status = 'pending', updated_at = CURRENT_TIMESTAMP WHERE singleton = 1;
END;
CREATE TRIGGER trg_automation_review_site_blocks_delete AFTER DELETE ON public_site_blocks BEGIN
  UPDATE automation_review_projection_state SET source_revision = source_revision + 1, status = 'pending', updated_at = CURRENT_TIMESTAMP WHERE singleton = 1;
END;

CREATE TRIGGER trg_automation_review_site_imports_insert AFTER INSERT ON public_site_imports BEGIN
  UPDATE automation_review_projection_state SET source_revision = source_revision + 1, status = 'pending', updated_at = CURRENT_TIMESTAMP WHERE singleton = 1;
END;
CREATE TRIGGER trg_automation_review_site_imports_update AFTER UPDATE ON public_site_imports BEGIN
  UPDATE automation_review_projection_state SET source_revision = source_revision + 1, status = 'pending', updated_at = CURRENT_TIMESTAMP WHERE singleton = 1;
END;
CREATE TRIGGER trg_automation_review_site_imports_delete AFTER DELETE ON public_site_imports BEGIN
  UPDATE automation_review_projection_state SET source_revision = source_revision + 1, status = 'pending', updated_at = CURRENT_TIMESTAMP WHERE singleton = 1;
END;

CREATE TRIGGER trg_automation_review_highlevel_insert AFTER INSERT ON highlevel_config BEGIN
  UPDATE automation_review_projection_state SET source_revision = source_revision + 1, status = 'pending', updated_at = CURRENT_TIMESTAMP WHERE singleton = 1;
END;
CREATE TRIGGER trg_automation_review_highlevel_update AFTER UPDATE OF custom_labels ON highlevel_config BEGIN
  UPDATE automation_review_projection_state SET source_revision = source_revision + 1, status = 'pending', updated_at = CURRENT_TIMESTAMP WHERE singleton = 1;
END;
CREATE TRIGGER trg_automation_review_highlevel_delete AFTER DELETE ON highlevel_config BEGIN
  UPDATE automation_review_projection_state SET source_revision = source_revision + 1, status = 'pending', updated_at = CURRENT_TIMESTAMP WHERE singleton = 1;
END;
