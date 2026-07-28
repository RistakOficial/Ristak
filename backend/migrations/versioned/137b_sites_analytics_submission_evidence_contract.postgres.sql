DO $$
DECLARE
  actual_table TEXT;
  actual_access_method TEXT;
  actual_unique BOOLEAN;
  actual_valid BOOLEAN;
  actual_ready BOOLEAN;
  actual_columns TEXT[];
  actual_predicate TEXT;
BEGIN
  SELECT
    table_relation.relname::TEXT,
    index_access_method.amname::TEXT,
    index_state.indisunique,
    index_state.indisvalid,
    index_state.indisready,
    keys.key_columns,
    regexp_replace(
      COALESCE(pg_get_expr(index_state.indpred, index_state.indrelid), ''),
      $rx$[()[:space:]]+$rx$,
      '',
      'g'
    )
  INTO
    actual_table,
    actual_access_method,
    actual_unique,
    actual_valid,
    actual_ready,
    actual_columns,
    actual_predicate
  FROM pg_class index_relation
  JOIN pg_index index_state
    ON index_state.indexrelid = index_relation.oid
  JOIN pg_class table_relation
    ON table_relation.oid = index_state.indrelid
  JOIN pg_am index_access_method
    ON index_access_method.oid = index_relation.relam
  LEFT JOIN LATERAL (
    SELECT array_agg(attribute.attname::TEXT ORDER BY key_column.ordinality) AS key_columns
    FROM unnest(index_state.indkey) WITH ORDINALITY AS key_column(attnum, ordinality)
    JOIN pg_attribute attribute
      ON attribute.attrelid = index_state.indrelid
     AND attribute.attnum = key_column.attnum
    WHERE key_column.ordinality <= index_state.indnkeyatts
  ) keys ON TRUE
  WHERE index_relation.oid = to_regclass('idx_sessions_submission_tracking_event');

  IF actual_table IS DISTINCT FROM 'sessions'
    OR actual_access_method IS DISTINCT FROM 'btree'
    OR actual_unique IS DISTINCT FROM FALSE
    OR actual_valid IS DISTINCT FROM TRUE
    OR actual_ready IS DISTINCT FROM TRUE
    OR actual_columns IS DISTINCT FROM ARRAY[
      'submission_id',
      'tracking_source',
      'event_name',
      'started_at'
    ]::TEXT[]
    OR actual_predicate IS DISTINCT FROM ''
  THEN
    RAISE EXCEPTION
      'El índice idx_sessions_submission_tracking_event no cumple el contrato de Sites Analytics'
      USING ERRCODE = '55000';
  END IF;
END
$$;
