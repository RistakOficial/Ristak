CREATE TABLE IF NOT EXISTS reports_snapshot_cache (
  account_scope TEXT NOT NULL,
  principal_scope TEXT NOT NULL,
  cache_key TEXT NOT NULL,
  source_revision TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  built_at TEXT NOT NULL,
  last_accessed_at TEXT NOT NULL,
  PRIMARY KEY (account_scope, principal_scope, cache_key)
);

CREATE INDEX IF NOT EXISTS idx_reports_snapshot_cache_lru
  ON reports_snapshot_cache(account_scope, principal_scope, last_accessed_at DESC);
CREATE INDEX IF NOT EXISTS idx_reports_snapshot_cache_account_lru
  ON reports_snapshot_cache(account_scope, last_accessed_at DESC);

-- 070* ya invalida contactos, pagos, citas, asistencia, anuncios y sesiones
-- sólo por columnas relevantes. Esta revision adicional cubre exclusivamente
-- teléfonos canónicos, filtros y configuración que Reportes también consume.
CREATE TABLE IF NOT EXISTS reports_snapshot_revision (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  revision INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO reports_snapshot_revision (singleton, revision) VALUES (1, 0);

-- Limpia tanto el contrato actual como cualquier borrador previo aplicado en
-- una base de desarrollo antes de recrear únicamente los triggers necesarios.
DROP TRIGGER IF EXISTS trg_reports_snapshot_contacts_insert;
DROP TRIGGER IF EXISTS trg_reports_snapshot_contacts_update;
DROP TRIGGER IF EXISTS trg_reports_snapshot_contacts_delete;
DROP TRIGGER IF EXISTS trg_reports_snapshot_contact_phones_insert;
DROP TRIGGER IF EXISTS trg_reports_snapshot_contact_phones_update;
DROP TRIGGER IF EXISTS trg_reports_snapshot_contact_phones_delete;
DROP TRIGGER IF EXISTS trg_reports_snapshot_payments_insert;
DROP TRIGGER IF EXISTS trg_reports_snapshot_payments_update;
DROP TRIGGER IF EXISTS trg_reports_snapshot_payments_delete;
DROP TRIGGER IF EXISTS trg_reports_snapshot_appointments_insert;
DROP TRIGGER IF EXISTS trg_reports_snapshot_appointments_update;
DROP TRIGGER IF EXISTS trg_reports_snapshot_appointments_delete;
DROP TRIGGER IF EXISTS trg_reports_snapshot_attendance_insert;
DROP TRIGGER IF EXISTS trg_reports_snapshot_attendance_update;
DROP TRIGGER IF EXISTS trg_reports_snapshot_attendance_delete;
DROP TRIGGER IF EXISTS trg_reports_snapshot_ads_insert;
DROP TRIGGER IF EXISTS trg_reports_snapshot_ads_update;
DROP TRIGGER IF EXISTS trg_reports_snapshot_ads_delete;
DROP TRIGGER IF EXISTS trg_reports_snapshot_sessions_insert;
DROP TRIGGER IF EXISTS trg_reports_snapshot_sessions_update;
DROP TRIGGER IF EXISTS trg_reports_snapshot_sessions_delete;
DROP TRIGGER IF EXISTS trg_reports_snapshot_hidden_insert;
DROP TRIGGER IF EXISTS trg_reports_snapshot_hidden_update;
DROP TRIGGER IF EXISTS trg_reports_snapshot_hidden_delete;
DROP TRIGGER IF EXISTS trg_reports_snapshot_app_config_insert;
DROP TRIGGER IF EXISTS trg_reports_snapshot_app_config_update;
DROP TRIGGER IF EXISTS trg_reports_snapshot_app_config_delete;
DROP TRIGGER IF EXISTS trg_reports_snapshot_highlevel_insert;
DROP TRIGGER IF EXISTS trg_reports_snapshot_highlevel_update;
DROP TRIGGER IF EXISTS trg_reports_snapshot_highlevel_delete;

CREATE TRIGGER trg_reports_snapshot_contact_phones_insert
AFTER INSERT ON contact_phone_numbers BEGIN
  UPDATE reports_snapshot_revision SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE singleton = 1;
END;
CREATE TRIGGER trg_reports_snapshot_contact_phones_update
AFTER UPDATE OF contact_id, phone, is_primary, updated_at ON contact_phone_numbers BEGIN
  UPDATE reports_snapshot_revision SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE singleton = 1;
END;
CREATE TRIGGER trg_reports_snapshot_contact_phones_delete
AFTER DELETE ON contact_phone_numbers BEGIN
  UPDATE reports_snapshot_revision SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE singleton = 1;
END;

CREATE TRIGGER trg_reports_snapshot_hidden_insert
AFTER INSERT ON hidden_contact_filters BEGIN
  UPDATE reports_snapshot_revision SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE singleton = 1;
END;
CREATE TRIGGER trg_reports_snapshot_hidden_update
AFTER UPDATE OF filter_text, match_type ON hidden_contact_filters BEGIN
  UPDATE reports_snapshot_revision SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE singleton = 1;
END;
CREATE TRIGGER trg_reports_snapshot_hidden_delete
AFTER DELETE ON hidden_contact_filters BEGIN
  UPDATE reports_snapshot_revision SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE singleton = 1;
END;

CREATE TRIGGER trg_reports_snapshot_app_config_insert
AFTER INSERT ON app_config
WHEN NEW.config_key IN ('account_timezone', 'attribution_calendar_ids') BEGIN
  UPDATE reports_snapshot_revision SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE singleton = 1;
END;
CREATE TRIGGER trg_reports_snapshot_app_config_update
AFTER UPDATE OF config_key, config_value ON app_config
WHEN (
  OLD.config_key IN ('account_timezone', 'attribution_calendar_ids')
  OR NEW.config_key IN ('account_timezone', 'attribution_calendar_ids')
) AND (
  OLD.config_key IS NOT NEW.config_key
  OR OLD.config_value IS NOT NEW.config_value
) BEGIN
  UPDATE reports_snapshot_revision SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE singleton = 1;
END;
CREATE TRIGGER trg_reports_snapshot_app_config_delete
AFTER DELETE ON app_config
WHEN OLD.config_key IN ('account_timezone', 'attribution_calendar_ids') BEGIN
  UPDATE reports_snapshot_revision SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE singleton = 1;
END;

CREATE TRIGGER trg_reports_snapshot_highlevel_insert
AFTER INSERT ON highlevel_config BEGIN
  UPDATE reports_snapshot_revision SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE singleton = 1;
END;
CREATE TRIGGER trg_reports_snapshot_highlevel_update
AFTER UPDATE OF location_id, location_data ON highlevel_config BEGIN
  UPDATE reports_snapshot_revision SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE singleton = 1;
END;
CREATE TRIGGER trg_reports_snapshot_highlevel_delete
AFTER DELETE ON highlevel_config BEGIN
  UPDATE reports_snapshot_revision SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE singleton = 1;
END;
