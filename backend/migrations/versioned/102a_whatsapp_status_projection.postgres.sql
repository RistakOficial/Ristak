CREATE TABLE IF NOT EXISTS whatsapp_status_metric_counters (
  metric TEXT NOT NULL,
  shard SMALLINT NOT NULL DEFAULT 0,
  counter_value BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (metric, shard)
);

CREATE TABLE IF NOT EXISTS whatsapp_status_projection_state (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  projection_version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'backfilling'
    CHECK (status IN ('backfilling', 'replaying', 'ready', 'failed')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO whatsapp_status_projection_state (singleton_id, projection_version, status)
VALUES (1, 1, 'backfilling')
ON CONFLICT(singleton_id) DO UPDATE SET
  projection_version = EXCLUDED.projection_version,
  status = CASE
    WHEN whatsapp_status_projection_state.projection_version = EXCLUDED.projection_version
      AND whatsapp_status_projection_state.status = 'ready'
    THEN 'ready'
    ELSE 'backfilling'
  END,
  updated_at = CURRENT_TIMESTAMP;

CREATE TABLE IF NOT EXISTS whatsapp_status_metric_deltas (
  id BIGSERIAL PRIMARY KEY,
  metric TEXT NOT NULL,
  shard SMALLINT NOT NULL,
  delta BIGINT NOT NULL,
  applied BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS whatsapp_status_routing_deltas (
  id BIGSERIAL PRIMARY KEY,
  contact_id TEXT NOT NULL,
  applied BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_status_metric_deltas_pending
  ON whatsapp_status_metric_deltas(id)
  WHERE applied = FALSE;
CREATE INDEX IF NOT EXISTS idx_whatsapp_status_routing_deltas_pending
  ON whatsapp_status_routing_deltas(id)
  WHERE applied = FALSE;

INSERT INTO whatsapp_status_metric_counters (metric, shard, counter_value)
SELECT metric, 0, 0
FROM (VALUES
  ('phone_numbers'), ('contacts'), ('messages'), ('inbound_messages'),
  ('outbound_messages'), ('attributed_messages'), ('webhook_events'),
  ('templates'), ('approved_templates'), ('active_alerts'),
  ('critical_alerts'), ('template_sends')
) AS metrics(metric)
ON CONFLICT(metric, shard) DO NOTHING;

CREATE TABLE IF NOT EXISTS whatsapp_routing_latest_projection (
  contact_id TEXT PRIMARY KEY,
  latest_event_id TEXT NOT NULL,
  previous_phone_number_id TEXT,
  new_phone_number_id TEXT,
  source TEXT NOT NULL DEFAULT '',
  event_created_at TIMESTAMP NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS whatsapp_contingency_restore_counts (
  previous_phone_number_id TEXT PRIMARY KEY,
  contact_count BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_routing_latest_restore
  ON whatsapp_routing_latest_projection(source, previous_phone_number_id)
  WHERE source = 'contingency' AND previous_phone_number_id IS NOT NULL;

CREATE OR REPLACE FUNCTION ristak_whatsapp_status_shard(entity_id TEXT)
RETURNS SMALLINT AS $$
  SELECT ABS(MOD(hashtextextended(COALESCE(entity_id, ''), 0), 64))::SMALLINT;
$$ LANGUAGE SQL IMMUTABLE PARALLEL SAFE;

CREATE OR REPLACE FUNCTION ristak_bump_whatsapp_status_metric(
  metric_name TEXT,
  entity_id TEXT,
  delta BIGINT
)
RETURNS VOID AS $$
DECLARE
  projection_status TEXT;
BEGIN
  IF delta = 0 THEN RETURN; END IF;
  SELECT status INTO projection_status
  FROM whatsapp_status_projection_state
  WHERE singleton_id = 1;

  IF projection_status IS DISTINCT FROM 'ready' THEN
    INSERT INTO whatsapp_status_metric_deltas (metric, shard, delta)
    VALUES (
      metric_name,
      ristak_whatsapp_status_shard(entity_id),
      delta
    );
    RETURN;
  END IF;

  INSERT INTO whatsapp_status_metric_counters (
    metric, shard, counter_value, updated_at
  ) VALUES (
    metric_name, ristak_whatsapp_status_shard(entity_id), delta, CURRENT_TIMESTAMP
  )
  ON CONFLICT (metric, shard) DO UPDATE SET
    counter_value = whatsapp_status_metric_counters.counter_value + EXCLUDED.counter_value,
    updated_at = CURRENT_TIMESTAMP;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ristak_whatsapp_status_total_trigger()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM ristak_bump_whatsapp_status_metric(TG_ARGV[0], NEW.id::text, 1);
    RETURN NEW;
  END IF;
  PERFORM ristak_bump_whatsapp_status_metric(TG_ARGV[0], OLD.id::text, -1);
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ristak_whatsapp_status_message_trigger()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM ristak_bump_whatsapp_status_metric('messages', NEW.id::text, 1);
    IF NEW.direction = 'inbound' THEN
      PERFORM ristak_bump_whatsapp_status_metric('inbound_messages', NEW.id::text, 1);
    END IF;
    IF NEW.direction IN ('outbound', 'business_echo') THEN
      PERFORM ristak_bump_whatsapp_status_metric('outbound_messages', NEW.id::text, 1);
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    PERFORM ristak_bump_whatsapp_status_metric('messages', OLD.id::text, -1);
    IF OLD.direction = 'inbound' THEN
      PERFORM ristak_bump_whatsapp_status_metric('inbound_messages', OLD.id::text, -1);
    END IF;
    IF OLD.direction IN ('outbound', 'business_echo') THEN
      PERFORM ristak_bump_whatsapp_status_metric('outbound_messages', OLD.id::text, -1);
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.direction IS DISTINCT FROM NEW.direction THEN
    IF OLD.direction = 'inbound' THEN
      PERFORM ristak_bump_whatsapp_status_metric('inbound_messages', OLD.id::text, -1);
    END IF;
    IF OLD.direction IN ('outbound', 'business_echo') THEN
      PERFORM ristak_bump_whatsapp_status_metric('outbound_messages', OLD.id::text, -1);
    END IF;
    IF NEW.direction = 'inbound' THEN
      PERFORM ristak_bump_whatsapp_status_metric('inbound_messages', NEW.id::text, 1);
    END IF;
    IF NEW.direction IN ('outbound', 'business_echo') THEN
      PERFORM ristak_bump_whatsapp_status_metric('outbound_messages', NEW.id::text, 1);
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ristak_whatsapp_status_template_trigger()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM ristak_bump_whatsapp_status_metric('templates', NEW.id::text, 1);
    IF NEW.status = 'APPROVED' THEN
      PERFORM ristak_bump_whatsapp_status_metric('approved_templates', NEW.id::text, 1);
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    PERFORM ristak_bump_whatsapp_status_metric('templates', OLD.id::text, -1);
    IF OLD.status = 'APPROVED' THEN
      PERFORM ristak_bump_whatsapp_status_metric('approved_templates', OLD.id::text, -1);
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    IF OLD.status = 'APPROVED' THEN
      PERFORM ristak_bump_whatsapp_status_metric('approved_templates', OLD.id::text, -1);
    END IF;
    IF NEW.status = 'APPROVED' THEN
      PERFORM ristak_bump_whatsapp_status_metric('approved_templates', NEW.id::text, 1);
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ristak_whatsapp_status_alert_trigger()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    IF OLD.status = 'active' THEN
      PERFORM ristak_bump_whatsapp_status_metric('active_alerts', OLD.id::text, -1);
    END IF;
    IF OLD.status = 'active' AND OLD.severity = 'critical' THEN
      PERFORM ristak_bump_whatsapp_status_metric('critical_alerts', OLD.id::text, -1);
    END IF;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    IF NEW.status = 'active' THEN
      PERFORM ristak_bump_whatsapp_status_metric('active_alerts', NEW.id::text, 1);
    END IF;
    IF NEW.status = 'active' AND NEW.severity = 'critical' THEN
      PERFORM ristak_bump_whatsapp_status_metric('critical_alerts', NEW.id::text, 1);
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ristak_recompute_whatsapp_routing_projection(
  target_contact_id TEXT,
  record_delta BOOLEAN DEFAULT TRUE
)
RETURNS VOID AS $$
DECLARE
  old_projection whatsapp_routing_latest_projection%ROWTYPE;
  latest_event whatsapp_routing_events%ROWTYPE;
  projection_status TEXT;
BEGIN
  IF NULLIF(target_contact_id, '') IS NULL THEN RETURN; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('whatsapp-routing:' || target_contact_id, 0));

  IF record_delta THEN
    SELECT status INTO projection_status
    FROM whatsapp_status_projection_state
    WHERE singleton_id = 1;
    IF projection_status IS DISTINCT FROM 'ready' THEN
      INSERT INTO whatsapp_status_routing_deltas (contact_id)
      VALUES (target_contact_id);
    END IF;
  END IF;

  SELECT * INTO old_projection
  FROM whatsapp_routing_latest_projection
  WHERE contact_id = target_contact_id
  FOR UPDATE;

  IF FOUND
     AND old_projection.source = 'contingency'
     AND old_projection.previous_phone_number_id IS NOT NULL THEN
    UPDATE whatsapp_contingency_restore_counts
    SET contact_count = contact_count - 1, updated_at = CURRENT_TIMESTAMP
    WHERE previous_phone_number_id = old_projection.previous_phone_number_id;
    DELETE FROM whatsapp_contingency_restore_counts
    WHERE previous_phone_number_id = old_projection.previous_phone_number_id
      AND contact_count <= 0;
  END IF;

  SELECT * INTO latest_event
  FROM whatsapp_routing_events
  WHERE contact_id = target_contact_id
  ORDER BY created_at DESC, id DESC
  LIMIT 1;

  IF NOT FOUND THEN
    DELETE FROM whatsapp_routing_latest_projection WHERE contact_id = target_contact_id;
    RETURN;
  END IF;

  INSERT INTO whatsapp_routing_latest_projection (
    contact_id, latest_event_id, previous_phone_number_id,
    new_phone_number_id, source, event_created_at, updated_at
  ) VALUES (
    target_contact_id, latest_event.id, latest_event.previous_phone_number_id,
    latest_event.new_phone_number_id, COALESCE(latest_event.source, ''),
    latest_event.created_at, CURRENT_TIMESTAMP
  )
  ON CONFLICT (contact_id) DO UPDATE SET
    latest_event_id = EXCLUDED.latest_event_id,
    previous_phone_number_id = EXCLUDED.previous_phone_number_id,
    new_phone_number_id = EXCLUDED.new_phone_number_id,
    source = EXCLUDED.source,
    event_created_at = EXCLUDED.event_created_at,
    updated_at = CURRENT_TIMESTAMP;

  IF latest_event.source = 'contingency'
     AND latest_event.previous_phone_number_id IS NOT NULL THEN
    INSERT INTO whatsapp_contingency_restore_counts (
      previous_phone_number_id, contact_count, updated_at
    ) VALUES (
      latest_event.previous_phone_number_id, 1, CURRENT_TIMESTAMP
    )
    ON CONFLICT (previous_phone_number_id) DO UPDATE SET
      contact_count = whatsapp_contingency_restore_counts.contact_count + 1,
      updated_at = CURRENT_TIMESTAMP;
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ristak_whatsapp_routing_projection_trigger()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM ristak_recompute_whatsapp_routing_projection(OLD.contact_id);
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.contact_id IS DISTINCT FROM NEW.contact_id THEN
    PERFORM ristak_recompute_whatsapp_routing_projection(OLD.contact_id);
  END IF;
  PERFORM ristak_recompute_whatsapp_routing_projection(NEW.contact_id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_whatsapp_status_phone_insert ON whatsapp_api_phone_numbers;
DROP TRIGGER IF EXISTS trg_whatsapp_status_phone_delete ON whatsapp_api_phone_numbers;
DROP TRIGGER IF EXISTS trg_whatsapp_status_contact_insert ON whatsapp_api_contacts;
DROP TRIGGER IF EXISTS trg_whatsapp_status_contact_delete ON whatsapp_api_contacts;
DROP TRIGGER IF EXISTS trg_whatsapp_status_message_insert ON whatsapp_api_messages;
DROP TRIGGER IF EXISTS trg_whatsapp_status_message_update ON whatsapp_api_messages;
DROP TRIGGER IF EXISTS trg_whatsapp_status_message_delete ON whatsapp_api_messages;
DROP TRIGGER IF EXISTS trg_whatsapp_status_attribution_insert ON whatsapp_api_attribution;
DROP TRIGGER IF EXISTS trg_whatsapp_status_attribution_delete ON whatsapp_api_attribution;
DROP TRIGGER IF EXISTS trg_whatsapp_status_event_insert ON whatsapp_api_webhook_events;
DROP TRIGGER IF EXISTS trg_whatsapp_status_event_delete ON whatsapp_api_webhook_events;
DROP TRIGGER IF EXISTS trg_whatsapp_status_template_insert ON whatsapp_api_templates;
DROP TRIGGER IF EXISTS trg_whatsapp_status_template_update ON whatsapp_api_templates;
DROP TRIGGER IF EXISTS trg_whatsapp_status_template_delete ON whatsapp_api_templates;
DROP TRIGGER IF EXISTS trg_whatsapp_status_alert_insert ON whatsapp_api_alerts;
DROP TRIGGER IF EXISTS trg_whatsapp_status_alert_update ON whatsapp_api_alerts;
DROP TRIGGER IF EXISTS trg_whatsapp_status_alert_delete ON whatsapp_api_alerts;
DROP TRIGGER IF EXISTS trg_whatsapp_status_template_send_insert ON whatsapp_api_template_sends;
DROP TRIGGER IF EXISTS trg_whatsapp_status_template_send_delete ON whatsapp_api_template_sends;
DROP TRIGGER IF EXISTS trg_whatsapp_routing_projection_insert ON whatsapp_routing_events;
DROP TRIGGER IF EXISTS trg_whatsapp_routing_projection_update ON whatsapp_routing_events;
DROP TRIGGER IF EXISTS trg_whatsapp_routing_projection_delete ON whatsapp_routing_events;

CREATE TRIGGER trg_whatsapp_status_phone_insert
AFTER INSERT ON whatsapp_api_phone_numbers
FOR EACH ROW EXECUTE FUNCTION ristak_whatsapp_status_total_trigger('phone_numbers');
CREATE TRIGGER trg_whatsapp_status_phone_delete
AFTER DELETE ON whatsapp_api_phone_numbers
FOR EACH ROW EXECUTE FUNCTION ristak_whatsapp_status_total_trigger('phone_numbers');
CREATE TRIGGER trg_whatsapp_status_contact_insert
AFTER INSERT ON whatsapp_api_contacts
FOR EACH ROW EXECUTE FUNCTION ristak_whatsapp_status_total_trigger('contacts');
CREATE TRIGGER trg_whatsapp_status_contact_delete
AFTER DELETE ON whatsapp_api_contacts
FOR EACH ROW EXECUTE FUNCTION ristak_whatsapp_status_total_trigger('contacts');
CREATE TRIGGER trg_whatsapp_status_message_insert
AFTER INSERT ON whatsapp_api_messages
FOR EACH ROW EXECUTE FUNCTION ristak_whatsapp_status_message_trigger();
CREATE TRIGGER trg_whatsapp_status_message_update
AFTER UPDATE OF direction ON whatsapp_api_messages
FOR EACH ROW WHEN (OLD.direction IS DISTINCT FROM NEW.direction)
EXECUTE FUNCTION ristak_whatsapp_status_message_trigger();
CREATE TRIGGER trg_whatsapp_status_message_delete
AFTER DELETE ON whatsapp_api_messages
FOR EACH ROW EXECUTE FUNCTION ristak_whatsapp_status_message_trigger();
CREATE TRIGGER trg_whatsapp_status_attribution_insert
AFTER INSERT ON whatsapp_api_attribution
FOR EACH ROW EXECUTE FUNCTION ristak_whatsapp_status_total_trigger('attributed_messages');
CREATE TRIGGER trg_whatsapp_status_attribution_delete
AFTER DELETE ON whatsapp_api_attribution
FOR EACH ROW EXECUTE FUNCTION ristak_whatsapp_status_total_trigger('attributed_messages');
CREATE TRIGGER trg_whatsapp_status_event_insert
AFTER INSERT ON whatsapp_api_webhook_events
FOR EACH ROW EXECUTE FUNCTION ristak_whatsapp_status_total_trigger('webhook_events');
CREATE TRIGGER trg_whatsapp_status_event_delete
AFTER DELETE ON whatsapp_api_webhook_events
FOR EACH ROW EXECUTE FUNCTION ristak_whatsapp_status_total_trigger('webhook_events');
CREATE TRIGGER trg_whatsapp_status_template_insert
AFTER INSERT ON whatsapp_api_templates
FOR EACH ROW EXECUTE FUNCTION ristak_whatsapp_status_template_trigger();
CREATE TRIGGER trg_whatsapp_status_template_update
AFTER UPDATE OF status ON whatsapp_api_templates
FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
EXECUTE FUNCTION ristak_whatsapp_status_template_trigger();
CREATE TRIGGER trg_whatsapp_status_template_delete
AFTER DELETE ON whatsapp_api_templates
FOR EACH ROW EXECUTE FUNCTION ristak_whatsapp_status_template_trigger();
CREATE TRIGGER trg_whatsapp_status_alert_insert
AFTER INSERT ON whatsapp_api_alerts
FOR EACH ROW EXECUTE FUNCTION ristak_whatsapp_status_alert_trigger();
CREATE TRIGGER trg_whatsapp_status_alert_update
AFTER UPDATE OF status, severity ON whatsapp_api_alerts
FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status OR OLD.severity IS DISTINCT FROM NEW.severity)
EXECUTE FUNCTION ristak_whatsapp_status_alert_trigger();
CREATE TRIGGER trg_whatsapp_status_alert_delete
AFTER DELETE ON whatsapp_api_alerts
FOR EACH ROW EXECUTE FUNCTION ristak_whatsapp_status_alert_trigger();
CREATE TRIGGER trg_whatsapp_status_template_send_insert
AFTER INSERT ON whatsapp_api_template_sends
FOR EACH ROW EXECUTE FUNCTION ristak_whatsapp_status_total_trigger('template_sends');
CREATE TRIGGER trg_whatsapp_status_template_send_delete
AFTER DELETE ON whatsapp_api_template_sends
FOR EACH ROW EXECUTE FUNCTION ristak_whatsapp_status_total_trigger('template_sends');
CREATE TRIGGER trg_whatsapp_routing_projection_insert
AFTER INSERT ON whatsapp_routing_events
FOR EACH ROW EXECUTE FUNCTION ristak_whatsapp_routing_projection_trigger();
CREATE TRIGGER trg_whatsapp_routing_projection_update
AFTER UPDATE OF contact_id, previous_phone_number_id, new_phone_number_id, source, created_at ON whatsapp_routing_events
FOR EACH ROW EXECUTE FUNCTION ristak_whatsapp_routing_projection_trigger();
CREATE TRIGGER trg_whatsapp_routing_projection_delete
AFTER DELETE ON whatsapp_routing_events
FOR EACH ROW EXECUTE FUNCTION ristak_whatsapp_routing_projection_trigger();

-- El histórico se construye después del readiness, por el worker local
-- `rebuildWhatsAppStatusProjection`. La migración sólo instala doble escritura
-- y estructuras acotadas; jamás bloquea mensajes/webhooks para ejecutar COUNTs.
