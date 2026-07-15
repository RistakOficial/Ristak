-- Read model incremental exacto para el core de conversiones de Analiticas.
-- Los triggers sólo deduplican una llave de contacto; ningún write path agrega
-- historiales, consulta EXISTS ni recorre contactos.
CREATE TABLE IF NOT EXISTS tracking_conversion_projection_state (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  projection_version INTEGER NOT NULL DEFAULT 1,
  account_timezone TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'backfilling'
    CHECK (status IN ('backfilling', 'replaying', 'ready', 'failed')),
  backfill_cursor TEXT,
  backfill_complete INTEGER NOT NULL DEFAULT 0 CHECK (backfill_complete IN (0, 1)),
  processed_count INTEGER NOT NULL DEFAULT 0 CHECK (processed_count >= 0),
  last_applied_at TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO tracking_conversion_projection_state(
  singleton_id, projection_version, account_timezone, status, backfill_complete
) VALUES (1, 1, '', 'backfilling', 0)
ON CONFLICT(singleton_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS tracking_conversion_change_queue (
  contact_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  enqueued_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_tracking_conversion_queue_order
  ON tracking_conversion_change_queue(enqueued_at, contact_id);

CREATE TABLE IF NOT EXISTS tracking_conversion_contact_fact (
  contact_id TEXT PRIMARY KEY,
  projection_version INTEGER NOT NULL DEFAULT 1,
  contact_created_at TEXT NOT NULL,
  business_date TEXT NOT NULL,
  stage TEXT NOT NULL
    CHECK (stage IN ('prospect', 'appointment_scheduled', 'appointment_attended', 'customer')),
  registrations INTEGER NOT NULL DEFAULT 1 CHECK (registrations = 1),
  prospects INTEGER NOT NULL DEFAULT 0 CHECK (prospects IN (0, 1)),
  appointments INTEGER NOT NULL DEFAULT 0 CHECK (appointments IN (0, 1)),
  attendances INTEGER NOT NULL DEFAULT 0 CHECK (attendances IN (0, 1)),
  customers INTEGER NOT NULL DEFAULT 0 CHECK (customers IN (0, 1)),
  purchases INTEGER NOT NULL DEFAULT 0 CHECK (purchases >= 0),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_tracking_conversion_fact_date_stage
  ON tracking_conversion_contact_fact(business_date, stage, contact_id);

CREATE TABLE IF NOT EXISTS tracking_conversion_daily_rollup (
  business_date TEXT NOT NULL,
  stage TEXT NOT NULL
    CHECK (stage IN ('prospect', 'appointment_scheduled', 'appointment_attended', 'customer')),
  registrations INTEGER NOT NULL DEFAULT 0 CHECK (registrations >= 0),
  prospects INTEGER NOT NULL DEFAULT 0 CHECK (prospects >= 0),
  appointments INTEGER NOT NULL DEFAULT 0 CHECK (appointments >= 0),
  attendances INTEGER NOT NULL DEFAULT 0 CHECK (attendances >= 0),
  customers INTEGER NOT NULL DEFAULT 0 CHECK (customers >= 0),
  purchases INTEGER NOT NULL DEFAULT 0 CHECK (purchases >= 0),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (business_date, stage)
);
CREATE INDEX IF NOT EXISTS idx_tracking_conversion_daily_range
  ON tracking_conversion_daily_rollup(business_date, stage);

-- Contacto: elegibilidad, fecha de registro y cita guardada en la propia fila.
DROP TRIGGER IF EXISTS trg_tracking_conversion_contact_insert;
CREATE TRIGGER trg_tracking_conversion_contact_insert AFTER INSERT ON contacts BEGIN
  INSERT INTO tracking_conversion_change_queue(contact_id, revision, enqueued_at)
  VALUES (NEW.id, 1, CURRENT_TIMESTAMP)
  ON CONFLICT(contact_id) DO UPDATE SET
    revision = tracking_conversion_change_queue.revision + 1,
    enqueued_at = CURRENT_TIMESTAMP;
END;

DROP TRIGGER IF EXISTS trg_tracking_conversion_contact_update;
CREATE TRIGGER trg_tracking_conversion_contact_update
AFTER UPDATE OF id, visitor_id, source, created_at, appointment_date ON contacts
WHEN NEW.id IS NOT OLD.id
  OR NEW.visitor_id IS NOT OLD.visitor_id
  OR NEW.source IS NOT OLD.source
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.appointment_date IS NOT OLD.appointment_date
BEGIN
  INSERT INTO tracking_conversion_change_queue(contact_id, revision, enqueued_at)
  VALUES (OLD.id, 1, CURRENT_TIMESTAMP)
  ON CONFLICT(contact_id) DO UPDATE SET
    revision = tracking_conversion_change_queue.revision + 1,
    enqueued_at = CURRENT_TIMESTAMP;
  INSERT INTO tracking_conversion_change_queue(contact_id, revision, enqueued_at)
  SELECT NEW.id, 1, CURRENT_TIMESTAMP
  WHERE NEW.id IS NOT OLD.id
  ON CONFLICT(contact_id) DO UPDATE SET
    revision = tracking_conversion_change_queue.revision + 1,
    enqueued_at = CURRENT_TIMESTAMP;
END;

DROP TRIGGER IF EXISTS trg_tracking_conversion_contact_delete;
CREATE TRIGGER trg_tracking_conversion_contact_delete AFTER DELETE ON contacts BEGIN
  INSERT INTO tracking_conversion_change_queue(contact_id, revision, enqueued_at)
  VALUES (OLD.id, 1, CURRENT_TIMESTAMP)
  ON CONFLICT(contact_id) DO UPDATE SET
    revision = tracking_conversion_change_queue.revision + 1,
    enqueued_at = CURRENT_TIMESTAMP;
END;

-- Pagos/citas/asistencia ya aterrizan en esta fila angosta por triggers del
-- read model CRM. Esta segunda señal sólo encola el contacto afectado.
DROP TRIGGER IF EXISTS trg_tracking_conversion_activity_insert;
CREATE TRIGGER trg_tracking_conversion_activity_insert AFTER INSERT ON contact_list_activity BEGIN
  INSERT INTO tracking_conversion_change_queue(contact_id, revision, enqueued_at)
  VALUES (NEW.contact_id, 1, CURRENT_TIMESTAMP)
  ON CONFLICT(contact_id) DO UPDATE SET
    revision = tracking_conversion_change_queue.revision + 1,
    enqueued_at = CURRENT_TIMESTAMP;
END;

DROP TRIGGER IF EXISTS trg_tracking_conversion_activity_update;
CREATE TRIGGER trg_tracking_conversion_activity_update
AFTER UPDATE OF purchases_count, active_appointments_count,
  attended_appointments_count, attendance_signals_count
ON contact_list_activity
WHEN NEW.purchases_count IS NOT OLD.purchases_count
  OR NEW.active_appointments_count IS NOT OLD.active_appointments_count
  OR NEW.attended_appointments_count IS NOT OLD.attended_appointments_count
  OR NEW.attendance_signals_count IS NOT OLD.attendance_signals_count
BEGIN
  INSERT INTO tracking_conversion_change_queue(contact_id, revision, enqueued_at)
  VALUES (NEW.contact_id, 1, CURRENT_TIMESTAMP)
  ON CONFLICT(contact_id) DO UPDATE SET
    revision = tracking_conversion_change_queue.revision + 1,
    enqueued_at = CURRENT_TIMESTAMP;
END;

DROP TRIGGER IF EXISTS trg_tracking_conversion_activity_delete;
CREATE TRIGGER trg_tracking_conversion_activity_delete AFTER DELETE ON contact_list_activity BEGIN
  INSERT INTO tracking_conversion_change_queue(contact_id, revision, enqueued_at)
  VALUES (OLD.contact_id, 1, CURRENT_TIMESTAMP)
  ON CONFLICT(contact_id) DO UPDATE SET
    revision = tracking_conversion_change_queue.revision + 1,
    enqueued_at = CURRENT_TIMESTAMP;
END;

-- La presencia de cualquiera de estas filas vuelve elegible al contacto para
-- Analiticas. UPDATE encola ambas identidades cuando el vínculo cambia.
DROP TRIGGER IF EXISTS trg_tracking_conversion_whatsapp_message_insert;
CREATE TRIGGER trg_tracking_conversion_whatsapp_message_insert
AFTER INSERT ON whatsapp_api_messages WHEN NEW.contact_id IS NOT NULL AND NEW.contact_id != '' BEGIN
  INSERT INTO tracking_conversion_change_queue(contact_id, revision, enqueued_at)
  VALUES (NEW.contact_id, 1, CURRENT_TIMESTAMP)
  ON CONFLICT(contact_id) DO UPDATE SET revision = tracking_conversion_change_queue.revision + 1,
    enqueued_at = CURRENT_TIMESTAMP;
END;
DROP TRIGGER IF EXISTS trg_tracking_conversion_whatsapp_message_update;
CREATE TRIGGER trg_tracking_conversion_whatsapp_message_update
AFTER UPDATE OF contact_id ON whatsapp_api_messages WHEN NEW.contact_id IS NOT OLD.contact_id BEGIN
  INSERT INTO tracking_conversion_change_queue(contact_id, revision, enqueued_at)
  SELECT OLD.contact_id, 1, CURRENT_TIMESTAMP WHERE OLD.contact_id IS NOT NULL AND OLD.contact_id != ''
  ON CONFLICT(contact_id) DO UPDATE SET revision = tracking_conversion_change_queue.revision + 1,
    enqueued_at = CURRENT_TIMESTAMP;
  INSERT INTO tracking_conversion_change_queue(contact_id, revision, enqueued_at)
  SELECT NEW.contact_id, 1, CURRENT_TIMESTAMP WHERE NEW.contact_id IS NOT NULL AND NEW.contact_id != ''
  ON CONFLICT(contact_id) DO UPDATE SET revision = tracking_conversion_change_queue.revision + 1,
    enqueued_at = CURRENT_TIMESTAMP;
END;
DROP TRIGGER IF EXISTS trg_tracking_conversion_whatsapp_message_delete;
CREATE TRIGGER trg_tracking_conversion_whatsapp_message_delete
AFTER DELETE ON whatsapp_api_messages WHEN OLD.contact_id IS NOT NULL AND OLD.contact_id != '' BEGIN
  INSERT INTO tracking_conversion_change_queue(contact_id, revision, enqueued_at)
  VALUES (OLD.contact_id, 1, CURRENT_TIMESTAMP)
  ON CONFLICT(contact_id) DO UPDATE SET revision = tracking_conversion_change_queue.revision + 1,
    enqueued_at = CURRENT_TIMESTAMP;
END;

DROP TRIGGER IF EXISTS trg_tracking_conversion_api_attribution_insert;
CREATE TRIGGER trg_tracking_conversion_api_attribution_insert
AFTER INSERT ON whatsapp_api_attribution WHEN NEW.contact_id IS NOT NULL AND NEW.contact_id != '' BEGIN
  INSERT INTO tracking_conversion_change_queue(contact_id, revision, enqueued_at)
  VALUES (NEW.contact_id, 1, CURRENT_TIMESTAMP)
  ON CONFLICT(contact_id) DO UPDATE SET revision = tracking_conversion_change_queue.revision + 1,
    enqueued_at = CURRENT_TIMESTAMP;
END;
DROP TRIGGER IF EXISTS trg_tracking_conversion_api_attribution_update;
CREATE TRIGGER trg_tracking_conversion_api_attribution_update
AFTER UPDATE OF contact_id ON whatsapp_api_attribution WHEN NEW.contact_id IS NOT OLD.contact_id BEGIN
  INSERT INTO tracking_conversion_change_queue(contact_id, revision, enqueued_at)
  SELECT OLD.contact_id, 1, CURRENT_TIMESTAMP WHERE OLD.contact_id IS NOT NULL AND OLD.contact_id != ''
  ON CONFLICT(contact_id) DO UPDATE SET revision = tracking_conversion_change_queue.revision + 1,
    enqueued_at = CURRENT_TIMESTAMP;
  INSERT INTO tracking_conversion_change_queue(contact_id, revision, enqueued_at)
  SELECT NEW.contact_id, 1, CURRENT_TIMESTAMP WHERE NEW.contact_id IS NOT NULL AND NEW.contact_id != ''
  ON CONFLICT(contact_id) DO UPDATE SET revision = tracking_conversion_change_queue.revision + 1,
    enqueued_at = CURRENT_TIMESTAMP;
END;
DROP TRIGGER IF EXISTS trg_tracking_conversion_api_attribution_delete;
CREATE TRIGGER trg_tracking_conversion_api_attribution_delete
AFTER DELETE ON whatsapp_api_attribution WHEN OLD.contact_id IS NOT NULL AND OLD.contact_id != '' BEGIN
  INSERT INTO tracking_conversion_change_queue(contact_id, revision, enqueued_at)
  VALUES (OLD.contact_id, 1, CURRENT_TIMESTAMP)
  ON CONFLICT(contact_id) DO UPDATE SET revision = tracking_conversion_change_queue.revision + 1,
    enqueued_at = CURRENT_TIMESTAMP;
END;

DROP TRIGGER IF EXISTS trg_tracking_conversion_legacy_attribution_insert;
CREATE TRIGGER trg_tracking_conversion_legacy_attribution_insert
AFTER INSERT ON whatsapp_attribution WHEN NEW.contact_id IS NOT NULL AND NEW.contact_id != '' BEGIN
  INSERT INTO tracking_conversion_change_queue(contact_id, revision, enqueued_at)
  VALUES (NEW.contact_id, 1, CURRENT_TIMESTAMP)
  ON CONFLICT(contact_id) DO UPDATE SET revision = tracking_conversion_change_queue.revision + 1,
    enqueued_at = CURRENT_TIMESTAMP;
END;
DROP TRIGGER IF EXISTS trg_tracking_conversion_legacy_attribution_update;
CREATE TRIGGER trg_tracking_conversion_legacy_attribution_update
AFTER UPDATE OF contact_id ON whatsapp_attribution WHEN NEW.contact_id IS NOT OLD.contact_id BEGIN
  INSERT INTO tracking_conversion_change_queue(contact_id, revision, enqueued_at)
  SELECT OLD.contact_id, 1, CURRENT_TIMESTAMP WHERE OLD.contact_id IS NOT NULL AND OLD.contact_id != ''
  ON CONFLICT(contact_id) DO UPDATE SET revision = tracking_conversion_change_queue.revision + 1,
    enqueued_at = CURRENT_TIMESTAMP;
  INSERT INTO tracking_conversion_change_queue(contact_id, revision, enqueued_at)
  SELECT NEW.contact_id, 1, CURRENT_TIMESTAMP WHERE NEW.contact_id IS NOT NULL AND NEW.contact_id != ''
  ON CONFLICT(contact_id) DO UPDATE SET revision = tracking_conversion_change_queue.revision + 1,
    enqueued_at = CURRENT_TIMESTAMP;
END;
DROP TRIGGER IF EXISTS trg_tracking_conversion_legacy_attribution_delete;
CREATE TRIGGER trg_tracking_conversion_legacy_attribution_delete
AFTER DELETE ON whatsapp_attribution WHEN OLD.contact_id IS NOT NULL AND OLD.contact_id != '' BEGIN
  INSERT INTO tracking_conversion_change_queue(contact_id, revision, enqueued_at)
  VALUES (OLD.contact_id, 1, CURRENT_TIMESTAMP)
  ON CONFLICT(contact_id) DO UPDATE SET revision = tracking_conversion_change_queue.revision + 1,
    enqueued_at = CURRENT_TIMESTAMP;
END;
