-- Totales históricos por chatbot (scope vacío) y agente. Un chat se identifica
-- por contacto y canal. Las entregas parciales y repetidas comparten el mismo chat.
ALTER TABLE conversational_agent_events ADD COLUMN activity_metrics_version INTEGER NOT NULL DEFAULT 0;

CREATE TABLE conversational_agent_activity_facts (
  event_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('reply', 'goal', 'error')),
  PRIMARY KEY (event_id, scope)
);
CREATE TABLE conversational_agent_activity_chats (
  scope TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  reply_events BIGINT NOT NULL DEFAULT 0,
  goal_events BIGINT NOT NULL DEFAULT 0,
  error_events BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, contact_id, channel)
);
CREATE TABLE conversational_agent_activity_summary (
  scope TEXT PRIMARY KEY,
  answered_conversations BIGINT NOT NULL DEFAULT 0,
  successful_answered_conversations BIGINT NOT NULL DEFAULT 0,
  completed_conversations BIGINT NOT NULL DEFAULT 0,
  error_events BIGINT NOT NULL DEFAULT 0
);

CREATE VIEW ristak_conversational_activity_pending AS
SELECT id FROM conversational_agent_events
WHERE activity_metrics_version = 0 AND (
    event_type IN ('reply_sent', 'reply_single_sent', 'reply_part_sent',
      'follow_up_sent', 'payment_resume_reply_sent', 'signal_set')
    OR LOWER(event_type) LIKE '%error%'
    OR LOWER(event_type) LIKE '%failed%'
    OR LOWER(event_type) LIKE '%failure%');

-- Mismo contrato de cierre que isCompletionSignalEvent: un handoff o una
-- notificación secundaria del enlace/pago por sí solos no cumplen el objetivo.
CREATE VIEW ristak_conversational_activity_source AS
SELECT id AS event_id, CASE WHEN per_agent = 0 THEN '' ELSE attributed_agent END AS scope,
       COALESCE(contact_id, '') AS contact_id,
       CASE
         WHEN raw_channel IN ('wa', 'whatsapp_api', 'api', 'ghl_whatsapp') THEN 'whatsapp'
         WHEN raw_channel IN ('fb', 'facebook', 'facebook_messenger') THEN 'messenger'
         WHEN raw_channel IN ('ig', 'instagram_dm') THEN 'instagram'
         WHEN raw_channel IN ('sms_qr', 'ghl_sms', 'mms') THEN 'sms'
         WHEN raw_channel IN ('ghl_webchat', 'web_chat', 'chat_web', 'website_chat', 'site_chat') THEN 'webchat'
         WHEN raw_channel IN ('correo', 'mail', 'e_mail') THEN 'email'
         WHEN raw_channel = 'unknown' THEN ''
         ELSE raw_channel
       END AS channel,
       kind
FROM (
  SELECT id, contact_id,
         COALESCE(NULLIF(TRIM(agent_id), ''),
                   NULLIF(TRIM(json_extract(detail, '$.agentId')), ''), NULLIF(TRIM(json_extract(detail, '$.agent_id')), '')) AS attributed_agent,
         REPLACE(REPLACE(LOWER(TRIM(COALESCE(json_extract(detail, '$.channel'), ''))), '-', '_'), ' ', '_') AS raw_channel,
         CASE
              WHEN LOWER(TRIM(json_extract(detail, '$.mode'))) IN ('test', 'preview') OR json_type(detail, '$.dryRun') = 'true' THEN NULL
              WHEN event_type IN ('reply_sent', 'reply_single_sent', 'reply_part_sent',
                  'follow_up_sent', 'payment_resume_reply_sent')
                AND NULLIF(contact_id, '') IS NOT NULL THEN 'reply'
              WHEN event_type = 'signal_set' AND NULLIF(contact_id, '') IS NOT NULL
                AND TRIM(json_extract(detail, '$.signal')) IN ('ready_for_human', 'ready_to_schedule', 'ready_to_buy',
                    'appointment_booked', 'purchase_completed', 'link_sent')
                AND TRIM(json_extract(detail, '$.status')) = 'completed' AND json_type(detail, '$.objectiveCompleted') = 'true'
                AND COALESCE(
                  NULLIF(TRIM(json_extract(detail, '$.agentId')), ''), NULLIF(TRIM(json_extract(detail, '$.agent_id')), '')) IS NOT NULL THEN 'goal'
              WHEN LOWER(event_type) LIKE '%error%'
                OR LOWER(event_type) LIKE '%failed%'
                OR LOWER(event_type) LIKE '%failure%' THEN 'error'
         END AS kind
  FROM (
    SELECT id, event_type, agent_id, contact_id,
           CASE WHEN json_valid(detail_json) THEN detail_json ELSE '{}' END AS detail
    FROM conversational_agent_events
  ) raw
) classified
CROSS JOIN (SELECT 0 AS per_agent UNION ALL SELECT 1) scopes
WHERE kind IS NOT NULL AND (per_agent = 0 OR attributed_agent IS NOT NULL);

