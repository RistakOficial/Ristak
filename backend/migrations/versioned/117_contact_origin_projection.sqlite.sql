-- Read model exacto de los desgloses de origen usados por Dashboard/mobile.
-- Los triggers sólo coalescen llaves; el histórico se resuelve en el worker.
CREATE TABLE IF NOT EXISTS contact_origin_projection_state (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  projection_version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'backfilling'
    CHECK (status IN ('backfilling', 'replaying', 'ready', 'failed')),
  active_generation INTEGER,
  active_version INTEGER,
  active_timezone TEXT,
  building_generation INTEGER,
  building_version INTEGER,
  building_timezone TEXT,
  contact_cursor TEXT NOT NULL DEFAULT '',
  appointment_cursor TEXT NOT NULL DEFAULT '',
  contacts_complete INTEGER NOT NULL DEFAULT 0 CHECK (contacts_complete IN (0, 1)),
  appointments_complete INTEGER NOT NULL DEFAULT 0 CHECK (appointments_complete IN (0, 1)),
  range_compiled INTEGER NOT NULL DEFAULT 0 CHECK (range_compiled IN (0, 1)),
  processed_contacts INTEGER NOT NULL DEFAULT 0 CHECK (processed_contacts >= 0),
  processed_appointments INTEGER NOT NULL DEFAULT 0 CHECK (processed_appointments >= 0),
  last_applied_at TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO contact_origin_projection_state(singleton_id, projection_version, status)
VALUES (1, 1, 'backfilling')
ON CONFLICT(singleton_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS contact_origin_contact_queue (
  contact_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  enqueued_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_contact_origin_contact_queue_order
  ON contact_origin_contact_queue(enqueued_at, contact_id);

CREATE TABLE IF NOT EXISTS contact_origin_identity_queue (
  identity_kind TEXT NOT NULL CHECK (identity_kind IN ('contact', 'visitor', 'email')),
  identity_value TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  enqueued_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (identity_kind, identity_value)
);
CREATE INDEX IF NOT EXISTS idx_contact_origin_identity_queue_order
  ON contact_origin_identity_queue(enqueued_at, identity_kind, identity_value);

CREATE TABLE IF NOT EXISTS contact_origin_appointment_queue (
  appointment_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  enqueued_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_contact_origin_appointment_queue_order
  ON contact_origin_appointment_queue(enqueued_at, appointment_id);

CREATE TABLE IF NOT EXISTS contact_origin_contact_fact (
  generation INTEGER NOT NULL,
  contact_id TEXT NOT NULL,
  projection_version INTEGER NOT NULL,
  resolved_source TEXT NOT NULL,
  lead_business_date TEXT NOT NULL,
  first_payment_business_date TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (generation, contact_id)
);
CREATE INDEX IF NOT EXISTS idx_contact_origin_fact_lead
  ON contact_origin_contact_fact(generation, lead_business_date, resolved_source, contact_id);
CREATE INDEX IF NOT EXISTS idx_contact_origin_fact_conversion
  ON contact_origin_contact_fact(generation, first_payment_business_date, resolved_source, contact_id)
  WHERE first_payment_business_date IS NOT NULL;

CREATE TABLE IF NOT EXISTS contact_origin_daily_rollup (
  generation INTEGER NOT NULL,
  metric_kind TEXT NOT NULL CHECK (metric_kind IN ('leads', 'conversions')),
  business_date TEXT NOT NULL,
  resolved_source TEXT NOT NULL,
  contact_count INTEGER NOT NULL DEFAULT 0 CHECK (contact_count >= 0),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (generation, metric_kind, business_date, resolved_source)
);
CREATE INDEX IF NOT EXISTS idx_contact_origin_daily_query
  ON contact_origin_daily_rollup(generation, metric_kind, business_date, resolved_source, contact_count);

CREATE TABLE IF NOT EXISTS contact_origin_appointment_fact (
  generation INTEGER NOT NULL,
  appointment_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  business_date TEXT NOT NULL,
  calendar_id TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (generation, appointment_id)
);
CREATE INDEX IF NOT EXISTS idx_contact_origin_appointment_range
  ON contact_origin_appointment_fact(generation, business_date, calendar_id, contact_id);
CREATE INDEX IF NOT EXISTS idx_contact_origin_appointment_contact
  ON contact_origin_appointment_fact(generation, contact_id, business_date, calendar_id);

CREATE TABLE IF NOT EXISTS contact_origin_appointment_range_point (
  generation INTEGER NOT NULL,
  contact_id TEXT NOT NULL,
  resolved_source TEXT NOT NULL,
  start_boundary TEXT NOT NULL,
  occurrence_date TEXT NOT NULL,
  range_delta INTEGER NOT NULL CHECK (range_delta IN (-1, 1)),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (generation, contact_id, resolved_source, start_boundary, occurrence_date)
);
CREATE INDEX IF NOT EXISTS idx_contact_origin_appointment_point_contact
  ON contact_origin_appointment_range_point(generation, contact_id);

CREATE TABLE IF NOT EXISTS contact_origin_appointment_range_delta (
  generation INTEGER NOT NULL,
  resolved_source TEXT NOT NULL,
  start_boundary TEXT NOT NULL,
  occurrence_date TEXT NOT NULL,
  range_delta INTEGER NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (generation, resolved_source, start_boundary, occurrence_date)
);
CREATE INDEX IF NOT EXISTS idx_contact_origin_appointment_delta_query
  ON contact_origin_appointment_range_delta(
    generation, start_boundary, occurrence_date, resolved_source, range_delta
  );

CREATE TABLE IF NOT EXISTS contact_origin_range_generation (
  generation INTEGER PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'building' CHECK (status IN ('building', 'ready')),
  built_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS contact_origin_generation_gc (
  generation INTEGER PRIMARY KEY,
  eligible_at TEXT NOT NULL,
  enqueued_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_contact_origin_generation_gc_due
  ON contact_origin_generation_gc(eligible_at, generation);

-- Las sesiones sin contact_id se relacionan por visitor/email. Estos dos
-- índices convierten cada llave de la cola en probes acotados; sin ellos un
-- solo cambio de sesión podría volver a barrer toda la tabla de contactos.
CREATE INDEX IF NOT EXISTS idx_contact_origin_contacts_visitor_lookup
  ON contacts(visitor_id)
  WHERE visitor_id IS NOT NULL AND visitor_id != '';
CREATE INDEX IF NOT EXISTS idx_contact_origin_contacts_email_lookup
  ON contacts(LOWER(email))
  WHERE email IS NOT NULL AND email != '';

-- Contactos: fuente, identidades y fecha de alta.
DROP TRIGGER IF EXISTS trg_contact_origin_contact_insert;
CREATE TRIGGER trg_contact_origin_contact_insert AFTER INSERT ON contacts BEGIN
  INSERT INTO contact_origin_contact_queue(contact_id, revision, enqueued_at)
  VALUES (NEW.id, 1, CURRENT_TIMESTAMP)
  ON CONFLICT(contact_id) DO UPDATE SET
    revision = contact_origin_contact_queue.revision + 1,
    enqueued_at = CURRENT_TIMESTAMP;
END;

DROP TRIGGER IF EXISTS trg_contact_origin_contact_update;
CREATE TRIGGER trg_contact_origin_contact_update
AFTER UPDATE OF id, source, visitor_id, email, attribution_url,
  attribution_session_source, attribution_medium, attribution_ctwa_clid,
  attribution_ad_id, created_at ON contacts
WHEN NEW.id IS NOT OLD.id
  OR NEW.source IS NOT OLD.source
  OR NEW.visitor_id IS NOT OLD.visitor_id
  OR NEW.email IS NOT OLD.email
  OR NEW.attribution_url IS NOT OLD.attribution_url
  OR NEW.attribution_session_source IS NOT OLD.attribution_session_source
  OR NEW.attribution_medium IS NOT OLD.attribution_medium
  OR NEW.attribution_ctwa_clid IS NOT OLD.attribution_ctwa_clid
  OR NEW.attribution_ad_id IS NOT OLD.attribution_ad_id
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  INSERT INTO contact_origin_contact_queue(contact_id, revision, enqueued_at)
  VALUES (OLD.id, 1, CURRENT_TIMESTAMP)
  ON CONFLICT(contact_id) DO UPDATE SET revision = contact_origin_contact_queue.revision + 1,
    enqueued_at = CURRENT_TIMESTAMP;
  INSERT INTO contact_origin_contact_queue(contact_id, revision, enqueued_at)
  SELECT NEW.id, 1, CURRENT_TIMESTAMP WHERE NEW.id IS NOT OLD.id
  ON CONFLICT(contact_id) DO UPDATE SET revision = contact_origin_contact_queue.revision + 1,
    enqueued_at = CURRENT_TIMESTAMP;
END;

DROP TRIGGER IF EXISTS trg_contact_origin_contact_delete;
CREATE TRIGGER trg_contact_origin_contact_delete AFTER DELETE ON contacts BEGIN
  INSERT INTO contact_origin_contact_queue(contact_id, revision, enqueued_at)
  VALUES (OLD.id, 1, CURRENT_TIMESTAMP)
  ON CONFLICT(contact_id) DO UPDATE SET revision = contact_origin_contact_queue.revision + 1,
    enqueued_at = CURRENT_TIMESTAMP;
END;

-- Primer pago proyectado: sólo encola el contacto afectado.
DROP TRIGGER IF EXISTS trg_contact_origin_activity_insert;
CREATE TRIGGER trg_contact_origin_activity_insert AFTER INSERT ON contact_list_activity BEGIN
  INSERT INTO contact_origin_contact_queue(contact_id, revision, enqueued_at)
  VALUES (NEW.contact_id, 1, CURRENT_TIMESTAMP)
  ON CONFLICT(contact_id) DO UPDATE SET revision = contact_origin_contact_queue.revision + 1,
    enqueued_at = CURRENT_TIMESTAMP;
END;
DROP TRIGGER IF EXISTS trg_contact_origin_activity_update;
CREATE TRIGGER trg_contact_origin_activity_update
AFTER UPDATE OF contact_id, first_payment_date ON contact_list_activity
WHEN NEW.contact_id IS NOT OLD.contact_id OR NEW.first_payment_date IS NOT OLD.first_payment_date
BEGIN
  INSERT INTO contact_origin_contact_queue(contact_id, revision, enqueued_at)
  VALUES (OLD.contact_id, 1, CURRENT_TIMESTAMP)
  ON CONFLICT(contact_id) DO UPDATE SET revision = contact_origin_contact_queue.revision + 1,
    enqueued_at = CURRENT_TIMESTAMP;
  INSERT INTO contact_origin_contact_queue(contact_id, revision, enqueued_at)
  SELECT NEW.contact_id, 1, CURRENT_TIMESTAMP WHERE NEW.contact_id IS NOT OLD.contact_id
  ON CONFLICT(contact_id) DO UPDATE SET revision = contact_origin_contact_queue.revision + 1,
    enqueued_at = CURRENT_TIMESTAMP;
END;
DROP TRIGGER IF EXISTS trg_contact_origin_activity_delete;
CREATE TRIGGER trg_contact_origin_activity_delete AFTER DELETE ON contact_list_activity BEGIN
  INSERT INTO contact_origin_contact_queue(contact_id, revision, enqueued_at)
  VALUES (OLD.contact_id, 1, CURRENT_TIMESTAMP)
  ON CONFLICT(contact_id) DO UPDATE SET revision = contact_origin_contact_queue.revision + 1,
    enqueued_at = CURRENT_TIMESTAMP;
END;

-- Las sesiones encolan identidades old/new. El worker resuelve contactos con
-- índices; el trigger jamás recorre contacts ni historiales.
DROP TRIGGER IF EXISTS trg_contact_origin_session_insert;
CREATE TRIGGER trg_contact_origin_session_insert AFTER INSERT ON sessions BEGIN
  INSERT INTO contact_origin_identity_queue(identity_kind, identity_value, revision, enqueued_at)
  SELECT kind, value, 1, CURRENT_TIMESTAMP
  FROM (
    SELECT 'contact' AS kind, CAST(NEW.contact_id AS TEXT) AS value
    UNION ALL SELECT 'visitor', CAST(NEW.visitor_id AS TEXT)
    UNION ALL SELECT 'email', LOWER(TRIM(CAST(NEW.email AS TEXT)))
  ) identities
  WHERE value IS NOT NULL AND value != ''
  ON CONFLICT(identity_kind, identity_value) DO UPDATE SET
    revision = contact_origin_identity_queue.revision + 1,
    enqueued_at = CURRENT_TIMESTAMP;
END;
DROP TRIGGER IF EXISTS trg_contact_origin_session_update;
CREATE TRIGGER trg_contact_origin_session_update
AFTER UPDATE OF id, contact_id, visitor_id, email, started_at, created_at,
  referrer_url, site_source_name, utm_source, source_platform ON sessions
WHEN NEW.id IS NOT OLD.id
  OR NEW.contact_id IS NOT OLD.contact_id OR NEW.visitor_id IS NOT OLD.visitor_id
  OR NEW.email IS NOT OLD.email OR NEW.started_at IS NOT OLD.started_at
  OR NEW.created_at IS NOT OLD.created_at OR NEW.referrer_url IS NOT OLD.referrer_url
  OR NEW.site_source_name IS NOT OLD.site_source_name OR NEW.utm_source IS NOT OLD.utm_source
  OR NEW.source_platform IS NOT OLD.source_platform
BEGIN
  INSERT INTO contact_origin_identity_queue(identity_kind, identity_value, revision, enqueued_at)
  SELECT kind, value, 1, CURRENT_TIMESTAMP
  FROM (
    SELECT 'contact' AS kind, CAST(OLD.contact_id AS TEXT) AS value
    UNION ALL SELECT 'contact', CAST(NEW.contact_id AS TEXT)
    UNION ALL SELECT 'visitor', CAST(OLD.visitor_id AS TEXT)
    UNION ALL SELECT 'visitor', CAST(NEW.visitor_id AS TEXT)
    UNION ALL SELECT 'email', LOWER(TRIM(CAST(OLD.email AS TEXT)))
    UNION ALL SELECT 'email', LOWER(TRIM(CAST(NEW.email AS TEXT)))
  ) identities
  WHERE value IS NOT NULL AND value != ''
  ON CONFLICT(identity_kind, identity_value) DO UPDATE SET
    revision = contact_origin_identity_queue.revision + 1,
    enqueued_at = CURRENT_TIMESTAMP;
END;
DROP TRIGGER IF EXISTS trg_contact_origin_session_delete;
CREATE TRIGGER trg_contact_origin_session_delete AFTER DELETE ON sessions BEGIN
  INSERT INTO contact_origin_identity_queue(identity_kind, identity_value, revision, enqueued_at)
  SELECT kind, value, 1, CURRENT_TIMESTAMP
  FROM (
    SELECT 'contact' AS kind, CAST(OLD.contact_id AS TEXT) AS value
    UNION ALL SELECT 'visitor', CAST(OLD.visitor_id AS TEXT)
    UNION ALL SELECT 'email', LOWER(TRIM(CAST(OLD.email AS TEXT)))
  ) identities
  WHERE value IS NOT NULL AND value != ''
  ON CONFLICT(identity_kind, identity_value) DO UPDATE SET
    revision = contact_origin_identity_queue.revision + 1,
    enqueued_at = CURRENT_TIMESTAMP;
END;

-- Citas: la fila proyectada conserva old/new por appointment_id.
DROP TRIGGER IF EXISTS trg_contact_origin_appointment_insert;
CREATE TRIGGER trg_contact_origin_appointment_insert AFTER INSERT ON appointments BEGIN
  INSERT INTO contact_origin_appointment_queue(appointment_id, revision, enqueued_at)
  VALUES (NEW.id, 1, CURRENT_TIMESTAMP)
  ON CONFLICT(appointment_id) DO UPDATE SET revision = contact_origin_appointment_queue.revision + 1,
    enqueued_at = CURRENT_TIMESTAMP;
END;
DROP TRIGGER IF EXISTS trg_contact_origin_appointment_update;
CREATE TRIGGER trg_contact_origin_appointment_update
AFTER UPDATE OF id, contact_id, date_added, calendar_id ON appointments
WHEN NEW.id IS NOT OLD.id OR NEW.contact_id IS NOT OLD.contact_id
  OR NEW.date_added IS NOT OLD.date_added OR NEW.calendar_id IS NOT OLD.calendar_id
BEGIN
  INSERT INTO contact_origin_appointment_queue(appointment_id, revision, enqueued_at)
  VALUES (OLD.id, 1, CURRENT_TIMESTAMP)
  ON CONFLICT(appointment_id) DO UPDATE SET revision = contact_origin_appointment_queue.revision + 1,
    enqueued_at = CURRENT_TIMESTAMP;
  INSERT INTO contact_origin_appointment_queue(appointment_id, revision, enqueued_at)
  SELECT NEW.id, 1, CURRENT_TIMESTAMP WHERE NEW.id IS NOT OLD.id
  ON CONFLICT(appointment_id) DO UPDATE SET revision = contact_origin_appointment_queue.revision + 1,
    enqueued_at = CURRENT_TIMESTAMP;
END;
DROP TRIGGER IF EXISTS trg_contact_origin_appointment_delete;
CREATE TRIGGER trg_contact_origin_appointment_delete AFTER DELETE ON appointments BEGIN
  INSERT INTO contact_origin_appointment_queue(appointment_id, revision, enqueued_at)
  VALUES (OLD.id, 1, CURRENT_TIMESTAMP)
  ON CONFLICT(appointment_id) DO UPDATE SET revision = contact_origin_appointment_queue.revision + 1,
    enqueued_at = CURRENT_TIMESTAMP;
END;

-- El tráfico normal de chat no afecta origen. Solo una entrada inbound con
-- señal útil (o un cambio explícito de contact_id) encola reconciliación.
DROP TRIGGER IF EXISTS trg_contact_origin_whatsapp_message_insert;
CREATE TRIGGER trg_contact_origin_whatsapp_message_insert AFTER INSERT ON whatsapp_api_messages
WHEN NEW.contact_id IS NOT NULL AND NEW.contact_id != ''
  AND LOWER(COALESCE(NEW.direction, '')) = 'inbound'
  AND COALESCE(
    NULLIF(TRIM(COALESCE(NEW.detected_ctwa_clid, '')), ''),
    NULLIF(TRIM(COALESCE(NEW.detected_source_id, '')), ''),
    NULLIF(TRIM(COALESCE(NEW.detected_source_url, '')), ''),
    NULLIF(TRIM(COALESCE(NEW.detected_source_type, '')), ''),
    NULLIF(TRIM(COALESCE(NEW.detected_source_app, '')), ''),
    NULLIF(TRIM(COALESCE(NEW.detected_entry_point, '')), ''),
    NULLIF(TRIM(COALESCE(NEW.detected_headline, '')), '')
  ) IS NOT NULL
BEGIN
  INSERT INTO contact_origin_contact_queue(contact_id, revision, enqueued_at)
  VALUES (NEW.contact_id, 1, CURRENT_TIMESTAMP)
  ON CONFLICT(contact_id) DO UPDATE SET revision = contact_origin_contact_queue.revision + 1,
    enqueued_at = CURRENT_TIMESTAMP;
END;
DROP TRIGGER IF EXISTS trg_contact_origin_whatsapp_message_update;
CREATE TRIGGER trg_contact_origin_whatsapp_message_update
AFTER UPDATE OF contact_id, direction, message_timestamp, created_at,
  detected_ctwa_clid, detected_source_id, detected_source_url,
  detected_source_type, detected_source_app, detected_entry_point,
  detected_headline ON whatsapp_api_messages
WHEN NEW.contact_id IS NOT OLD.contact_id OR NEW.direction IS NOT OLD.direction
  OR NEW.message_timestamp IS NOT OLD.message_timestamp OR NEW.created_at IS NOT OLD.created_at
  OR NEW.detected_ctwa_clid IS NOT OLD.detected_ctwa_clid
  OR NEW.detected_source_id IS NOT OLD.detected_source_id
  OR NEW.detected_source_url IS NOT OLD.detected_source_url
  OR NEW.detected_source_type IS NOT OLD.detected_source_type
  OR NEW.detected_source_app IS NOT OLD.detected_source_app
  OR NEW.detected_entry_point IS NOT OLD.detected_entry_point
  OR NEW.detected_headline IS NOT OLD.detected_headline
BEGIN
  INSERT INTO contact_origin_contact_queue(contact_id, revision, enqueued_at)
  SELECT contact_id, 1, CURRENT_TIMESTAMP FROM (
    SELECT OLD.contact_id AS contact_id
    WHERE NEW.contact_id IS NOT OLD.contact_id OR (
      LOWER(COALESCE(OLD.direction, '')) = 'inbound'
      AND COALESCE(
        NULLIF(TRIM(COALESCE(OLD.detected_ctwa_clid, '')), ''),
        NULLIF(TRIM(COALESCE(OLD.detected_source_id, '')), ''),
        NULLIF(TRIM(COALESCE(OLD.detected_source_url, '')), ''),
        NULLIF(TRIM(COALESCE(OLD.detected_source_type, '')), ''),
        NULLIF(TRIM(COALESCE(OLD.detected_source_app, '')), ''),
        NULLIF(TRIM(COALESCE(OLD.detected_entry_point, '')), ''),
        NULLIF(TRIM(COALESCE(OLD.detected_headline, '')), '')
      ) IS NOT NULL
    )
    UNION
    SELECT NEW.contact_id
    WHERE NEW.contact_id IS NOT OLD.contact_id OR (
      LOWER(COALESCE(NEW.direction, '')) = 'inbound'
      AND COALESCE(
        NULLIF(TRIM(COALESCE(NEW.detected_ctwa_clid, '')), ''),
        NULLIF(TRIM(COALESCE(NEW.detected_source_id, '')), ''),
        NULLIF(TRIM(COALESCE(NEW.detected_source_url, '')), ''),
        NULLIF(TRIM(COALESCE(NEW.detected_source_type, '')), ''),
        NULLIF(TRIM(COALESCE(NEW.detected_source_app, '')), ''),
        NULLIF(TRIM(COALESCE(NEW.detected_entry_point, '')), ''),
        NULLIF(TRIM(COALESCE(NEW.detected_headline, '')), '')
      ) IS NOT NULL
    )
  ) changed WHERE contact_id IS NOT NULL AND contact_id != ''
  ON CONFLICT(contact_id) DO UPDATE SET revision = contact_origin_contact_queue.revision + 1,
    enqueued_at = CURRENT_TIMESTAMP;
END;
DROP TRIGGER IF EXISTS trg_contact_origin_whatsapp_message_delete;
CREATE TRIGGER trg_contact_origin_whatsapp_message_delete AFTER DELETE ON whatsapp_api_messages
WHEN OLD.contact_id IS NOT NULL AND OLD.contact_id != ''
  AND LOWER(COALESCE(OLD.direction, '')) = 'inbound'
  AND COALESCE(
    NULLIF(TRIM(COALESCE(OLD.detected_ctwa_clid, '')), ''),
    NULLIF(TRIM(COALESCE(OLD.detected_source_id, '')), ''),
    NULLIF(TRIM(COALESCE(OLD.detected_source_url, '')), ''),
    NULLIF(TRIM(COALESCE(OLD.detected_source_type, '')), ''),
    NULLIF(TRIM(COALESCE(OLD.detected_source_app, '')), ''),
    NULLIF(TRIM(COALESCE(OLD.detected_entry_point, '')), ''),
    NULLIF(TRIM(COALESCE(OLD.detected_headline, '')), '')
  ) IS NOT NULL
BEGIN
  INSERT INTO contact_origin_contact_queue(contact_id, revision, enqueued_at)
  VALUES (OLD.contact_id, 1, CURRENT_TIMESTAMP)
  ON CONFLICT(contact_id) DO UPDATE SET revision = contact_origin_contact_queue.revision + 1,
    enqueued_at = CURRENT_TIMESTAMP;
END;

DROP TRIGGER IF EXISTS trg_contact_origin_api_attribution_insert;
CREATE TRIGGER trg_contact_origin_api_attribution_insert AFTER INSERT ON whatsapp_api_attribution
BEGIN
  INSERT INTO contact_origin_contact_queue(contact_id, revision, enqueued_at)
  SELECT contact_id, 1, CURRENT_TIMESTAMP
  FROM (
    SELECT NEW.contact_id AS contact_id
    UNION
    SELECT msg.contact_id
    FROM whatsapp_api_messages msg
    WHERE msg.id = NEW.whatsapp_api_message_id
  ) affected
  WHERE contact_id IS NOT NULL AND contact_id != ''
  ON CONFLICT(contact_id) DO UPDATE SET revision = contact_origin_contact_queue.revision + 1,
    enqueued_at = CURRENT_TIMESTAMP;
END;
DROP TRIGGER IF EXISTS trg_contact_origin_api_attribution_update;
CREATE TRIGGER trg_contact_origin_api_attribution_update
AFTER UPDATE OF contact_id, whatsapp_api_message_id, detected_source_id,
  detected_ctwa_clid, detected_source_url, detected_source_type,
  detected_source_app, detected_entry_point, detected_headline, created_at
ON whatsapp_api_attribution
WHEN NEW.contact_id IS NOT OLD.contact_id
  OR NEW.whatsapp_api_message_id IS NOT OLD.whatsapp_api_message_id
  OR NEW.detected_source_id IS NOT OLD.detected_source_id
  OR NEW.detected_ctwa_clid IS NOT OLD.detected_ctwa_clid
  OR NEW.detected_source_url IS NOT OLD.detected_source_url
  OR NEW.detected_source_type IS NOT OLD.detected_source_type
  OR NEW.detected_source_app IS NOT OLD.detected_source_app
  OR NEW.detected_entry_point IS NOT OLD.detected_entry_point
  OR NEW.detected_headline IS NOT OLD.detected_headline
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  INSERT INTO contact_origin_contact_queue(contact_id, revision, enqueued_at)
  SELECT contact_id, 1, CURRENT_TIMESTAMP FROM (
    SELECT OLD.contact_id AS contact_id
    UNION SELECT NEW.contact_id
    UNION SELECT msg.contact_id FROM whatsapp_api_messages msg
      WHERE msg.id = OLD.whatsapp_api_message_id
    UNION SELECT msg.contact_id FROM whatsapp_api_messages msg
      WHERE msg.id = NEW.whatsapp_api_message_id
  ) changed WHERE contact_id IS NOT NULL AND contact_id != ''
  ON CONFLICT(contact_id) DO UPDATE SET revision = contact_origin_contact_queue.revision + 1,
    enqueued_at = CURRENT_TIMESTAMP;
END;
DROP TRIGGER IF EXISTS trg_contact_origin_api_attribution_delete;
CREATE TRIGGER trg_contact_origin_api_attribution_delete AFTER DELETE ON whatsapp_api_attribution
BEGIN
  INSERT INTO contact_origin_contact_queue(contact_id, revision, enqueued_at)
  SELECT contact_id, 1, CURRENT_TIMESTAMP
  FROM (
    SELECT OLD.contact_id AS contact_id
    UNION
    SELECT msg.contact_id
    FROM whatsapp_api_messages msg
    WHERE msg.id = OLD.whatsapp_api_message_id
  ) affected
  WHERE contact_id IS NOT NULL AND contact_id != ''
  ON CONFLICT(contact_id) DO UPDATE SET revision = contact_origin_contact_queue.revision + 1,
    enqueued_at = CURRENT_TIMESTAMP;
END;

DROP TRIGGER IF EXISTS trg_contact_origin_official_attribution_insert;
CREATE TRIGGER trg_contact_origin_official_attribution_insert AFTER INSERT ON whatsapp_attribution
WHEN NEW.contact_id IS NOT NULL AND NEW.contact_id != '' BEGIN
  INSERT INTO contact_origin_contact_queue(contact_id, revision, enqueued_at)
  VALUES (NEW.contact_id, 1, CURRENT_TIMESTAMP)
  ON CONFLICT(contact_id) DO UPDATE SET revision = contact_origin_contact_queue.revision + 1,
    enqueued_at = CURRENT_TIMESTAMP;
END;
DROP TRIGGER IF EXISTS trg_contact_origin_official_attribution_update;
CREATE TRIGGER trg_contact_origin_official_attribution_update
AFTER UPDATE OF contact_id, referral_source_url, referral_source_type,
  referral_source_id, referral_ctwa_clid, ad_id_thru_message, created_at
ON whatsapp_attribution
WHEN NEW.contact_id IS NOT OLD.contact_id
  OR NEW.referral_source_url IS NOT OLD.referral_source_url
  OR NEW.referral_source_type IS NOT OLD.referral_source_type
  OR NEW.referral_source_id IS NOT OLD.referral_source_id
  OR NEW.referral_ctwa_clid IS NOT OLD.referral_ctwa_clid
  OR NEW.ad_id_thru_message IS NOT OLD.ad_id_thru_message
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  INSERT INTO contact_origin_contact_queue(contact_id, revision, enqueued_at)
  SELECT contact_id, 1, CURRENT_TIMESTAMP FROM (
    SELECT OLD.contact_id AS contact_id UNION SELECT NEW.contact_id
  ) changed WHERE contact_id IS NOT NULL AND contact_id != ''
  ON CONFLICT(contact_id) DO UPDATE SET revision = contact_origin_contact_queue.revision + 1,
    enqueued_at = CURRENT_TIMESTAMP;
END;
DROP TRIGGER IF EXISTS trg_contact_origin_official_attribution_delete;
CREATE TRIGGER trg_contact_origin_official_attribution_delete AFTER DELETE ON whatsapp_attribution
WHEN OLD.contact_id IS NOT NULL AND OLD.contact_id != '' BEGIN
  INSERT INTO contact_origin_contact_queue(contact_id, revision, enqueued_at)
  VALUES (OLD.contact_id, 1, CURRENT_TIMESTAMP)
  ON CONFLICT(contact_id) DO UPDATE SET revision = contact_origin_contact_queue.revision + 1,
    enqueued_at = CURRENT_TIMESTAMP;
END;
