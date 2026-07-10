-- Conserva la propiedad de evidencias ya confirmadas antes de introducir la
-- tombstone independiente. Sólo se migran filas con evidencia real; las metas
-- históricas sin external_evidence_key no se inventan ni se vuelven claimables.
INSERT INTO conversational_agent_goal_evidence_claims (
  external_evidence_key,
  external_source,
  confirmation_fingerprint,
  goal_id,
  completion_auth_method,
  completion_actor_id,
  completion_request_id,
  claimed_at
)
SELECT
  external_evidence_key,
  COALESCE(NULLIF(external_source, ''), 'legacy:unknown'),
  external_evidence_key,
  id,
  COALESCE(NULLIF(completion_auth_method, ''), 'legacy_unknown'),
  COALESCE(completion_actor_id, ''),
  COALESCE(NULLIF(completion_request_id, ''), 'legacy:' || id),
  COALESCE(completed_at, updated_at, created_at, CURRENT_TIMESTAMP)
FROM conversational_agent_goal_links
WHERE external_evidence_key IS NOT NULL
  AND external_evidence_key != ''
ON CONFLICT DO NOTHING;
