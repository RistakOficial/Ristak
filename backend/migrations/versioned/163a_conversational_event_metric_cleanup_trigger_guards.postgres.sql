-- El ledger sólo necesita descontar el summary cuando la fila todavía estaba
-- incluida. La reparación masiva la marca included=0 después de descontar el
-- shard en bloque, así que evitamos invocar PL/pgSQL miles de veces sin efecto.
DROP TRIGGER IF EXISTS trg_conversational_event_metric_ledger_delete
ON conversational_agent_event_metric_rows;

CREATE TRIGGER trg_conversational_event_metric_ledger_delete
AFTER DELETE ON conversational_agent_event_metric_rows
FOR EACH ROW
WHEN (OLD.included = 1)
EXECUTE FUNCTION ristak_conversational_event_metric_ledger_delete();

-- Separamos escritura y borrado para que el flag local de mantenimiento pueda
-- omitir por completo el trigger de DELETE. Las conexiones normales no tienen
-- ese flag y conservan la reproyección canónica.
DROP TRIGGER IF EXISTS trg_conversational_event_metrics_sync
ON conversational_agent_events;
DROP TRIGGER IF EXISTS trg_conversational_event_metrics_sync_write
ON conversational_agent_events;
DROP TRIGGER IF EXISTS trg_conversational_event_metrics_sync_delete
ON conversational_agent_events;

CREATE TRIGGER trg_conversational_event_metrics_sync_write
AFTER INSERT OR UPDATE OF id, event_type
ON conversational_agent_events
FOR EACH ROW
EXECUTE FUNCTION ristak_conversational_agent_metrics_reproject();

CREATE TRIGGER trg_conversational_event_metrics_sync_delete
AFTER DELETE ON conversational_agent_events
FOR EACH ROW
WHEN (
  current_setting(
    'ristak.skip_conversational_event_metrics_reproject',
    true
  ) IS DISTINCT FROM 'on'
)
EXECUTE FUNCTION ristak_conversational_agent_metrics_reproject();
