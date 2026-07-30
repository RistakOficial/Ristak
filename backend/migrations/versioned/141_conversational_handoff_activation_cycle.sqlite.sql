-- initTables agrega estas columnas de forma compatible antes de ejecutar el
-- runner versionado. La lectura falla cerrado si el reparador no convergió.
SELECT activation_cycle_id, activation_cycle_started_at, activation_cycle_started_message_id
FROM conversational_agent_state
LIMIT 0;

UPDATE conversational_agent_state
SET activation_cycle_id = CASE
      WHEN activation_cycle_id IS NULL
        OR TRIM(activation_cycle_id) = ''
        OR activation_cycle_id = id
      THEN 'cac_legacy_backfill_' || id
      ELSE activation_cycle_id
    END,
    activation_cycle_started_at = COALESCE(
      activation_cycle_started_at,
      activated_at,
      created_at,
      updated_at,
      CURRENT_TIMESTAMP
    )
WHERE activation_cycle_id IS NULL
   OR TRIM(activation_cycle_id) = ''
   OR activation_cycle_id = id
   OR activation_cycle_started_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_conv_agent_events_contact_agent_type_created
  ON conversational_agent_events(contact_id, agent_id, event_type, created_at, id);
