-- Cierra la carrera del cutover replaying -> ready sin volver a sondear deltas.
--
-- El worker toma FOR UPDATE sobre el singleton antes de certificar que las
-- colas están vacías. Los triggers toman FOR SHARE antes de decidir entre
-- escribir un delta o actualizar el contador vivo. Así, un evento concurrente
-- queda completamente antes o después del corte; nunca puede publicar un delta
-- no aplicado después de que el worker haya declarado la proyección ready.

CREATE OR REPLACE FUNCTION ristak_bump_whatsapp_status_metric(
  metric_name TEXT,
  entity_id TEXT,
  delta BIGINT
)
RETURNS VOID AS $$
DECLARE
  projection_status TEXT;
BEGIN
  IF delta = 0 THEN RETURN; END IF;

  SELECT status INTO projection_status
  FROM whatsapp_status_projection_state
  WHERE singleton_id = 1
  FOR SHARE;

  IF projection_status IS DISTINCT FROM 'ready' THEN
    INSERT INTO whatsapp_status_metric_deltas (metric, shard, delta)
    VALUES (
      metric_name,
      ristak_whatsapp_status_shard(entity_id),
      delta
    );
    RETURN;
  END IF;

  INSERT INTO whatsapp_status_metric_counters (
    metric, shard, counter_value, updated_at
  ) VALUES (
    metric_name, ristak_whatsapp_status_shard(entity_id), delta, CURRENT_TIMESTAMP
  )
  ON CONFLICT (metric, shard) DO UPDATE SET
    counter_value = whatsapp_status_metric_counters.counter_value + EXCLUDED.counter_value,
    updated_at = CURRENT_TIMESTAMP;
END;
$$ LANGUAGE plpgsql;

-- La proyección de routing toma después un advisory lock por contacto. Este
-- BEFORE trigger serializa primero al writer con el finalizer. El worker nunca
-- conserva ambos locks: baseline/drain confirman antes y el finalizer toma sólo
-- el singleton, evitando el ciclo singleton <-> contacto.
CREATE OR REPLACE FUNCTION ristak_lock_whatsapp_routing_status_cutover()
RETURNS TRIGGER AS $$
DECLARE
  projection_status TEXT;
BEGIN
  SELECT status INTO projection_status
  FROM whatsapp_status_projection_state
  WHERE singleton_id = 1
  FOR SHARE;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS aa_trg_whatsapp_routing_status_cutover ON whatsapp_routing_events;
CREATE TRIGGER aa_trg_whatsapp_routing_status_cutover
BEFORE INSERT OR UPDATE OR DELETE ON whatsapp_routing_events
FOR EACH ROW EXECUTE FUNCTION ristak_lock_whatsapp_routing_status_cutover();

-- Si una versión anterior dejó un delta en la ventana de carrera, una única
-- transición a replaying hace que el scheduler de arranque lo drene. Una base
-- nueva sigue en backfilling y no salta el baseline histórico.
UPDATE whatsapp_status_projection_state
SET status = 'replaying', updated_at = CURRENT_TIMESTAMP
WHERE singleton_id = 1
  AND projection_version = 1
  AND status = 'ready';
