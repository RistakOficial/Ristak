-- Las metas completadas antes del ledger durable ya ejecutaron sus efectos con
-- el flujo legacy. Se marcan una sola vez para que el primer deploy no vuelva a
-- emitir señales, asignaciones, extras ni notificaciones históricas.
UPDATE conversational_agent_goal_links
SET completion_effects_status = 'completed',
    completion_effects_updated_at = COALESCE(completed_at, updated_at, created_at)
WHERE status = 'completed'
  AND completion_effects_status IS NULL;
