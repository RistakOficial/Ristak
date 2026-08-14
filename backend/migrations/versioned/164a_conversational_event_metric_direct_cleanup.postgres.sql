-- La sesión de reparación descuenta el summary por shard antes de borrar el
-- ledger. Con el mismo flag local omitimos el trigger y evitamos la doble
-- escritura UPDATE included=0 + DELETE para millones de renglones. Fuera de esa
-- transacción, todo DELETE incluido conserva el comportamiento canónico.
DROP TRIGGER IF EXISTS trg_conversational_event_metric_ledger_delete
ON conversational_agent_event_metric_rows;

CREATE TRIGGER trg_conversational_event_metric_ledger_delete
AFTER DELETE ON conversational_agent_event_metric_rows
FOR EACH ROW
WHEN (
  OLD.included = 1
  AND current_setting(
    'ristak.skip_conversational_event_metrics_reproject',
    true
  ) IS DISTINCT FROM 'on'
)
EXECUTE FUNCTION ristak_conversational_event_metric_ledger_delete();
