CREATE TABLE IF NOT EXISTS conversational_agent_manual_assignments (
  contact_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  paused_until_at DATETIME,
  assigned_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  assigned_by TEXT,
  updated_by TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE,
  FOREIGN KEY (agent_id) REFERENCES conversational_agents(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_conv_agent_manual_assignment_agent_status
  ON conversational_agent_manual_assignments(agent_id, status, updated_at);

INSERT OR IGNORE INTO conversational_agent_manual_assignments (
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
SELECT
  ranked.contact_id,
  ranked.agent_id,
  ranked.status,
  ranked.paused_until_at,
  COALESCE(ranked.assigned_at, ranked.updated_at, CURRENT_TIMESTAMP),
  COALESCE(ranked.assigned_by, ranked.updated_by, 'user'),
  COALESCE(ranked.updated_by, 'user'),
  COALESCE(ranked.created_at, CURRENT_TIMESTAMP),
  COALESCE(ranked.updated_at, CURRENT_TIMESTAMP)
FROM (
  SELECT
    state.*,
    ROW_NUMBER() OVER (
      PARTITION BY state.contact_id
      ORDER BY COALESCE(state.assigned_at, state.updated_at, state.created_at) DESC, state.id DESC
    ) AS row_number
  FROM conversational_agent_state state
  INNER JOIN conversational_agents agent ON agent.id = state.agent_id
  WHERE state.agent_id IS NOT NULL
    AND state.assignment_source = 'manual'
    AND state.status IN ('active', 'paused', 'human', 'skipped')
) ranked
WHERE ranked.row_number = 1;
