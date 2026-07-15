CREATE TABLE IF NOT EXISTS whatsapp_status_metric_counters (
  metric TEXT NOT NULL,
  shard INTEGER NOT NULL DEFAULT 0,
  counter_value INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (metric, shard)
);

CREATE TABLE IF NOT EXISTS whatsapp_status_projection_state (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  projection_version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'backfilling'
    CHECK (status IN ('backfilling', 'ready', 'failed')),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO whatsapp_status_projection_state (singleton_id, projection_version, status)
VALUES (1, 1, 'backfilling')
ON CONFLICT(singleton_id) DO UPDATE SET
  projection_version = excluded.projection_version,
  status = 'backfilling',
  updated_at = CURRENT_TIMESTAMP;

CREATE TABLE IF NOT EXISTS whatsapp_routing_latest_projection (
  contact_id TEXT PRIMARY KEY,
  latest_event_id TEXT NOT NULL,
  previous_phone_number_id TEXT,
  new_phone_number_id TEXT,
  source TEXT NOT NULL DEFAULT '',
  event_created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS whatsapp_contingency_restore_counts (
  previous_phone_number_id TEXT PRIMARY KEY,
  contact_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_routing_events_contact_latest_v2
  ON whatsapp_routing_events(contact_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_whatsapp_routing_latest_restore
  ON whatsapp_routing_latest_projection(source, previous_phone_number_id)
  WHERE source = 'contingency' AND previous_phone_number_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_whatsapp_api_templates_catalog_page
  ON whatsapp_api_templates(status, updated_at DESC, id DESC);

DROP TRIGGER IF EXISTS trg_whatsapp_status_phone_insert;
DROP TRIGGER IF EXISTS trg_whatsapp_status_phone_delete;
DROP TRIGGER IF EXISTS trg_whatsapp_status_contact_insert;
DROP TRIGGER IF EXISTS trg_whatsapp_status_contact_delete;
DROP TRIGGER IF EXISTS trg_whatsapp_status_message_insert;
DROP TRIGGER IF EXISTS trg_whatsapp_status_message_update;
DROP TRIGGER IF EXISTS trg_whatsapp_status_message_delete;
DROP TRIGGER IF EXISTS trg_whatsapp_status_attribution_insert;
DROP TRIGGER IF EXISTS trg_whatsapp_status_attribution_delete;
DROP TRIGGER IF EXISTS trg_whatsapp_status_event_insert;
DROP TRIGGER IF EXISTS trg_whatsapp_status_event_delete;
DROP TRIGGER IF EXISTS trg_whatsapp_status_template_insert;
DROP TRIGGER IF EXISTS trg_whatsapp_status_template_update;
DROP TRIGGER IF EXISTS trg_whatsapp_status_template_delete;
DROP TRIGGER IF EXISTS trg_whatsapp_status_alert_insert;
DROP TRIGGER IF EXISTS trg_whatsapp_status_alert_update;
DROP TRIGGER IF EXISTS trg_whatsapp_status_alert_delete;
DROP TRIGGER IF EXISTS trg_whatsapp_status_template_send_insert;
DROP TRIGGER IF EXISTS trg_whatsapp_status_template_send_delete;
DROP TRIGGER IF EXISTS trg_whatsapp_routing_projection_insert;
DROP TRIGGER IF EXISTS trg_whatsapp_routing_projection_update;
DROP TRIGGER IF EXISTS trg_whatsapp_routing_projection_delete;

DELETE FROM whatsapp_status_metric_counters;
INSERT INTO whatsapp_status_metric_counters (metric, shard, counter_value)
SELECT 'phone_numbers', 0, COUNT(*) FROM whatsapp_api_phone_numbers
UNION ALL SELECT 'contacts', 0, COUNT(*) FROM whatsapp_api_contacts
UNION ALL SELECT 'messages', 0, COUNT(*) FROM whatsapp_api_messages
UNION ALL SELECT 'inbound_messages', 0, COUNT(*) FROM whatsapp_api_messages WHERE direction = 'inbound'
UNION ALL SELECT 'outbound_messages', 0, COUNT(*) FROM whatsapp_api_messages WHERE direction IN ('outbound', 'business_echo')
UNION ALL SELECT 'attributed_messages', 0, COUNT(*) FROM whatsapp_api_attribution
UNION ALL SELECT 'webhook_events', 0, COUNT(*) FROM whatsapp_api_webhook_events
UNION ALL SELECT 'templates', 0, COUNT(*) FROM whatsapp_api_templates
UNION ALL SELECT 'approved_templates', 0, COUNT(*) FROM whatsapp_api_templates WHERE status = 'APPROVED'
UNION ALL SELECT 'active_alerts', 0, COUNT(*) FROM whatsapp_api_alerts WHERE status = 'active'
UNION ALL SELECT 'critical_alerts', 0, COUNT(*) FROM whatsapp_api_alerts WHERE status = 'active' AND severity = 'critical'
UNION ALL SELECT 'template_sends', 0, COUNT(*) FROM whatsapp_api_template_sends;

DELETE FROM whatsapp_routing_latest_projection;
INSERT INTO whatsapp_routing_latest_projection (
  contact_id, latest_event_id, previous_phone_number_id,
  new_phone_number_id, source, event_created_at
)
SELECT contact_id, id, previous_phone_number_id, new_phone_number_id,
  COALESCE(source, ''), created_at
FROM (
  SELECT event.*,
    ROW_NUMBER() OVER (
      PARTITION BY event.contact_id
      ORDER BY event.created_at DESC, event.id DESC
    ) AS row_number
  FROM whatsapp_routing_events event
) ranked
WHERE row_number = 1;

DELETE FROM whatsapp_contingency_restore_counts;
INSERT INTO whatsapp_contingency_restore_counts (
  previous_phone_number_id, contact_count, updated_at
)
SELECT previous_phone_number_id, COUNT(*), CURRENT_TIMESTAMP
FROM whatsapp_routing_latest_projection
WHERE source = 'contingency'
  AND previous_phone_number_id IS NOT NULL
GROUP BY previous_phone_number_id;

CREATE TRIGGER trg_whatsapp_status_phone_insert
AFTER INSERT ON whatsapp_api_phone_numbers BEGIN
  INSERT INTO whatsapp_status_metric_counters (metric, shard, counter_value)
  VALUES ('phone_numbers', 0, 1)
  ON CONFLICT(metric, shard) DO UPDATE SET counter_value = counter_value + 1, updated_at = CURRENT_TIMESTAMP;
END;
CREATE TRIGGER trg_whatsapp_status_phone_delete
AFTER DELETE ON whatsapp_api_phone_numbers BEGIN
  INSERT INTO whatsapp_status_metric_counters (metric, shard, counter_value)
  VALUES ('phone_numbers', 0, -1)
  ON CONFLICT(metric, shard) DO UPDATE SET counter_value = counter_value - 1, updated_at = CURRENT_TIMESTAMP;
END;

CREATE TRIGGER trg_whatsapp_status_contact_insert
AFTER INSERT ON whatsapp_api_contacts BEGIN
  INSERT INTO whatsapp_status_metric_counters (metric, shard, counter_value)
  VALUES ('contacts', 0, 1)
  ON CONFLICT(metric, shard) DO UPDATE SET counter_value = counter_value + 1, updated_at = CURRENT_TIMESTAMP;
END;
CREATE TRIGGER trg_whatsapp_status_contact_delete
AFTER DELETE ON whatsapp_api_contacts BEGIN
  INSERT INTO whatsapp_status_metric_counters (metric, shard, counter_value)
  VALUES ('contacts', 0, -1)
  ON CONFLICT(metric, shard) DO UPDATE SET counter_value = counter_value - 1, updated_at = CURRENT_TIMESTAMP;
END;

CREATE TRIGGER trg_whatsapp_status_message_insert
AFTER INSERT ON whatsapp_api_messages BEGIN
  INSERT INTO whatsapp_status_metric_counters (metric, shard, counter_value)
  VALUES ('messages', 0, 1)
  ON CONFLICT(metric, shard) DO UPDATE SET counter_value = counter_value + 1, updated_at = CURRENT_TIMESTAMP;
  INSERT INTO whatsapp_status_metric_counters (metric, shard, counter_value)
  SELECT 'inbound_messages', 0, 1 WHERE NEW.direction = 'inbound'
  ON CONFLICT(metric, shard) DO UPDATE SET counter_value = counter_value + 1, updated_at = CURRENT_TIMESTAMP;
  INSERT INTO whatsapp_status_metric_counters (metric, shard, counter_value)
  SELECT 'outbound_messages', 0, 1 WHERE NEW.direction IN ('outbound', 'business_echo')
  ON CONFLICT(metric, shard) DO UPDATE SET counter_value = counter_value + 1, updated_at = CURRENT_TIMESTAMP;
END;
CREATE TRIGGER trg_whatsapp_status_message_update
AFTER UPDATE OF direction ON whatsapp_api_messages
WHEN OLD.direction IS NOT NEW.direction BEGIN
  INSERT INTO whatsapp_status_metric_counters (metric, shard, counter_value)
  SELECT 'inbound_messages', 0, -1 WHERE OLD.direction = 'inbound'
  ON CONFLICT(metric, shard) DO UPDATE SET counter_value = counter_value - 1, updated_at = CURRENT_TIMESTAMP;
  INSERT INTO whatsapp_status_metric_counters (metric, shard, counter_value)
  SELECT 'outbound_messages', 0, -1 WHERE OLD.direction IN ('outbound', 'business_echo')
  ON CONFLICT(metric, shard) DO UPDATE SET counter_value = counter_value - 1, updated_at = CURRENT_TIMESTAMP;
  INSERT INTO whatsapp_status_metric_counters (metric, shard, counter_value)
  SELECT 'inbound_messages', 0, 1 WHERE NEW.direction = 'inbound'
  ON CONFLICT(metric, shard) DO UPDATE SET counter_value = counter_value + 1, updated_at = CURRENT_TIMESTAMP;
  INSERT INTO whatsapp_status_metric_counters (metric, shard, counter_value)
  SELECT 'outbound_messages', 0, 1 WHERE NEW.direction IN ('outbound', 'business_echo')
  ON CONFLICT(metric, shard) DO UPDATE SET counter_value = counter_value + 1, updated_at = CURRENT_TIMESTAMP;
END;
CREATE TRIGGER trg_whatsapp_status_message_delete
AFTER DELETE ON whatsapp_api_messages BEGIN
  INSERT INTO whatsapp_status_metric_counters (metric, shard, counter_value)
  VALUES ('messages', 0, -1)
  ON CONFLICT(metric, shard) DO UPDATE SET counter_value = counter_value - 1, updated_at = CURRENT_TIMESTAMP;
  INSERT INTO whatsapp_status_metric_counters (metric, shard, counter_value)
  SELECT 'inbound_messages', 0, -1 WHERE OLD.direction = 'inbound'
  ON CONFLICT(metric, shard) DO UPDATE SET counter_value = counter_value - 1, updated_at = CURRENT_TIMESTAMP;
  INSERT INTO whatsapp_status_metric_counters (metric, shard, counter_value)
  SELECT 'outbound_messages', 0, -1 WHERE OLD.direction IN ('outbound', 'business_echo')
  ON CONFLICT(metric, shard) DO UPDATE SET counter_value = counter_value - 1, updated_at = CURRENT_TIMESTAMP;
END;

CREATE TRIGGER trg_whatsapp_status_attribution_insert
AFTER INSERT ON whatsapp_api_attribution BEGIN
  INSERT INTO whatsapp_status_metric_counters (metric, shard, counter_value)
  VALUES ('attributed_messages', 0, 1)
  ON CONFLICT(metric, shard) DO UPDATE SET counter_value = counter_value + 1, updated_at = CURRENT_TIMESTAMP;
END;
CREATE TRIGGER trg_whatsapp_status_attribution_delete
AFTER DELETE ON whatsapp_api_attribution BEGIN
  INSERT INTO whatsapp_status_metric_counters (metric, shard, counter_value)
  VALUES ('attributed_messages', 0, -1)
  ON CONFLICT(metric, shard) DO UPDATE SET counter_value = counter_value - 1, updated_at = CURRENT_TIMESTAMP;
END;

CREATE TRIGGER trg_whatsapp_status_event_insert
AFTER INSERT ON whatsapp_api_webhook_events BEGIN
  INSERT INTO whatsapp_status_metric_counters (metric, shard, counter_value)
  VALUES ('webhook_events', 0, 1)
  ON CONFLICT(metric, shard) DO UPDATE SET counter_value = counter_value + 1, updated_at = CURRENT_TIMESTAMP;
END;
CREATE TRIGGER trg_whatsapp_status_event_delete
AFTER DELETE ON whatsapp_api_webhook_events BEGIN
  INSERT INTO whatsapp_status_metric_counters (metric, shard, counter_value)
  VALUES ('webhook_events', 0, -1)
  ON CONFLICT(metric, shard) DO UPDATE SET counter_value = counter_value - 1, updated_at = CURRENT_TIMESTAMP;
END;

CREATE TRIGGER trg_whatsapp_status_template_insert
AFTER INSERT ON whatsapp_api_templates BEGIN
  INSERT INTO whatsapp_status_metric_counters (metric, shard, counter_value)
  VALUES ('templates', 0, 1)
  ON CONFLICT(metric, shard) DO UPDATE SET counter_value = counter_value + 1, updated_at = CURRENT_TIMESTAMP;
  INSERT INTO whatsapp_status_metric_counters (metric, shard, counter_value)
  SELECT 'approved_templates', 0, 1 WHERE NEW.status = 'APPROVED'
  ON CONFLICT(metric, shard) DO UPDATE SET counter_value = counter_value + 1, updated_at = CURRENT_TIMESTAMP;
END;
CREATE TRIGGER trg_whatsapp_status_template_update
AFTER UPDATE OF status ON whatsapp_api_templates
WHEN OLD.status IS NOT NEW.status BEGIN
  INSERT INTO whatsapp_status_metric_counters (metric, shard, counter_value)
  SELECT 'approved_templates', 0, -1 WHERE OLD.status = 'APPROVED'
  ON CONFLICT(metric, shard) DO UPDATE SET counter_value = counter_value - 1, updated_at = CURRENT_TIMESTAMP;
  INSERT INTO whatsapp_status_metric_counters (metric, shard, counter_value)
  SELECT 'approved_templates', 0, 1 WHERE NEW.status = 'APPROVED'
  ON CONFLICT(metric, shard) DO UPDATE SET counter_value = counter_value + 1, updated_at = CURRENT_TIMESTAMP;
END;
CREATE TRIGGER trg_whatsapp_status_template_delete
AFTER DELETE ON whatsapp_api_templates BEGIN
  INSERT INTO whatsapp_status_metric_counters (metric, shard, counter_value)
  VALUES ('templates', 0, -1)
  ON CONFLICT(metric, shard) DO UPDATE SET counter_value = counter_value - 1, updated_at = CURRENT_TIMESTAMP;
  INSERT INTO whatsapp_status_metric_counters (metric, shard, counter_value)
  SELECT 'approved_templates', 0, -1 WHERE OLD.status = 'APPROVED'
  ON CONFLICT(metric, shard) DO UPDATE SET counter_value = counter_value - 1, updated_at = CURRENT_TIMESTAMP;
END;

CREATE TRIGGER trg_whatsapp_status_alert_insert
AFTER INSERT ON whatsapp_api_alerts BEGIN
  INSERT INTO whatsapp_status_metric_counters (metric, shard, counter_value)
  SELECT 'active_alerts', 0, 1 WHERE NEW.status = 'active'
  ON CONFLICT(metric, shard) DO UPDATE SET counter_value = counter_value + 1, updated_at = CURRENT_TIMESTAMP;
  INSERT INTO whatsapp_status_metric_counters (metric, shard, counter_value)
  SELECT 'critical_alerts', 0, 1 WHERE NEW.status = 'active' AND NEW.severity = 'critical'
  ON CONFLICT(metric, shard) DO UPDATE SET counter_value = counter_value + 1, updated_at = CURRENT_TIMESTAMP;
END;
CREATE TRIGGER trg_whatsapp_status_alert_update
AFTER UPDATE OF status, severity ON whatsapp_api_alerts
WHEN OLD.status IS NOT NEW.status OR OLD.severity IS NOT NEW.severity BEGIN
  INSERT INTO whatsapp_status_metric_counters (metric, shard, counter_value)
  SELECT 'active_alerts', 0, -1 WHERE OLD.status = 'active'
  ON CONFLICT(metric, shard) DO UPDATE SET counter_value = counter_value - 1, updated_at = CURRENT_TIMESTAMP;
  INSERT INTO whatsapp_status_metric_counters (metric, shard, counter_value)
  SELECT 'critical_alerts', 0, -1 WHERE OLD.status = 'active' AND OLD.severity = 'critical'
  ON CONFLICT(metric, shard) DO UPDATE SET counter_value = counter_value - 1, updated_at = CURRENT_TIMESTAMP;
  INSERT INTO whatsapp_status_metric_counters (metric, shard, counter_value)
  SELECT 'active_alerts', 0, 1 WHERE NEW.status = 'active'
  ON CONFLICT(metric, shard) DO UPDATE SET counter_value = counter_value + 1, updated_at = CURRENT_TIMESTAMP;
  INSERT INTO whatsapp_status_metric_counters (metric, shard, counter_value)
  SELECT 'critical_alerts', 0, 1 WHERE NEW.status = 'active' AND NEW.severity = 'critical'
  ON CONFLICT(metric, shard) DO UPDATE SET counter_value = counter_value + 1, updated_at = CURRENT_TIMESTAMP;
END;
CREATE TRIGGER trg_whatsapp_status_alert_delete
AFTER DELETE ON whatsapp_api_alerts BEGIN
  INSERT INTO whatsapp_status_metric_counters (metric, shard, counter_value)
  SELECT 'active_alerts', 0, -1 WHERE OLD.status = 'active'
  ON CONFLICT(metric, shard) DO UPDATE SET counter_value = counter_value - 1, updated_at = CURRENT_TIMESTAMP;
  INSERT INTO whatsapp_status_metric_counters (metric, shard, counter_value)
  SELECT 'critical_alerts', 0, -1 WHERE OLD.status = 'active' AND OLD.severity = 'critical'
  ON CONFLICT(metric, shard) DO UPDATE SET counter_value = counter_value - 1, updated_at = CURRENT_TIMESTAMP;
END;

CREATE TRIGGER trg_whatsapp_status_template_send_insert
AFTER INSERT ON whatsapp_api_template_sends BEGIN
  INSERT INTO whatsapp_status_metric_counters (metric, shard, counter_value)
  VALUES ('template_sends', 0, 1)
  ON CONFLICT(metric, shard) DO UPDATE SET counter_value = counter_value + 1, updated_at = CURRENT_TIMESTAMP;
END;
CREATE TRIGGER trg_whatsapp_status_template_send_delete
AFTER DELETE ON whatsapp_api_template_sends BEGIN
  INSERT INTO whatsapp_status_metric_counters (metric, shard, counter_value)
  VALUES ('template_sends', 0, -1)
  ON CONFLICT(metric, shard) DO UPDATE SET counter_value = counter_value - 1, updated_at = CURRENT_TIMESTAMP;
END;

-- Los eventos de ruteo son append-only en producto, pero estos triggers también
-- recomputan de forma exacta si una prueba/importación actualiza o borra historia.
CREATE TRIGGER trg_whatsapp_routing_projection_insert
AFTER INSERT ON whatsapp_routing_events BEGIN
  UPDATE whatsapp_contingency_restore_counts
  SET contact_count = contact_count - 1, updated_at = CURRENT_TIMESTAMP
  WHERE previous_phone_number_id = (
    SELECT previous_phone_number_id
    FROM whatsapp_routing_latest_projection
    WHERE contact_id = NEW.contact_id
      AND source = 'contingency'
      AND previous_phone_number_id IS NOT NULL
  );
  DELETE FROM whatsapp_routing_latest_projection WHERE contact_id = NEW.contact_id;
  INSERT INTO whatsapp_routing_latest_projection (
    contact_id, latest_event_id, previous_phone_number_id,
    new_phone_number_id, source, event_created_at
  )
  SELECT contact_id, id, previous_phone_number_id, new_phone_number_id,
    COALESCE(source, ''), created_at
  FROM whatsapp_routing_events
  WHERE contact_id = NEW.contact_id
  ORDER BY created_at DESC, id DESC
  LIMIT 1;
  INSERT INTO whatsapp_contingency_restore_counts (previous_phone_number_id, contact_count)
  SELECT previous_phone_number_id, 1
  FROM whatsapp_routing_latest_projection
  WHERE contact_id = NEW.contact_id
    AND source = 'contingency'
    AND previous_phone_number_id IS NOT NULL
  ON CONFLICT(previous_phone_number_id) DO UPDATE SET
    contact_count = contact_count + 1,
    updated_at = CURRENT_TIMESTAMP;
  DELETE FROM whatsapp_contingency_restore_counts WHERE contact_count <= 0;
END;

CREATE TRIGGER trg_whatsapp_routing_projection_delete
AFTER DELETE ON whatsapp_routing_events BEGIN
  UPDATE whatsapp_contingency_restore_counts
  SET contact_count = contact_count - 1, updated_at = CURRENT_TIMESTAMP
  WHERE previous_phone_number_id = (
    SELECT previous_phone_number_id
    FROM whatsapp_routing_latest_projection
    WHERE contact_id = OLD.contact_id
      AND source = 'contingency'
      AND previous_phone_number_id IS NOT NULL
  );
  DELETE FROM whatsapp_routing_latest_projection WHERE contact_id = OLD.contact_id;
  INSERT INTO whatsapp_routing_latest_projection (
    contact_id, latest_event_id, previous_phone_number_id,
    new_phone_number_id, source, event_created_at
  )
  SELECT contact_id, id, previous_phone_number_id, new_phone_number_id,
    COALESCE(source, ''), created_at
  FROM whatsapp_routing_events
  WHERE contact_id = OLD.contact_id
  ORDER BY created_at DESC, id DESC
  LIMIT 1;
  INSERT INTO whatsapp_contingency_restore_counts (previous_phone_number_id, contact_count)
  SELECT previous_phone_number_id, 1
  FROM whatsapp_routing_latest_projection
  WHERE contact_id = OLD.contact_id
    AND source = 'contingency'
    AND previous_phone_number_id IS NOT NULL
  ON CONFLICT(previous_phone_number_id) DO UPDATE SET
    contact_count = contact_count + 1,
    updated_at = CURRENT_TIMESTAMP;
  DELETE FROM whatsapp_contingency_restore_counts WHERE contact_count <= 0;
END;

CREATE TRIGGER trg_whatsapp_routing_projection_update
AFTER UPDATE OF contact_id, previous_phone_number_id, new_phone_number_id, source, created_at ON whatsapp_routing_events BEGIN
  UPDATE whatsapp_contingency_restore_counts
  SET contact_count = contact_count - 1, updated_at = CURRENT_TIMESTAMP
  WHERE previous_phone_number_id = (
    SELECT previous_phone_number_id FROM whatsapp_routing_latest_projection
    WHERE contact_id = OLD.contact_id AND source = 'contingency' AND previous_phone_number_id IS NOT NULL
  );
  DELETE FROM whatsapp_routing_latest_projection WHERE contact_id = OLD.contact_id;
  INSERT INTO whatsapp_routing_latest_projection (
    contact_id, latest_event_id, previous_phone_number_id,
    new_phone_number_id, source, event_created_at
  )
  SELECT contact_id, id, previous_phone_number_id, new_phone_number_id,
    COALESCE(source, ''), created_at
  FROM whatsapp_routing_events
  WHERE contact_id = OLD.contact_id
  ORDER BY created_at DESC, id DESC
  LIMIT 1;
  INSERT INTO whatsapp_contingency_restore_counts (previous_phone_number_id, contact_count)
  SELECT previous_phone_number_id, 1 FROM whatsapp_routing_latest_projection
  WHERE contact_id = OLD.contact_id AND source = 'contingency' AND previous_phone_number_id IS NOT NULL
  ON CONFLICT(previous_phone_number_id) DO UPDATE SET
    contact_count = contact_count + 1, updated_at = CURRENT_TIMESTAMP;

  UPDATE whatsapp_contingency_restore_counts
  SET contact_count = contact_count - 1, updated_at = CURRENT_TIMESTAMP
  WHERE NEW.contact_id <> OLD.contact_id
    AND previous_phone_number_id = (
      SELECT previous_phone_number_id FROM whatsapp_routing_latest_projection
      WHERE contact_id = NEW.contact_id AND source = 'contingency' AND previous_phone_number_id IS NOT NULL
    );
  DELETE FROM whatsapp_routing_latest_projection
  WHERE NEW.contact_id <> OLD.contact_id AND contact_id = NEW.contact_id;
  INSERT INTO whatsapp_routing_latest_projection (
    contact_id, latest_event_id, previous_phone_number_id,
    new_phone_number_id, source, event_created_at
  )
  SELECT contact_id, id, previous_phone_number_id, new_phone_number_id,
    COALESCE(source, ''), created_at
  FROM whatsapp_routing_events
  WHERE NEW.contact_id <> OLD.contact_id AND contact_id = NEW.contact_id
  ORDER BY created_at DESC, id DESC
  LIMIT 1;
  INSERT INTO whatsapp_contingency_restore_counts (previous_phone_number_id, contact_count)
  SELECT previous_phone_number_id, 1 FROM whatsapp_routing_latest_projection
  WHERE NEW.contact_id <> OLD.contact_id
    AND contact_id = NEW.contact_id AND source = 'contingency' AND previous_phone_number_id IS NOT NULL
  ON CONFLICT(previous_phone_number_id) DO UPDATE SET
    contact_count = contact_count + 1, updated_at = CURRENT_TIMESTAMP;
  DELETE FROM whatsapp_contingency_restore_counts WHERE contact_count <= 0;
END;

UPDATE whatsapp_status_projection_state
SET projection_version = 1, status = 'ready', updated_at = CURRENT_TIMESTAMP
WHERE singleton_id = 1;
