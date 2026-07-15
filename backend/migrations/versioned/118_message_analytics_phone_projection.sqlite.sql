-- Extiende el ledger generacional de 114/115 para el desglose por numero.
-- No crea otra cola ni otro worker: cada cambio de WhatsApp sigue entrando por
-- message_analytics_change_queue y se publica con el mismo cutover.
CREATE TABLE IF NOT EXISTS message_analytics_phone_fact (
  generation INTEGER NOT NULL,
  source_message_id TEXT NOT NULL,
  projection_version INTEGER NOT NULL,
  included INTEGER NOT NULL DEFAULT 0 CHECK (included IN (0, 1)),
  occurred_at TEXT,
  business_date TEXT,
  identity_key TEXT NOT NULL DEFAULT '',
  contact_id TEXT,
  contact_key TEXT NOT NULL DEFAULT '',
  business_phone_key TEXT NOT NULL DEFAULT '',
  business_phone_number_id TEXT NOT NULL DEFAULT '',
  business_phone_number TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (generation, source_message_id)
);
CREATE INDEX IF NOT EXISTS idx_message_analytics_phone_fact_contact
  ON message_analytics_phone_fact(generation, contact_id, business_date)
  WHERE included = 1 AND contact_id IS NOT NULL;

-- Una fila por identidad/numero/dia. message_count conserva la multiplicidad
-- para que INSERT/UPDATE/DELETE crucen presencia exactamente una vez.
CREATE TABLE IF NOT EXISTS message_analytics_daily_phone_identity (
  generation INTEGER NOT NULL,
  business_date TEXT NOT NULL,
  business_phone_key TEXT NOT NULL,
  identity_key TEXT NOT NULL,
  contact_key TEXT NOT NULL DEFAULT '',
  contact_id TEXT,
  message_count INTEGER NOT NULL DEFAULT 0 CHECK (message_count >= 0),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (
    generation, business_date, business_phone_key, identity_key, contact_key
  )
);
CREATE INDEX IF NOT EXISTS idx_message_analytics_daily_phone_identity_range
  ON message_analytics_daily_phone_identity(
    generation, business_phone_key, identity_key, business_date
  );
CREATE INDEX IF NOT EXISTS idx_message_analytics_daily_phone_identity_contact
  ON message_analytics_daily_phone_identity(
    generation, contact_id, business_date, business_phone_key, identity_key
  )
  WHERE contact_id IS NOT NULL;

-- Metadata diaria de cardinalidad acotada. Permite resolver los fallbacks del
-- payload sin recorrer identidades ni volver a whatsapp_api_messages.
CREATE TABLE IF NOT EXISTS message_analytics_daily_phone_metadata (
  generation INTEGER NOT NULL,
  business_date TEXT NOT NULL,
  business_phone_key TEXT NOT NULL,
  business_phone_number_id TEXT NOT NULL DEFAULT '',
  business_phone_number TEXT NOT NULL DEFAULT '',
  message_count INTEGER NOT NULL DEFAULT 0 CHECK (message_count >= 0),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (
    generation, business_date, business_phone_key,
    business_phone_number_id, business_phone_number
  )
);
CREATE INDEX IF NOT EXISTS idx_message_analytics_daily_phone_metadata_range
  ON message_analytics_daily_phone_metadata(
    generation, business_phone_key, business_date,
    business_phone_number_id, business_phone_number
  );

-- Dos puntos de diferencia por aparicion de identidad/numero. El query de un
-- rango suma solamente el grid ya agregado, nunca mensajes crudos.
CREATE TABLE IF NOT EXISTS message_analytics_phone_range_delta (
  generation INTEGER NOT NULL,
  business_phone_key TEXT NOT NULL,
  start_boundary TEXT NOT NULL,
  occurrence_date TEXT NOT NULL,
  range_delta INTEGER NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (
    generation, business_phone_key, start_boundary, occurrence_date
  )
);
CREATE INDEX IF NOT EXISTS idx_message_analytics_phone_range_delta_query
  ON message_analytics_phone_range_delta(
    generation, start_boundary, occurrence_date,
    business_phone_key, range_delta
  );

-- 114 no observaba estos dos campos. Se reemplaza solo el trigger de UPDATE;
-- INSERT y DELETE ya encolaban la llave correcta en O(1).
DROP TRIGGER IF EXISTS trg_message_analytics_whatsapp_update;
CREATE TRIGGER trg_message_analytics_whatsapp_update
AFTER UPDATE OF contact_id, phone, whatsapp_api_contact_id, direction,
  message_timestamp, created_at, business_phone, business_phone_number_id,
  detected_ctwa_clid, detected_source_id, detected_source_url,
  detected_source_type, detected_source_app, detected_entry_point
ON whatsapp_api_messages
WHEN NEW.contact_id IS NOT OLD.contact_id
  OR NEW.phone IS NOT OLD.phone
  OR NEW.whatsapp_api_contact_id IS NOT OLD.whatsapp_api_contact_id
  OR NEW.direction IS NOT OLD.direction
  OR NEW.message_timestamp IS NOT OLD.message_timestamp
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.business_phone IS NOT OLD.business_phone
  OR NEW.business_phone_number_id IS NOT OLD.business_phone_number_id
  OR NEW.detected_ctwa_clid IS NOT OLD.detected_ctwa_clid
  OR NEW.detected_source_id IS NOT OLD.detected_source_id
  OR NEW.detected_source_url IS NOT OLD.detected_source_url
  OR NEW.detected_source_type IS NOT OLD.detected_source_type
  OR NEW.detected_source_app IS NOT OLD.detected_source_app
  OR NEW.detected_entry_point IS NOT OLD.detected_entry_point
BEGIN
  INSERT INTO message_analytics_change_queue(source_kind, source_message_id, revision, enqueued_at)
  VALUES ('whatsapp', NEW.id, 1, CURRENT_TIMESTAMP)
  ON CONFLICT(source_kind, source_message_id) DO UPDATE SET
    revision = message_analytics_change_queue.revision + 1,
    enqueued_at = CURRENT_TIMESTAMP;
END;
