-- (AI-009) Persistencia del debounce/delay de reruns del agente conversacional.
-- En runner.js el Map en memoria pendingContactReruns guarda los reruns encolados
-- cuando ya hay una ejecución en curso para ese contacto/canal. Ese estado se pierde
-- en un reinicio: si el proceso muere mientras un rerun estaba encolado, ese mensaje
-- entrante podía quedar sin atender. Esta tabla lo persiste para reconstruirlo al boot.
--
-- (AI-003) Complementa la recuperación de follow-ups/recovery (que ya viven en columnas
-- de conversational_agent_state y se reprograman al arrancar): este pendiente cubre el
-- hueco del rerun encolado que no sobrevivía al reinicio.
--
-- Aditiva e idempotente. Compatible SQLite (dev) y PostgreSQL (prod). TEXT para los
-- timestamps en formato 'YYYY-MM-DD HH:MM:SS'; sin CURRENT_TIMESTAMP en defaults para
-- no romper SQLite.
CREATE TABLE IF NOT EXISTS ai_agent_pending_reruns (
  run_key TEXT PRIMARY KEY,
  contact_id TEXT,
  channel TEXT,
  scheduled_for TEXT,
  payload TEXT,
  created_at TEXT
);
