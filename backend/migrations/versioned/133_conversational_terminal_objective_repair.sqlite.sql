-- Repara estados que una versión anterior reabrió automáticamente después de
-- cumplir un objetivo terminal. Una reactivación manual posterior conserva su
-- autoridad y queda fuera del backfill.
WITH ranked_reopens AS (
  SELECT
    event.contact_id,
    event.agent_id,
    event.created_at,
    event.id,
    ROW_NUMBER() OVER (
      PARTITION BY event.contact_id, event.agent_id
      ORDER BY event.created_at DESC, event.id DESC
    ) AS reopen_rank
  FROM conversational_agent_events event
  WHERE event.event_type = 'agent_reopened'
    AND event.agent_id IS NOT NULL
    AND json_valid(event.detail_json) = 1
    AND json_extract(event.detail_json, '$.reason') = 'new_inbound_after_completion'
),
latest_reopens AS (
  SELECT contact_id, agent_id, created_at, id
  FROM ranked_reopens
  WHERE reopen_rank = 1
),
ranked_completions AS (
  SELECT
    state.id AS state_id,
    state.contact_id,
    state.agent_id,
    completion.created_at AS signal_at,
    json_extract(completion.detail_json, '$.signal') AS signal,
    COALESCE(json_extract(completion.detail_json, '$.reason'), '') AS signal_reason,
    COALESCE(
      NULLIF(json_extract(completion.detail_json, '$.summary'), ''),
      NULLIF(json_extract(completion.detail_json, '$.actionSummary'), ''),
      state.signal_summary,
      ''
    ) AS signal_summary,
    ROW_NUMBER() OVER (
      PARTITION BY state.id
      ORDER BY completion.created_at DESC, completion.id DESC
    ) AS completion_rank
  FROM conversational_agent_state state
  JOIN latest_reopens reopen
    ON reopen.contact_id = state.contact_id
   AND reopen.agent_id = state.agent_id
  JOIN conversational_agent_events completion
    ON completion.contact_id = state.contact_id
   AND completion.agent_id = state.agent_id
   AND completion.event_type = 'signal_set'
   AND completion.created_at <= reopen.created_at
   AND json_valid(completion.detail_json) = 1
   AND json_extract(completion.detail_json, '$.status') = 'completed'
   AND json_extract(completion.detail_json, '$.objectiveCompleted') = 1
   AND COALESCE(json_extract(completion.detail_json, '$.signal'), '') <> ''
  WHERE state.status IN ('active', 'paused')
    AND NOT EXISTS (
      SELECT 1
      FROM conversational_agent_events manual_activation
      WHERE manual_activation.contact_id = state.contact_id
        AND manual_activation.agent_id = state.agent_id
        AND manual_activation.event_type = 'status_changed'
        AND manual_activation.created_at > reopen.created_at
        AND json_valid(manual_activation.detail_json) = 1
        AND json_extract(manual_activation.detail_json, '$.status') = 'active'
        AND LOWER(COALESCE(json_extract(manual_activation.detail_json, '$.updatedBy'), ''))
          IN ('user', 'human', 'manual')
    )
),
candidates AS (
  SELECT *
  FROM ranked_completions
  WHERE completion_rank = 1
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
WHERE 1 = 1
ON CONFLICT(id) DO NOTHING;

WITH ranked_reopens AS (
  SELECT
    event.contact_id,
    event.agent_id,
    event.created_at,
    event.id,
    ROW_NUMBER() OVER (
      PARTITION BY event.contact_id, event.agent_id
      ORDER BY event.created_at DESC, event.id DESC
    ) AS reopen_rank
  FROM conversational_agent_events event
  WHERE event.event_type = 'agent_reopened'
    AND event.agent_id IS NOT NULL
    AND json_valid(event.detail_json) = 1
    AND json_extract(event.detail_json, '$.reason') = 'new_inbound_after_completion'
),
latest_reopens AS (
  SELECT contact_id, agent_id, created_at, id
  FROM ranked_reopens
  WHERE reopen_rank = 1
),
ranked_completions AS (
  SELECT
    state.id AS state_id,
    completion.created_at AS signal_at,
    json_extract(completion.detail_json, '$.signal') AS signal,
    COALESCE(json_extract(completion.detail_json, '$.reason'), '') AS signal_reason,
    COALESCE(
      NULLIF(json_extract(completion.detail_json, '$.summary'), ''),
      NULLIF(json_extract(completion.detail_json, '$.actionSummary'), ''),
      state.signal_summary,
      ''
    ) AS signal_summary,
    ROW_NUMBER() OVER (
      PARTITION BY state.id
      ORDER BY completion.created_at DESC, completion.id DESC
    ) AS completion_rank
  FROM conversational_agent_state state
  JOIN latest_reopens reopen
    ON reopen.contact_id = state.contact_id
   AND reopen.agent_id = state.agent_id
  JOIN conversational_agent_events completion
    ON completion.contact_id = state.contact_id
   AND completion.agent_id = state.agent_id
   AND completion.event_type = 'signal_set'
   AND completion.created_at <= reopen.created_at
   AND json_valid(completion.detail_json) = 1
   AND json_extract(completion.detail_json, '$.status') = 'completed'
   AND json_extract(completion.detail_json, '$.objectiveCompleted') = 1
   AND COALESCE(json_extract(completion.detail_json, '$.signal'), '') <> ''
  WHERE state.status IN ('active', 'paused')
    AND NOT EXISTS (
      SELECT 1
      FROM conversational_agent_events manual_activation
      WHERE manual_activation.contact_id = state.contact_id
        AND manual_activation.agent_id = state.agent_id
        AND manual_activation.event_type = 'status_changed'
        AND manual_activation.created_at > reopen.created_at
        AND json_valid(manual_activation.detail_json) = 1
        AND json_extract(manual_activation.detail_json, '$.status') = 'active'
        AND LOWER(COALESCE(json_extract(manual_activation.detail_json, '$.updatedBy'), ''))
          IN ('user', 'human', 'manual')
    )
),
candidates AS (
  SELECT *
  FROM ranked_completions
  WHERE completion_rank = 1
)
UPDATE conversational_agent_state
SET status = 'completed',
    signal = (SELECT signal FROM candidates WHERE state_id = conversational_agent_state.id),
    signal_reason = (SELECT signal_reason FROM candidates WHERE state_id = conversational_agent_state.id),
    signal_summary = (SELECT signal_summary FROM candidates WHERE state_id = conversational_agent_state.id),
    signal_at = (SELECT signal_at FROM candidates WHERE state_id = conversational_agent_state.id),
    paused_until_at = NULL,
    updated_by = 'system',
    updated_at = CURRENT_TIMESTAMP
WHERE id IN (SELECT state_id FROM candidates);