CREATE TRIGGER trg_agent_activity_chat_insert
AFTER INSERT ON conversational_agent_activity_chats
BEGIN
  INSERT INTO conversational_agent_activity_summary (scope, answered_conversations, successful_answered_conversations,
    completed_conversations, error_events)
  VALUES (NEW.scope,
          CAST((NEW.reply_events > 0) AS INTEGER),
          CAST((NEW.channel <> '' AND NEW.reply_events > 0 AND NEW.goal_events > 0) AS INTEGER), NEW.goal_events, NEW.error_events)
  ON CONFLICT (scope) DO UPDATE SET
    answered_conversations = conversational_agent_activity_summary.answered_conversations + excluded.answered_conversations,
    successful_answered_conversations = conversational_agent_activity_summary.successful_answered_conversations + excluded.successful_answered_conversations,
    completed_conversations = conversational_agent_activity_summary.completed_conversations + excluded.completed_conversations,
    error_events = conversational_agent_activity_summary.error_events + excluded.error_events;
END;

CREATE TRIGGER trg_agent_activity_chat_update
AFTER UPDATE ON conversational_agent_activity_chats
WHEN (NEW.reply_events > 0) <> (OLD.reply_events > 0) OR NEW.goal_events <> OLD.goal_events
    OR NEW.error_events <> OLD.error_events
BEGIN
  UPDATE conversational_agent_activity_summary SET
    answered_conversations = answered_conversations + CAST((NEW.reply_events > 0) AS INTEGER) - CAST((OLD.reply_events > 0) AS INTEGER),
    successful_answered_conversations = successful_answered_conversations
      + CAST((NEW.channel <> '' AND NEW.reply_events > 0 AND NEW.goal_events > 0) AS INTEGER)
      - CAST((OLD.channel <> '' AND OLD.reply_events > 0 AND OLD.goal_events > 0) AS INTEGER),
    completed_conversations = completed_conversations + NEW.goal_events - OLD.goal_events,
    error_events = error_events + NEW.error_events - OLD.error_events
  WHERE scope = NEW.scope;
END;

CREATE TRIGGER trg_agent_activity_fact_insert
AFTER INSERT ON conversational_agent_activity_facts
BEGIN
  INSERT INTO conversational_agent_activity_chats (scope, contact_id, channel, reply_events, goal_events, error_events)
  VALUES (NEW.scope, NEW.contact_id, NEW.channel,
          CAST((NEW.kind = 'reply') AS INTEGER), CAST((NEW.kind = 'goal') AS INTEGER),
          CAST((NEW.kind = 'error') AS INTEGER))
  ON CONFLICT (scope, contact_id, channel) DO UPDATE SET
    reply_events = conversational_agent_activity_chats.reply_events + excluded.reply_events,
    goal_events = conversational_agent_activity_chats.goal_events + excluded.goal_events,
    error_events = conversational_agent_activity_chats.error_events + excluded.error_events;
