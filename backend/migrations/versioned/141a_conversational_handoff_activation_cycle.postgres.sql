ALTER TABLE conversational_agent_state
  ADD COLUMN IF NOT EXISTS activation_cycle_id TEXT,
  ADD COLUMN IF NOT EXISTS activation_cycle_started_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS activation_cycle_started_message_id TEXT;

-- Compatibilidad con rolling deploy: una instancia anterior todavía puede
-- insertar estados sin conocer estas columnas mientras la nueva arranca. Los
-- defaults se aplican también cuando las columnas ya fueron creadas por el
-- bootstrap, así ningún writer viejo vuelve a abrir el hueco tras el backfill.
ALTER TABLE conversational_agent_state
  ALTER COLUMN activation_cycle_id
    SET DEFAULT (
      'cac_legacy_insert_' ||
      md5(random()::text || clock_timestamp()::text)
    ),
  ALTER COLUMN activation_cycle_started_at
    SET DEFAULT CURRENT_TIMESTAMP;

UPDATE conversational_agent_state
SET activation_cycle_id = CASE
      WHEN activation_cycle_id IS NULL
        OR BTRIM(activation_cycle_id) = ''
        OR activation_cycle_id = id
      THEN 'cac_legacy_backfill_' || id
      ELSE activation_cycle_id
    END,
    activation_cycle_started_at = COALESCE(
      activation_cycle_started_at,
      activated_at,
      created_at,
      updated_at,
      CURRENT_TIMESTAMP
    )
WHERE activation_cycle_id IS NULL
   OR BTRIM(activation_cycle_id) = ''
   OR activation_cycle_id = id
   OR activation_cycle_started_at IS NULL;

ALTER TABLE conversational_agent_state
  ALTER COLUMN activation_cycle_id SET NOT NULL,
  ALTER COLUMN activation_cycle_started_at SET NOT NULL;

-- El binario anterior crea primero el estado y sólo en su claim posterior
-- escribe last_inbound_message_id. Capturamos ese PRIMER mensaje en la base
-- para que dos o más inbounds procesados por el pod viejo no muevan el inicio
-- del ciclo antes de que una instancia nueva alcance a leerlo.
CREATE OR REPLACE FUNCTION capture_conversational_legacy_cycle_anchor()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  inbound_changed BOOLEAN := FALSE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    inbound_changed :=
      NEW.last_inbound_message_id IS DISTINCT FROM OLD.last_inbound_message_id;

    -- Un pod anterior puede reactivar el chat sin conocer las columnas del
    -- ciclo. Sólo rotamos cuando dejó las tres exactamente intactas; un writer
    -- nuevo que ya materializó su propio ciclo conserva plena autoridad.
    IF OLD.status IN ('human', 'completed', 'skipped')
      AND NEW.status = 'active'
      AND NEW.activation_cycle_id IS NOT DISTINCT FROM OLD.activation_cycle_id
      AND NEW.activation_cycle_started_at
        IS NOT DISTINCT FROM OLD.activation_cycle_started_at
      AND NEW.activation_cycle_started_message_id
        IS NOT DISTINCT FROM OLD.activation_cycle_started_message_id
    THEN
      NEW.activation_cycle_id :=
        'cac_legacy_reactivation_' ||
        md5(
          random()::text ||
          clock_timestamp()::text ||
          COALESCE(NEW.id::text, '')
        );
      NEW.activation_cycle_started_at := CURRENT_TIMESTAMP;
      NEW.activation_cycle_started_message_id := NULL;
    END IF;
  ELSE
    inbound_changed := TRUE;
  END IF;

  IF NEW.status = 'active'
    AND (
      NEW.activation_cycle_id LIKE 'cac_legacy_insert_%'
      OR NEW.activation_cycle_id LIKE 'cac_legacy_reactivation_%'
    )
    AND NULLIF(BTRIM(COALESCE(
      NEW.activation_cycle_started_message_id,
      ''
    )), '') IS NULL
    AND inbound_changed
    AND NULLIF(BTRIM(COALESCE(NEW.last_inbound_message_id, '')), '') IS NOT NULL
  THEN
    NEW.activation_cycle_started_message_id := NEW.last_inbound_message_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_conv_agent_state_legacy_cycle_anchor
  ON conversational_agent_state;

CREATE TRIGGER trg_conv_agent_state_legacy_cycle_anchor
BEFORE INSERT OR UPDATE OF status, last_inbound_message_id
ON conversational_agent_state
FOR EACH ROW
EXECUTE FUNCTION capture_conversational_legacy_cycle_anchor();
