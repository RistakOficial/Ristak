-- Informational associations only. No payment, enrollment or access is updated.
-- Each Ristak installation owns its DB; target_key pins the configured MCP URL.
CREATE TABLE IF NOT EXISTS program_payment_product_mappings (
  -- Catalog mirrors may prune removed products. Keep historical evidence without
  -- preventing that existing operation; active products are validated on writes.
  product_id TEXT PRIMARY KEY,
  target_key TEXT NOT NULL,
  program_id TEXT NOT NULL,
  program_title TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS program_payment_associations (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL CHECK (source_type IN ('payment', 'plan')),
  source_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  email TEXT NOT NULL,
  product_id TEXT NOT NULL REFERENCES program_payment_product_mappings(product_id),
  target_key TEXT NOT NULL,
  program_id TEXT NOT NULL,
  student_id TEXT NOT NULL,
  enrollment_id TEXT NOT NULL,
  source_revision TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  classification TEXT NOT NULL CHECK (classification IN ('explicit_product', 'user_decision')),
  created_by TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (source_type, source_id)
);

-- Audit survives contact/payment removal; no raw receipt, token or progress body.
CREATE TABLE IF NOT EXISTS program_payment_association_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL CHECK (event_type IN ('mapping_created', 'association_created')),
  association_id TEXT,
  product_id TEXT NOT NULL,
  source_type TEXT,
  source_id TEXT,
  actor_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS program_payment_associations_contact
  ON program_payment_associations(contact_id, id);

CREATE INDEX IF NOT EXISTS installment_payments_program_association_parent
  ON installment_payments(payment_id, flow_id, id);
