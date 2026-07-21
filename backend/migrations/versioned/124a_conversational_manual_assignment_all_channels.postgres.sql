CREATE TABLE IF NOT EXISTS conversational_agent_manual_assignments (
  contact_id TEXT PRIMARY KEY REFERENCES contacts(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES conversational_agents(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active',
  paused_until_at TIMESTAMP,
  assigned_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  assigned_by TEXT,
  updated_by TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_conv_agent_manual_assignment_agent_status
  ON conversational_agent_manual_assignments(agent_id, status, updated_at);

-- Las asignaciones manuales existentes ya expresaban intencion del usuario,
-- aunque por el bug anterior quedaran guardadas bajo el canal por defecto.
-- Conservamos solo la mas reciente por contacto como politica multicanal.
INSERT INTO conversational_agent_manual_assignments (
  contact_id,
  agent_id,
  status,
  paused_until_at,
  assigned_at,
  assigned_by,
  updated_by,
  created_at,
  updated_at
)
SELECT DISTINCT ON (state.contact_id)
  state.contact_id,
  state.agent_id,
  state.status,
  state.paused_until_at,
  COALESCE(state.assigned_at, state.updated_at, CURRENT_TIMESTAMP),
  COALESCE(state.assigned_by, state.updated_by, 'user'),
  COALESCE(state.updated_by, 'user'),
  COALESCE(state.created_at, CURRENT_TIMESTAMP),
  COALESCE(state.updated_at, CURRENT_TIMESTAMP)
FROM conversational_agent_state state
INNER JOIN conversational_agents agent ON agent.id = state.agent_id
WHERE state.agent_id IS NOT NULL
  AND state.assignment_source = 'manual'
  AND state.status IN ('active', 'paused', 'human', 'skipped')
ORDER BY state.contact_id,
  COALESCE(state.assigned_at, state.updated_at, state.created_at) DESC,
  state.id DESC
ON CONFLICT(contact_id) DO NOTHING;
