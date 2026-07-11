UPDATE conversational_agents
SET runtime_mode = 'tool_calling_v2'
WHERE runtime_mode IS NULL OR runtime_mode <> 'tool_calling_v2';

UPDATE conversational_agents
SET capabilities_config = '{"schemaVersion":1,"items":[]}'
WHERE capabilities_config IS NULL OR TRIM(capabilities_config) = '';

UPDATE conversational_agent_state
SET status = 'active',
    signal = NULL,
    signal_reason = NULL,
    signal_summary = NULL,
    signal_at = NULL,
    updated_at = CURRENT_TIMESTAMP
WHERE status = 'discarded' OR signal = 'discarded';

DROP TABLE IF EXISTS conversational_agent_learning_versions;
DROP TABLE IF EXISTS conversational_agent_policy_versions;
