DO $$
DECLARE
  cycle_id_type TEXT;
  cycle_started_type TEXT;
  cycle_started_message_type TEXT;
  cycle_id_not_null BOOLEAN;
  cycle_started_not_null BOOLEAN;
  cycle_id_default TEXT;
  cycle_started_default TEXT;
  legacy_anchor_trigger_definition TEXT;
  legacy_anchor_function_definition TEXT;
  index_mismatch BOOLEAN;
BEGIN
  SELECT
    format_type(attribute.atttypid, attribute.atttypmod),
    attribute.attnotnull,
    pg_get_expr(column_default.adbin, column_default.adrelid)
  INTO cycle_id_type, cycle_id_not_null, cycle_id_default
  FROM pg_attribute attribute
  LEFT JOIN pg_attrdef column_default
    ON column_default.adrelid = attribute.attrelid
   AND column_default.adnum = attribute.attnum
  WHERE attribute.attrelid = to_regclass('conversational_agent_state')
    AND attribute.attname = 'activation_cycle_id'
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  SELECT
    format_type(attribute.atttypid, attribute.atttypmod),
    attribute.attnotnull,
    pg_get_expr(column_default.adbin, column_default.adrelid)
  INTO cycle_started_type, cycle_started_not_null, cycle_started_default
  FROM pg_attribute attribute
  LEFT JOIN pg_attrdef column_default
    ON column_default.adrelid = attribute.attrelid
   AND column_default.adnum = attribute.attnum
  WHERE attribute.attrelid = to_regclass('conversational_agent_state')
    AND attribute.attname = 'activation_cycle_started_at'
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  SELECT format_type(attribute.atttypid, attribute.atttypmod)
  INTO cycle_started_message_type
  FROM pg_attribute attribute
  WHERE attribute.attrelid = to_regclass('conversational_agent_state')
    AND attribute.attname = 'activation_cycle_started_message_id'
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  IF cycle_id_type IS DISTINCT FROM 'text' THEN
    RAISE EXCEPTION
      'conversational_agent_state.activation_cycle_id está ausente o no es text'
      USING ERRCODE = '55000';
  END IF;

  IF cycle_started_type IS NULL OR cycle_started_type NOT IN (
    'timestamp without time zone',
    'timestamp with time zone'
  ) THEN
    RAISE EXCEPTION
      'conversational_agent_state.activation_cycle_started_at está ausente o no es timestamp'
      USING ERRCODE = '55000';
  END IF;

  IF cycle_started_message_type IS DISTINCT FROM 'text' THEN
    RAISE EXCEPTION
      'conversational_agent_state.activation_cycle_started_message_id está ausente o no es text'
      USING ERRCODE = '55000';
  END IF;

  IF cycle_id_not_null IS DISTINCT FROM TRUE
    OR cycle_id_default IS NULL
    OR POSITION('cac_legacy_insert_' IN LOWER(cycle_id_default)) = 0
    OR POSITION('md5' IN LOWER(cycle_id_default)) = 0
  THEN
    RAISE EXCEPTION
      'conversational_agent_state.activation_cycle_id no protege writers legacy'
      USING ERRCODE = '55000';
  END IF;

  IF cycle_started_not_null IS DISTINCT FROM TRUE
    OR cycle_started_default IS NULL
    OR cycle_started_default !~* '(current_timestamp|now\(\))'
  THEN
    RAISE EXCEPTION
      'conversational_agent_state.activation_cycle_started_at no protege writers legacy'
      USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM conversational_agent_state
    WHERE activation_cycle_id IS NULL
       OR BTRIM(activation_cycle_id) = ''
       OR activation_cycle_id = id
       OR activation_cycle_started_at IS NULL
  ) THEN
    RAISE EXCEPTION
      'conversational_agent_state conserva ciclos de activación incompletos'
      USING ERRCODE = '55000';
  END IF;

  SELECT
    pg_get_triggerdef(trigger_state.oid, TRUE),
    pg_get_functiondef(trigger_state.tgfoid)
  INTO
    legacy_anchor_trigger_definition,
    legacy_anchor_function_definition
  FROM pg_trigger trigger_state
  WHERE trigger_state.tgrelid = to_regclass('conversational_agent_state')
    AND trigger_state.tgname = 'trg_conv_agent_state_legacy_cycle_anchor'
    AND NOT trigger_state.tgisinternal
    AND trigger_state.tgenabled IN ('O', 'A')
  LIMIT 1;

  IF legacy_anchor_trigger_definition IS NULL
    OR POSITION(
      'before insert or update of'
      IN LOWER(legacy_anchor_trigger_definition)
    ) = 0
    OR POSITION('status' IN LOWER(legacy_anchor_trigger_definition)) = 0
    OR POSITION(
      'last_inbound_message_id'
      IN LOWER(legacy_anchor_trigger_definition)
    ) = 0
    OR POSITION(
      'capture_conversational_legacy_cycle_anchor'
      IN LOWER(legacy_anchor_trigger_definition)
    ) = 0
    OR legacy_anchor_function_definition IS NULL
    OR POSITION('cac_legacy_' IN LOWER(legacy_anchor_function_definition)) = 0
    OR POSITION(
      'cac_legacy_insert_%'
      IN LOWER(legacy_anchor_function_definition)
    ) = 0
    OR POSITION(
      'cac_legacy_reactivation_'
      IN LOWER(legacy_anchor_function_definition)
    ) = 0
    OR POSITION(
      'old.status in (''human'', ''completed'', ''skipped'')'
      IN LOWER(legacy_anchor_function_definition)
    ) = 0
    OR POSITION(
      'is not distinct from old.activation_cycle_id'
      IN LOWER(legacy_anchor_function_definition)
    ) = 0
    OR POSITION(
      'activation_cycle_started_message_id'
      IN LOWER(legacy_anchor_function_definition)
    ) = 0
    OR POSITION(
      'last_inbound_message_id'
      IN LOWER(legacy_anchor_function_definition)
    ) = 0
    OR POSITION(
      'cac_legacy_backfill_'
      IN LOWER(legacy_anchor_function_definition)
    ) > 0
  THEN
    RAISE EXCEPTION
      'falta el fence de primer inbound para writers legacy'
      USING ERRCODE = '55000';
  END IF;

  SELECT (
    table_relation.relname IS DISTINCT FROM 'conversational_agent_events'
    OR index_state.indisunique IS DISTINCT FROM FALSE
    OR index_state.indisvalid IS DISTINCT FROM TRUE
    OR index_state.indisready IS DISTINCT FROM TRUE
    OR access_method.amname IS DISTINCT FROM 'btree'
    OR keys.actual_columns IS DISTINCT FROM ARRAY[
      'contact_id',
      'agent_id',
      'event_type',
      'created_at',
      'id'
    ]::TEXT[]
    OR index_state.indpred IS NOT NULL
  )
  INTO index_mismatch
  FROM (SELECT 1) seed
  LEFT JOIN pg_class index_relation
    ON index_relation.oid = to_regclass(
      'idx_conv_agent_events_contact_agent_type_created'
    )
  LEFT JOIN pg_index index_state
    ON index_state.indexrelid = index_relation.oid
  LEFT JOIN pg_am access_method
    ON access_method.oid = index_relation.relam
  LEFT JOIN pg_class table_relation
    ON table_relation.oid = index_state.indrelid
  LEFT JOIN LATERAL (
    SELECT array_agg(
      attribute.attname::TEXT
      ORDER BY key_column.ordinality
    ) AS actual_columns
    FROM unnest(index_state.indkey)
      WITH ORDINALITY AS key_column(attnum, ordinality)
    JOIN pg_attribute attribute
      ON attribute.attrelid = index_state.indrelid
     AND attribute.attnum = key_column.attnum
    WHERE key_column.ordinality <= index_state.indnkeyatts
  ) keys ON TRUE;

  IF index_mismatch IS DISTINCT FROM FALSE THEN
    RAISE EXCEPTION
      'idx_conv_agent_events_contact_agent_type_created no cumple el contrato del handoff'
      USING ERRCODE = '55000';
  END IF;
END
$$;