END;

CREATE TRIGGER trg_agent_activity_fact_delete
AFTER DELETE ON conversational_agent_activity_facts
BEGIN
  UPDATE conversational_agent_activity_chats SET
    reply_events = reply_events - CAST((OLD.kind = 'reply') AS INTEGER),
    goal_events = goal_events - CAST((OLD.kind = 'goal') AS INTEGER),
    error_events = error_events - CAST((OLD.kind = 'error') AS INTEGER)
  WHERE scope = OLD.scope AND contact_id = OLD.contact_id AND channel = OLD.channel;
  DELETE FROM conversational_agent_activity_chats
  WHERE scope = OLD.scope AND contact_id = OLD.contact_id AND channel = OLD.channel
    AND reply_events = 0 AND goal_events = 0 AND error_events = 0;
END;

CREATE TRIGGER trg_agent_activity_event_insert
AFTER INSERT ON conversational_agent_events
WHEN NEW.event_type IN ('reply_sent', 'reply_single_sent', 'reply_part_sent',
      'follow_up_sent', 'payment_resume_reply_sent', 'signal_set')
    OR LOWER(NEW.event_type) LIKE '%error%'
    OR LOWER(NEW.event_type) LIKE '%failed%'
    OR LOWER(NEW.event_type) LIKE '%failure%'
BEGIN
  INSERT INTO conversational_agent_activity_facts (event_id, scope, contact_id, channel, kind)
  SELECT event_id, scope, contact_id, channel, kind FROM ristak_conversational_activity_source
  WHERE event_id = NEW.id ORDER BY scope;
  UPDATE conversational_agent_events SET activity_metrics_version = 1
  WHERE id = NEW.id AND activity_metrics_version = 0;
END;

CREATE TRIGGER trg_agent_activity_event_update
AFTER UPDATE OF id, event_type, contact_id, agent_id, detail_json ON conversational_agent_events
WHEN OLD.activity_metrics_version = 1
    OR NEW.event_type IN ('reply_sent', 'reply_single_sent', 'reply_part_sent',
      'follow_up_sent', 'payment_resume_reply_sent', 'signal_set')
    OR LOWER(NEW.event_type) LIKE '%error%'
    OR LOWER(NEW.event_type) LIKE '%failed%'
    OR LOWER(NEW.event_type) LIKE '%failure%'
BEGIN
  DELETE FROM conversational_agent_activity_facts WHERE event_id = OLD.id;
  INSERT INTO conversational_agent_activity_facts (event_id, scope, contact_id, channel, kind)
  SELECT event_id, scope, contact_id, channel, kind FROM ristak_conversational_activity_source
  WHERE event_id = NEW.id ORDER BY scope;
  UPDATE conversational_agent_events SET activity_metrics_version = 1
  WHERE id = NEW.id AND activity_metrics_version = 0;
END;

CREATE TRIGGER trg_agent_activity_event_delete
AFTER DELETE ON conversational_agent_events
WHEN OLD.activity_metrics_version = 1
BEGIN
  DELETE FROM conversational_agent_activity_facts WHERE event_id = OLD.id;
END;

UPDATE conversational_agent_metrics_projection_state
SET projection_version = 2, status = 'backfilling', last_error = NULL, updated_at = CURRENT_TIMESTAMP
WHERE singleton_id = 1 AND projection_version < 2;

CREATE INDEX IF NOT EXISTS idx_conversational_agent_activity_pending
  ON conversational_agent_events(id)
  WHERE activity_metrics_version = 0 AND (
    event_type IN ('reply_sent', 'reply_single_sent', 'reply_part_sent',
      'follow_up_sent', 'payment_resume_reply_sent', 'signal_set')
    OR LOWER(event_type) LIKE '%error%'
    OR LOWER(event_type) LIKE '%failed%'
    OR LOWER(event_type) LIKE '%failure%');
