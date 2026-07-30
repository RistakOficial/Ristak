DO $$
DECLARE
  timestamp_mismatch TEXT;
  mismatched_indexes TEXT;
BEGIN
  IF to_regclass('site_flow_events') IS NULL THEN
    RAISE EXCEPTION
      'site_flow_events no existe después de aplicar su migración'
      USING ERRCODE = '55000';
  END IF;

  WITH expected(column_name) AS (
    VALUES
      ('client_event_at'),
      ('event_at'),
      ('created_at')
  )
  SELECT string_agg(expected.column_name, ', ' ORDER BY expected.column_name)
  INTO timestamp_mismatch
  FROM expected
  LEFT JOIN pg_attribute attribute
    ON attribute.attrelid = to_regclass('site_flow_events')
   AND attribute.attname = expected.column_name
   AND attribute.attnum > 0
   AND NOT attribute.attisdropped
  WHERE format_type(attribute.atttypid, attribute.atttypmod)
    IS DISTINCT FROM 'timestamp with time zone';

  IF timestamp_mismatch IS NOT NULL THEN
    RAISE EXCEPTION
      'site_flow_events tiene timestamps sin zona o ausentes: %',
      timestamp_mismatch
      USING ERRCODE = '55000';
  END IF;

  WITH expected(
    index_name,
    key_columns
  ) AS (
    VALUES
      (
        'idx_site_flow_events_form_revision_time',
        ARRAY['form_site_id', 'flow_revision', 'event_name', 'event_at', 'attempt_id']::TEXT[]
      ),
      (
        'idx_site_flow_events_site_time',
        ARRAY['site_id', 'event_at', 'event_name', 'attempt_id']::TEXT[]
      ),
      (
        'idx_site_flow_events_attempt_order',
        ARRAY['attempt_id', 'event_sequence', 'event_at', 'id']::TEXT[]
      ),
      (
        'idx_site_flow_events_visitor_time',
        ARRAY['visitor_id', 'event_at', 'attempt_id']::TEXT[]
      ),
      (
        'idx_site_flow_events_created_at',
        ARRAY['created_at', 'event_at', 'id']::TEXT[]
      )
  ),
  inspected AS (
    SELECT
      expected.*,
      table_relation.relname AS actual_table,
      index_state.indisunique,
      index_state.indisvalid,
      index_state.indisready,
      access_method.amname::TEXT AS actual_access_method,
      keys.actual_columns,
      index_state.indpred
    FROM expected
    LEFT JOIN pg_class index_relation
      ON index_relation.oid = to_regclass(expected.index_name)
    LEFT JOIN pg_index index_state
      ON index_state.indexrelid = index_relation.oid
    LEFT JOIN pg_am access_method
      ON access_method.oid = index_relation.relam
    LEFT JOIN pg_class table_relation
      ON table_relation.oid = index_state.indrelid
    LEFT JOIN LATERAL (
      SELECT array_agg(attribute.attname::TEXT ORDER BY key_column.ordinality) AS actual_columns
      FROM unnest(index_state.indkey) WITH ORDINALITY AS key_column(attnum, ordinality)
      JOIN pg_attribute attribute
        ON attribute.attrelid = index_state.indrelid
       AND attribute.attnum = key_column.attnum
      WHERE key_column.ordinality <= index_state.indnkeyatts
    ) keys ON TRUE
  )
  SELECT string_agg(index_name, ', ' ORDER BY index_name)
  INTO mismatched_indexes
  FROM inspected
  WHERE actual_table IS DISTINCT FROM 'site_flow_events'
     OR indisunique IS DISTINCT FROM FALSE
     OR indisvalid IS DISTINCT FROM TRUE
     OR indisready IS DISTINCT FROM TRUE
     OR actual_access_method IS DISTINCT FROM 'btree'
     OR actual_columns IS DISTINCT FROM key_columns
     OR indpred IS NOT NULL;

  IF mismatched_indexes IS NOT NULL THEN
    RAISE EXCEPTION
      'Índices de site_flow_events con definición incorrecta: %',
      mismatched_indexes
      USING ERRCODE = '55000';
  END IF;
END
$$;
