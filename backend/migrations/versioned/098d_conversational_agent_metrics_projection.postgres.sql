ALTER TABLE conversational_agent_state
  ADD COLUMN IF NOT EXISTS agent_metrics_projection_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE conversational_agent_events
  ADD COLUMN IF NOT EXISTS agent_metrics_projection_version INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS conversational_agent_state_metric_rows (
  state_id TEXT PRIMARY KEY,
  projection_version INTEGER NOT NULL DEFAULT 1,
  included INTEGER NOT NULL DEFAULT 0 CHECK (included IN (0, 1)),
  agent_id TEXT,
  total_conversations INTEGER NOT NULL DEFAULT 0,
  assigned_conversations INTEGER NOT NULL DEFAULT 0,
  completed_conversations INTEGER NOT NULL DEFAULT 0,
  paused_conversations INTEGER NOT NULL DEFAULT 0,
  human_takeovers INTEGER NOT NULL DEFAULT 0,
  skipped_conversations INTEGER NOT NULL DEFAULT 0,
  discarded_conversations INTEGER NOT NULL DEFAULT 0,
  answered_conversations INTEGER NOT NULL DEFAULT 0,
  activity_at TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS conversational_agent_state_metric_summary (
  agent_id TEXT PRIMARY KEY,
  total_conversations BIGINT NOT NULL DEFAULT 0,
  assigned_conversations BIGINT NOT NULL DEFAULT 0,
  completed_conversations BIGINT NOT NULL DEFAULT 0,
  paused_conversations BIGINT NOT NULL DEFAULT 0,
  human_takeovers BIGINT NOT NULL DEFAULT 0,
  skipped_conversations BIGINT NOT NULL DEFAULT 0,
  discarded_conversations BIGINT NOT NULL DEFAULT 0,
  answered_conversations BIGINT NOT NULL DEFAULT 0,
  last_activity_at TIMESTAMP,
  last_activity_state_id TEXT,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS conversational_agent_event_metric_rows (
  event_id TEXT PRIMARY KEY,
  projection_version INTEGER NOT NULL DEFAULT 1,
  included INTEGER NOT NULL DEFAULT 0 CHECK (included IN (0, 1)),
  summary_shard INTEGER NOT NULL DEFAULT 0 CHECK (summary_shard BETWEEN 0 AND 63),
  total_events INTEGER NOT NULL DEFAULT 0,
  success_events INTEGER NOT NULL DEFAULT 0,
  error_events INTEGER NOT NULL DEFAULT 0,
  assigned_events INTEGER NOT NULL DEFAULT 0,
  reply_events INTEGER NOT NULL DEFAULT 0,
  appointment_events INTEGER NOT NULL DEFAULT 0,
  payment_link_events INTEGER NOT NULL DEFAULT 0,
  goal_completion_events INTEGER NOT NULL DEFAULT 0,
  follow_up_sent_events INTEGER NOT NULL DEFAULT 0,
  follow_up_suppressed_events INTEGER NOT NULL DEFAULT 0,
  human_handoff_events INTEGER NOT NULL DEFAULT 0,
  tool_failure_events INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Shards fijos: evita que cada evento pelee por un unico renglon caliente.
CREATE TABLE IF NOT EXISTS conversational_agent_event_metric_summary (
  summary_shard INTEGER PRIMARY KEY CHECK (summary_shard BETWEEN 0 AND 63),
  total_events BIGINT NOT NULL DEFAULT 0,
  success_events BIGINT NOT NULL DEFAULT 0,
  error_events BIGINT NOT NULL DEFAULT 0,
  assigned_events BIGINT NOT NULL DEFAULT 0,
  reply_events BIGINT NOT NULL DEFAULT 0,
  appointment_events BIGINT NOT NULL DEFAULT 0,
  payment_link_events BIGINT NOT NULL DEFAULT 0,
  goal_completion_events BIGINT NOT NULL DEFAULT 0,
  follow_up_sent_events BIGINT NOT NULL DEFAULT 0,
  follow_up_suppressed_events BIGINT NOT NULL DEFAULT 0,
  human_handoff_events BIGINT NOT NULL DEFAULT 0,
  tool_failure_events BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS conversational_agent_metrics_projection_state (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  projection_version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'backfilling'
    CHECK (status IN ('backfilling', 'ready', 'failed')),
  last_error TEXT,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO conversational_agent_metrics_projection_state (
  singleton_id, projection_version, status
) VALUES (1, 1, 'backfilling')
ON CONFLICT(singleton_id) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_conversational_state_metric_rows_agent_activity
  ON conversational_agent_state_metric_rows(agent_id, activity_at DESC NULLS LAST, state_id DESC)
  WHERE included = 1;

CREATE OR REPLACE VIEW ristak_conversational_state_metric_source AS
SELECT
  id AS state_id,
  1 AS projection_version,
  CASE WHEN agent_id IS NOT NULL AND agent_id <> '' THEN 1 ELSE 0 END AS included,
  agent_id,
  CASE WHEN agent_id IS NOT NULL AND agent_id <> '' THEN 1 ELSE 0 END AS total_conversations,
  CASE WHEN agent_id IS NOT NULL AND agent_id <> ''
         AND status = 'active' AND COALESCE(signal, '') = '' THEN 1 ELSE 0 END AS assigned_conversations,
  CASE WHEN agent_id IS NOT NULL AND agent_id <> ''
         AND status = 'completed' THEN 1 ELSE 0 END AS completed_conversations,
  CASE WHEN agent_id IS NOT NULL AND agent_id <> ''
         AND status = 'paused' THEN 1 ELSE 0 END AS paused_conversations,
  CASE WHEN agent_id IS NOT NULL AND agent_id <> ''
         AND status = 'human' THEN 1 ELSE 0 END AS human_takeovers,
  CASE WHEN agent_id IS NOT NULL AND agent_id <> ''
         AND status = 'skipped' THEN 1 ELSE 0 END AS skipped_conversations,
  CASE WHEN agent_id IS NOT NULL AND agent_id <> ''
         AND (status = 'discarded' OR signal = 'discarded') THEN 1 ELSE 0 END AS discarded_conversations,
  CASE WHEN agent_id IS NOT NULL AND agent_id <> ''
         AND last_reply_at IS NOT NULL THEN 1 ELSE 0 END AS answered_conversations,
  COALESCE(updated_at, last_reply_at, signal_at) AS activity_at
FROM conversational_agent_state;

CREATE OR REPLACE VIEW ristak_conversational_event_metric_source AS
SELECT
  id AS event_id,
  1 AS projection_version,
  CASE WHEN event_type != 'appointment_slot_preview_offer_created' THEN 1 ELSE 0 END AS included,
  MOD(
    COALESCE(ASCII(NULLIF(RIGHT(id, 1), '')), 0) * 31 +
    COALESCE(ASCII(NULLIF(SUBSTRING(id FROM GREATEST(LENGTH(id) - 1, 1) FOR 1), '')), 0),
    64
  ) AS summary_shard,
  CASE WHEN event_type != 'appointment_slot_preview_offer_created' THEN 1 ELSE 0 END AS total_events,
  CASE WHEN event_type != 'appointment_slot_preview_offer_created' AND event_type = 'signal_set' THEN 1 ELSE 0 END AS success_events,
  CASE WHEN event_type != 'appointment_slot_preview_offer_created' AND (
         event_type = 'error'
         OR LOWER(event_type) LIKE '%error%'
         OR LOWER(event_type) LIKE '%failed%'
         OR LOWER(event_type) LIKE '%failure%'
       ) THEN 1 ELSE 0 END AS error_events,
  CASE WHEN event_type != 'appointment_slot_preview_offer_created' AND event_type = 'agent_assigned' THEN 1 ELSE 0 END AS assigned_events,
  CASE WHEN event_type != 'appointment_slot_preview_offer_created' AND event_type = 'reply_sent' THEN 1 ELSE 0 END AS reply_events,
  CASE WHEN event_type != 'appointment_slot_preview_offer_created' AND event_type = 'appointment_booked' THEN 1 ELSE 0 END AS appointment_events,
  CASE WHEN event_type != 'appointment_slot_preview_offer_created'
         AND event_type IN ('payment_link_created', 'payment_link_reused') THEN 1 ELSE 0 END AS payment_link_events,
  CASE WHEN event_type != 'appointment_slot_preview_offer_created'
         AND event_type IN ('goal_url_completed', 'purchase_completed') THEN 1 ELSE 0 END AS goal_completion_events,
  CASE WHEN event_type != 'appointment_slot_preview_offer_created' AND event_type = 'follow_up_sent' THEN 1 ELSE 0 END AS follow_up_sent_events,
  CASE WHEN event_type != 'appointment_slot_preview_offer_created' AND event_type = 'follow_up_suppressed' THEN 1 ELSE 0 END AS follow_up_suppressed_events,
  CASE WHEN event_type != 'appointment_slot_preview_offer_created'
         AND event_type IN ('human_handoff', 'runtime_human_handoff_forced') THEN 1 ELSE 0 END AS human_handoff_events,
  CASE WHEN event_type != 'appointment_slot_preview_offer_created' AND (
         LOWER(event_type) LIKE '%tool%failed%'
         OR LOWER(event_type) LIKE '%calendar%error%'
         OR event_type = 'payment_link_failed'
       ) THEN 1 ELSE 0 END AS tool_failure_events
FROM conversational_agent_events;

CREATE OR REPLACE FUNCTION ristak_conversational_state_metric_ledger_insert()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.included != 1 OR NULLIF(NEW.agent_id, '') IS NULL THEN RETURN NEW; END IF;

  INSERT INTO conversational_agent_state_metric_summary (
    agent_id, total_conversations, assigned_conversations,
    completed_conversations, paused_conversations, human_takeovers,
    skipped_conversations, discarded_conversations, answered_conversations,
    last_activity_at, last_activity_state_id, updated_at
  ) VALUES (
    NEW.agent_id, NEW.total_conversations, NEW.assigned_conversations,
    NEW.completed_conversations, NEW.paused_conversations, NEW.human_takeovers,
    NEW.skipped_conversations, NEW.discarded_conversations, NEW.answered_conversations,
    NEW.activity_at, NEW.state_id, CURRENT_TIMESTAMP
  )
  ON CONFLICT(agent_id) DO UPDATE SET
    total_conversations = conversational_agent_state_metric_summary.total_conversations + EXCLUDED.total_conversations,
    assigned_conversations = conversational_agent_state_metric_summary.assigned_conversations + EXCLUDED.assigned_conversations,
    completed_conversations = conversational_agent_state_metric_summary.completed_conversations + EXCLUDED.completed_conversations,
    paused_conversations = conversational_agent_state_metric_summary.paused_conversations + EXCLUDED.paused_conversations,
    human_takeovers = conversational_agent_state_metric_summary.human_takeovers + EXCLUDED.human_takeovers,
    skipped_conversations = conversational_agent_state_metric_summary.skipped_conversations + EXCLUDED.skipped_conversations,
    discarded_conversations = conversational_agent_state_metric_summary.discarded_conversations + EXCLUDED.discarded_conversations,
    answered_conversations = conversational_agent_state_metric_summary.answered_conversations + EXCLUDED.answered_conversations,
    last_activity_at = CASE
      WHEN (COALESCE(EXCLUDED.last_activity_at, '-infinity'::timestamp), EXCLUDED.last_activity_state_id) >
           (COALESCE(conversational_agent_state_metric_summary.last_activity_at, '-infinity'::timestamp), conversational_agent_state_metric_summary.last_activity_state_id)
      THEN EXCLUDED.last_activity_at
      ELSE conversational_agent_state_metric_summary.last_activity_at
    END,
    last_activity_state_id = CASE
      WHEN (COALESCE(EXCLUDED.last_activity_at, '-infinity'::timestamp), EXCLUDED.last_activity_state_id) >
           (COALESCE(conversational_agent_state_metric_summary.last_activity_at, '-infinity'::timestamp), conversational_agent_state_metric_summary.last_activity_state_id)
      THEN EXCLUDED.last_activity_state_id
      ELSE conversational_agent_state_metric_summary.last_activity_state_id
    END,
    updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ristak_conversational_state_metric_ledger_delete()
RETURNS TRIGGER AS $$
DECLARE
  replacement conversational_agent_state_metric_rows%ROWTYPE;
BEGIN
  IF OLD.included != 1 OR NULLIF(OLD.agent_id, '') IS NULL THEN RETURN OLD; END IF;

  UPDATE conversational_agent_state_metric_summary
  SET total_conversations = total_conversations - OLD.total_conversations,
      assigned_conversations = assigned_conversations - OLD.assigned_conversations,
      completed_conversations = completed_conversations - OLD.completed_conversations,
      paused_conversations = paused_conversations - OLD.paused_conversations,
      human_takeovers = human_takeovers - OLD.human_takeovers,
      skipped_conversations = skipped_conversations - OLD.skipped_conversations,
      discarded_conversations = discarded_conversations - OLD.discarded_conversations,
      answered_conversations = answered_conversations - OLD.answered_conversations,
      updated_at = CURRENT_TIMESTAMP
  WHERE agent_id = OLD.agent_id;

  DELETE FROM conversational_agent_state_metric_summary
  WHERE agent_id = OLD.agent_id AND total_conversations <= 0;

  IF EXISTS (
    SELECT 1 FROM conversational_agent_state_metric_summary WHERE agent_id = OLD.agent_id
  ) THEN
    SELECT * INTO replacement
    FROM conversational_agent_state_metric_rows
    WHERE included = 1 AND agent_id = OLD.agent_id
    ORDER BY activity_at DESC NULLS LAST, state_id DESC
    LIMIT 1;

    UPDATE conversational_agent_state_metric_summary
    SET last_activity_at = replacement.activity_at,
        last_activity_state_id = replacement.state_id,
        updated_at = CURRENT_TIMESTAMP
    WHERE agent_id = OLD.agent_id;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ristak_conversational_event_metric_ledger_insert()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.included != 1 THEN RETURN NEW; END IF;

  INSERT INTO conversational_agent_event_metric_summary (
    summary_shard, total_events, success_events, error_events,
    assigned_events, reply_events, appointment_events, payment_link_events,
    goal_completion_events, follow_up_sent_events, follow_up_suppressed_events,
    human_handoff_events, tool_failure_events, updated_at
  ) VALUES (
    NEW.summary_shard, NEW.total_events, NEW.success_events, NEW.error_events,
    NEW.assigned_events, NEW.reply_events, NEW.appointment_events, NEW.payment_link_events,
    NEW.goal_completion_events, NEW.follow_up_sent_events, NEW.follow_up_suppressed_events,
    NEW.human_handoff_events, NEW.tool_failure_events, CURRENT_TIMESTAMP
  )
  ON CONFLICT(summary_shard) DO UPDATE SET
    total_events = conversational_agent_event_metric_summary.total_events + EXCLUDED.total_events,
    success_events = conversational_agent_event_metric_summary.success_events + EXCLUDED.success_events,
    error_events = conversational_agent_event_metric_summary.error_events + EXCLUDED.error_events,
    assigned_events = conversational_agent_event_metric_summary.assigned_events + EXCLUDED.assigned_events,
    reply_events = conversational_agent_event_metric_summary.reply_events + EXCLUDED.reply_events,
    appointment_events = conversational_agent_event_metric_summary.appointment_events + EXCLUDED.appointment_events,
    payment_link_events = conversational_agent_event_metric_summary.payment_link_events + EXCLUDED.payment_link_events,
    goal_completion_events = conversational_agent_event_metric_summary.goal_completion_events + EXCLUDED.goal_completion_events,
    follow_up_sent_events = conversational_agent_event_metric_summary.follow_up_sent_events + EXCLUDED.follow_up_sent_events,
    follow_up_suppressed_events = conversational_agent_event_metric_summary.follow_up_suppressed_events + EXCLUDED.follow_up_suppressed_events,
    human_handoff_events = conversational_agent_event_metric_summary.human_handoff_events + EXCLUDED.human_handoff_events,
    tool_failure_events = conversational_agent_event_metric_summary.tool_failure_events + EXCLUDED.tool_failure_events,
    updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ristak_conversational_event_metric_ledger_delete()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.included != 1 THEN RETURN OLD; END IF;

  UPDATE conversational_agent_event_metric_summary
  SET total_events = total_events - OLD.total_events,
      success_events = success_events - OLD.success_events,
      error_events = error_events - OLD.error_events,
      assigned_events = assigned_events - OLD.assigned_events,
      reply_events = reply_events - OLD.reply_events,
      appointment_events = appointment_events - OLD.appointment_events,
      payment_link_events = payment_link_events - OLD.payment_link_events,
      goal_completion_events = goal_completion_events - OLD.goal_completion_events,
      follow_up_sent_events = follow_up_sent_events - OLD.follow_up_sent_events,
      follow_up_suppressed_events = follow_up_suppressed_events - OLD.follow_up_suppressed_events,
      human_handoff_events = human_handoff_events - OLD.human_handoff_events,
      tool_failure_events = tool_failure_events - OLD.tool_failure_events,
      updated_at = CURRENT_TIMESTAMP
  WHERE summary_shard = OLD.summary_shard;

  DELETE FROM conversational_agent_event_metric_summary
  WHERE summary_shard = OLD.summary_shard AND total_events <= 0;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_conversational_state_metric_ledger_insert ON conversational_agent_state_metric_rows;
CREATE TRIGGER trg_conversational_state_metric_ledger_insert
AFTER INSERT ON conversational_agent_state_metric_rows
FOR EACH ROW EXECUTE FUNCTION ristak_conversational_state_metric_ledger_insert();

DROP TRIGGER IF EXISTS trg_conversational_state_metric_ledger_delete ON conversational_agent_state_metric_rows;
CREATE TRIGGER trg_conversational_state_metric_ledger_delete
AFTER DELETE ON conversational_agent_state_metric_rows
FOR EACH ROW EXECUTE FUNCTION ristak_conversational_state_metric_ledger_delete();

DROP TRIGGER IF EXISTS trg_conversational_event_metric_ledger_insert ON conversational_agent_event_metric_rows;
CREATE TRIGGER trg_conversational_event_metric_ledger_insert
AFTER INSERT ON conversational_agent_event_metric_rows
FOR EACH ROW EXECUTE FUNCTION ristak_conversational_event_metric_ledger_insert();

DROP TRIGGER IF EXISTS trg_conversational_event_metric_ledger_delete ON conversational_agent_event_metric_rows;
CREATE TRIGGER trg_conversational_event_metric_ledger_delete
AFTER DELETE ON conversational_agent_event_metric_rows
FOR EACH ROW EXECUTE FUNCTION ristak_conversational_event_metric_ledger_delete();

CREATE OR REPLACE FUNCTION ristak_conversational_agent_metrics_mark_projected()
RETURNS TRIGGER AS $$
BEGIN
  NEW.agent_metrics_projection_version := 1;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ristak_conversational_agent_metrics_reproject()
RETURNS TRIGGER AS $$
DECLARE
  row_id TEXT := CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END;
BEGIN
  IF TG_TABLE_NAME = 'conversational_agent_state' THEN
    DELETE FROM conversational_agent_state_metric_rows WHERE state_id = row_id;
    IF TG_OP != 'DELETE' THEN
      INSERT INTO conversational_agent_state_metric_rows (
        state_id, projection_version, included, agent_id, total_conversations,
        assigned_conversations, completed_conversations, paused_conversations,
        human_takeovers, skipped_conversations, discarded_conversations,
        answered_conversations, activity_at, updated_at
      )
      SELECT state_id, projection_version, included, agent_id, total_conversations,
             assigned_conversations, completed_conversations, paused_conversations,
             human_takeovers, skipped_conversations, discarded_conversations,
             answered_conversations, activity_at, CURRENT_TIMESTAMP
      FROM ristak_conversational_state_metric_source
      WHERE state_id = row_id;
    END IF;
  ELSE
    DELETE FROM conversational_agent_event_metric_rows WHERE event_id = row_id;
    IF TG_OP != 'DELETE' THEN
      INSERT INTO conversational_agent_event_metric_rows (
        event_id, projection_version, included, summary_shard, total_events,
        success_events, error_events, assigned_events, reply_events,
        appointment_events, payment_link_events, goal_completion_events,
        follow_up_sent_events, follow_up_suppressed_events, human_handoff_events,
        tool_failure_events, updated_at
      )
      SELECT event_id, projection_version, included, summary_shard, total_events,
             success_events, error_events, assigned_events, reply_events,
             appointment_events, payment_link_events, goal_completion_events,
             follow_up_sent_events, follow_up_suppressed_events, human_handoff_events,
             tool_failure_events, CURRENT_TIMESTAMP
      FROM ristak_conversational_event_metric_source
      WHERE event_id = row_id;
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_conversational_state_metrics_version ON conversational_agent_state;
CREATE TRIGGER trg_conversational_state_metrics_version
BEFORE INSERT OR UPDATE OF id, agent_id, status, signal, signal_at, last_reply_at, updated_at
ON conversational_agent_state
FOR EACH ROW EXECUTE FUNCTION ristak_conversational_agent_metrics_mark_projected();

DROP TRIGGER IF EXISTS trg_conversational_state_metrics_sync ON conversational_agent_state;
CREATE TRIGGER trg_conversational_state_metrics_sync
AFTER INSERT OR UPDATE OF id, agent_id, status, signal, signal_at, last_reply_at, updated_at OR DELETE
ON conversational_agent_state
FOR EACH ROW EXECUTE FUNCTION ristak_conversational_agent_metrics_reproject();

DROP TRIGGER IF EXISTS trg_conversational_event_metrics_version ON conversational_agent_events;
CREATE TRIGGER trg_conversational_event_metrics_version
BEFORE INSERT OR UPDATE OF id, event_type ON conversational_agent_events
FOR EACH ROW EXECUTE FUNCTION ristak_conversational_agent_metrics_mark_projected();

DROP TRIGGER IF EXISTS trg_conversational_event_metrics_sync ON conversational_agent_events;
CREATE TRIGGER trg_conversational_event_metrics_sync
AFTER INSERT OR UPDATE OF id, event_type OR DELETE ON conversational_agent_events
FOR EACH ROW EXECUTE FUNCTION ristak_conversational_agent_metrics_reproject();
