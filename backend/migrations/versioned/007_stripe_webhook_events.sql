-- (PAY-005) Dedupe de webhooks de Stripe por event.id. Stripe reintenta entregas; sin
-- esto, un reintento re-procesa el evento (doble registro de pago/reembolso). Guardamos
-- el id de cada evento procesado (PRIMARY KEY) para reclamarlo de forma atómica.
-- Aditiva e idempotente vía el runner versionado.
CREATE TABLE IF NOT EXISTS stripe_webhook_events (
  event_id TEXT PRIMARY KEY,
  type TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
