-- Cierra carreras entre mensajes distintos que intentan crear el mismo cobro.
-- La idempotency key sigue protegiendo un inbound; esta tabla protege la
-- identidad financiera estable (agente, contacto, producto, monto, moneda,
-- pasarela, propósito y, cuando aplica, selección de cita).
CREATE TABLE IF NOT EXISTS conversational_payment_semantic_claims (
  semantic_key TEXT PRIMARY KEY,
  identity_hash TEXT NOT NULL,
  owner_request_key TEXT NOT NULL,
  canonical_request_key TEXT,
  status TEXT NOT NULL DEFAULT 'processing',
  error_message TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_conversational_payment_semantic_claim_owner
  ON conversational_payment_semantic_claims(owner_request_key, status);
