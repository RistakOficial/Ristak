CREATE SEQUENCE IF NOT EXISTS report_transaction_revision_seq
  AS BIGINT
  MINVALUE 1
  START WITH 1
  INCREMENT BY 1
  CACHE 1;

CREATE TABLE IF NOT EXISTS report_transaction_summary_cache (
  account_scope TEXT NOT NULL,
  cache_key TEXT NOT NULL,
  source_revision BIGINT NOT NULL,
  count_value BIGINT NOT NULL DEFAULT 0,
  total_amount NUMERIC(30, 6) NOT NULL DEFAULT 0,
  built_at TIMESTAMPTZ NOT NULL,
  last_accessed_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (account_scope, cache_key)
);

CREATE OR REPLACE FUNCTION ristak_bump_report_transaction_revision()
RETURNS TRIGGER AS $$
BEGIN
  -- Una secuencia no bloquea una fila compartida: pagos concurrentes no quedan
  -- serializados por la invalidación del resumen.
  PERFORM nextval('report_transaction_revision_seq');
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_report_transaction_revision ON payments;
CREATE TRIGGER trg_report_transaction_revision
AFTER INSERT OR UPDATE OR DELETE ON payments
FOR EACH STATEMENT EXECUTE FUNCTION ristak_bump_report_transaction_revision();
