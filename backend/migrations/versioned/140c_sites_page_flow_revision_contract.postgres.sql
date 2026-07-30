DO $$
DECLARE
  column_mismatch TEXT;
  index_mismatch BOOLEAN;
BEGIN
  WITH expected(column_name) AS (
    VALUES
      ('page_flow_revision'),
      ('page_journey_id')
  )
  SELECT string_agg(expected.column_name, ', ' ORDER BY expected.column_name)
  INTO column_mismatch
  FROM expected
  LEFT JOIN pg_attribute attribute
    ON attribute.attrelid = to_regclass('sessions')
   AND attribute.attname = expected.column_name
   AND attribute.attnum > 0
   AND NOT attribute.attisdropped
  WHERE format_type(attribute.atttypid, attribute.atttypmod)
    IS DISTINCT FROM 'text';

  IF column_mismatch IS NOT NULL THEN
    RAISE EXCEPTION
      'sessions tiene columnas de page journey ausentes o incompatibles: %',
      column_mismatch
      USING ERRCODE = '55000';
  END IF;

  SELECT (
    table_relation.relname IS DISTINCT FROM 'sessions'
    OR index_state.indisunique IS DISTINCT FROM FALSE
    OR index_state.indisvalid IS DISTINCT FROM TRUE
    OR index_state.indisready IS DISTINCT FROM TRUE
    OR access_method.amname IS DISTINCT FROM 'btree'
    OR keys.actual_columns IS DISTINCT FROM ARRAY[
      'site_id',
      'page_flow_revision',
      'started_at'
    ]::TEXT[]
    OR index_state.indpred IS NOT NULL
  )
  INTO index_mismatch
  FROM (SELECT 1) seed
  LEFT JOIN pg_class index_relation
    ON index_relation.oid = to_regclass('idx_sessions_site_page_flow_started')
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
  ) keys ON TRUE;

  IF index_mismatch IS DISTINCT FROM FALSE THEN
    RAISE EXCEPTION
      'idx_sessions_site_page_flow_started no cumple el contrato de page journeys'
      USING ERRCODE = '55000';
  END IF;
END
$$;
