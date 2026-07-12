CREATE UNIQUE INDEX IF NOT EXISTS idx_conv_agent_test_effect_run_identity
  ON conversational_agent_test_effects(id, run_id);

CREATE TABLE IF NOT EXISTS conversational_agent_test_payment_links (
  effect_id TEXT PRIMARY KEY,
  test_run_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  requested_by_user_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'creating',
  payment_id TEXT,
  public_payment_id TEXT,
  provider TEXT,
  -- Unidades mayores de la moneda (por ejemplo, 1200.50 MXN), normalizadas por
  -- el servidor a los decimales oficiales antes de persistir.
  -- NUMERIC evita que PostgreSQL redondee importes válidos como sucede con
  -- REAL (float4). El servicio sigue normalizando a los decimales oficiales de
  -- la moneda antes de escribir y comparar este ledger.
  amount NUMERIC(20, 6),
  currency TEXT,
  payment_mode TEXT NOT NULL DEFAULT 'test',
  payment_url TEXT,
  cleanup_due_at DATETIME NOT NULL,
  paid_at DATETIME,
  cleaned_at DATETIME,
  claim_token TEXT,
  lease_until_at DATETIME,
  cleanup_attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  invalidation_status TEXT,
  invalidation_error TEXT,
  metadata_json TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  -- El ledger es la autoridad que invalida el artefacto externo. Borrar primero
  -- run/effect no debe hacer desaparecer esa autoridad de limpieza.
  FOREIGN KEY (effect_id, test_run_id)
    REFERENCES conversational_agent_test_effects(id, run_id) ON DELETE RESTRICT,
  FOREIGN KEY (test_run_id) REFERENCES conversational_agent_test_runs(id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_conv_agent_test_payment_payment
  ON conversational_agent_test_payment_links(payment_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_conv_agent_test_payment_public
  ON conversational_agent_test_payment_links(public_payment_id);
CREATE INDEX IF NOT EXISTS idx_conv_agent_test_payment_cleanup
  ON conversational_agent_test_payment_links(status, cleanup_due_at);
CREATE INDEX IF NOT EXISTS idx_conv_agent_test_payment_run
  ON conversational_agent_test_payment_links(test_run_id, updated_at);
