-- Repara estados que una versión anterior reabrió automáticamente después de
-- cumplir un objetivo terminal. Una reactivación manual posterior conserva su
-- autoridad y queda fuera del backfill.
WITH latest_reopens AS (
  SELECT DISTINCT ON (event.contact_id, event.agent_id)
    event.contact_id,
    event.agent_id,
    event.created_at,
    event.id
  FROM conversational_agent_events event
  WHERE event.event_type = 'agent_reopened'
    AND event.agent_id IS NOT NULL
    AND event.detail_json IS JSON
    AND event.detail_json::jsonb ->> 'reason' = 'new_inbound_after_completion'
  ORDER BY event.contact_id, event.agent_id, event.created_at DESC, event.id DESC
),
candidates AS (
  SELECT DISTINCT ON (state.id)
    state.id AS state_id,
    state.contact_id,
    state.agent_id,
    completion.created_at AS signal_at,
    completion.detail_json::jsonb ->> 'signal' AS signal,
    COALESCE(completion.detail_json::jsonb ->> 'reason', '') AS signal_reason,
    COALESCE(
      NULLIF(completion.detail_json::jsonb ->> 'summary', ''),
      NULLIF(completion.detail_json::jsonb ->> 'actionSummary', ''),
      state.signal_summary,
      ''
    ) AS signal_summary
  FROM conversational_agent_state state
  JOIN latest_reopens reopen
    ON reopen.contact_id = state.contact_id
   AND reopen.agent_id = state.agent_id
  JOIN conversational_agent_events completion
    ON completion.contact_id = state.contact_id
   AND completion.agent_id = state.agent_id
   AND completion.event_type = 'signal_set'
   AND completion.created_at <= reopen.created_at
   AND completion.detail_json IS JSON
   AND completion.detail_json::jsonb ->> 'status' = 'completed'
   AND completion.detail_json::jsonb ->> 'objectiveCompleted' = 'true'
   AND COALESCE(completion.detail_json::jsonb ->> 'signal', '') <> ''
  WHERE state.status IN ('active', 'paused')
    AND NOT EXISTS (
      SELECT 1
      FROM conversational_agent_events manual_activation
      WHERE manual_activation.contact_id = state.contact_id
        AND manual_activation.agent_id = state.agent_id
        AND manual_activation.event_type = 'status_changed'
        AND manual_activation.created_at > reopen.created_at
        AND manual_activation.detail_json IS JSON
        AND manual_activation.detail_json::jsonb ->> 'status' = 'active'
        AND LOWER(COALESCE(manual_activation.detail_json::jsonb ->> 'updatedBy', ''))
          IN ('user', 'human', 'manual')
    )
  ORDER BY state.id, completion.created_at DESC, completion.id DESC
)
INSERT INTO conversational_agent_events (
  id,
  contact_id,
  agent_id,
  event_type,
  detail_json,
  created_at
)
SELECT
  'cae_restore_completed_' || state_id,
  contact_id,
  agent_id,
  'terminal_state_restored',
  '{"reason":"legacy_auto_reopen_repaired","status":"completed"}',
  CURRENT_TIMESTAMP
FROM candidates
ON CONFLICT(id) DO NOTHING;

WITH latest_reopens AS (
  SELECT DISTINCT ON (event.contact_id, event.agent_id)
    event.contact_id,
    event.agent_id,
    event.created_at,
    event.id
  FROM conversational_agent_events event
  WHERE event.event_type = 'agent_reopened'
    AND event.agent_id IS NOT NULL
    AND event.detail_json IS JSON
    AND event.detail_json::jsonb ->> 'reason' = 'new_inbound_after_completion'
  ORDER BY event.contact_id, event.agent_id, event.created_at DESC, event.id DESC
),
candidates AS (
  SELECT DISTINCT ON (state.id)
    state.id AS state_id,
    completion.created_at AS signal_at,
    completion.detail_json::jsonb ->> 'signal' AS signal,
    COALESCE(completion.detail_json::jsonb ->> 'reason', '') AS signal_reason,
    COALESCE(
      NULLIF(completion.detail_json::jsonb ->> 'summary', ''),
      NULLIF(completion.detail_json::jsonb ->> 'actionSummary', ''),
      state.signal_summary,
      ''
    ) AS signal_summary
  FROM conversational_agent_state state
  JOIN latest_reopens reopen
    ON reopen.contact_id = state.contact_id
   AND reopen.agent_id = state.agent_id
  JOIN conversational_agent_events completion
    ON completion.contact_id = state.contact_id
   AND completion.agent_id = state.agent_id
   AND completion.event_type = 'signal_set'
   AND completion.created_at <= reopen.created_at
   AND completion.detail_json IS JSON
   AND completion.detail_json::jsonb ->> 'status' = 'completed'
   AND completion.detail_json::jsonb ->> 'objectiveCompleted' = 'true'
   AND COALESCE(completion.detail_json::jsonb ->> 'signal', '') <> ''
  WHERE state.status IN ('active', 'paused')
    AND NOT EXISTS (
      SELECT 1
      FROM conversational_agent_events manual_activation
      WHERE manual_activation.contact_id = state.contact_id
        AND manual_activation.agent_id = state.agent_id
        AND manual_activation.event_type = 'status_changed'
        AND manual_activation.created_at > reopen.created_at
        AND manual_activation.detail_json IS JSON
        AND manual_activation.detail_json::jsonb ->> 'status' = 'active'
        AND LOWER(COALESCE(manual_activation.detail_json::jsonb ->> 'updatedBy', ''))
          IN ('user', 'human', 'manual')
    )
  ORDER BY state.id, completion.created_at DESC, completion.id DESC
)
UPDATE conversational_agent_state state
SET status = 'completed',
    signal = candidates.signal,
    signal_reason = candidates.signal_reason,
    signal_summary = candidates.signal_summary,
    signal_at = candidates.signal_at,
    paused_until_at = NULL,
    updated_by = 'system',
    updated_at = CURRENT_TIMESTAMP
FROM candidates
WHERE state.id = candidates.state_id;
