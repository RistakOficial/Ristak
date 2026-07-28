DO $$
DECLARE
  mismatched_indexes TEXT;
BEGIN
  WITH expected(
    index_name,
    table_name,
    is_unique,
    key_columns,
    predicate_kind,
    access_method
  ) AS (
    VALUES
      (
        'idx_sessions_event_id_unique',
        'sessions',
        TRUE,
        ARRAY['event_id']::TEXT[],
        'event_id_nonempty',
        'btree'
      ),
      (
        'idx_sessions_site_tracking_started',
        'sessions',
        FALSE,
        ARRAY['site_id', 'tracking_source', 'event_name', 'started_at']::TEXT[],
        'none',
        'btree'
      ),
      (
        'idx_sessions_form_tracking_started',
        'sessions',
        FALSE,
        ARRAY['form_site_id', 'tracking_source', 'event_name', 'started_at']::TEXT[],
        'none',
        'btree'
      ),
      (
        'idx_video_events_playback_sequence',
        'video_playback_events',
        TRUE,
        ARRAY['playback_id', 'event_sequence']::TEXT[],
        'event_sequence_nonnull',
        'btree'
      ),
      (
        'idx_video_events_asset_time_type',
        'video_playback_events',
        FALSE,
        ARRAY['media_asset_id', 'event_at', 'event_name', 'playback_id']::TEXT[],
        'none',
        'btree'
      ),
      (
        'idx_video_events_site_time_type',
        'video_playback_events',
        FALSE,
        ARRAY['site_id', 'event_at', 'event_name', 'media_asset_id', 'playback_id']::TEXT[],
        'none',
        'btree'
      ),
      (
        'idx_video_events_playback_type_time',
        'video_playback_events',
        FALSE,
        ARRAY['playback_id', 'event_name', 'event_at', 'id']::TEXT[],
        'none',
        'btree'
      ),
      (
        'idx_video_events_visitor_time',
        'video_playback_events',
        FALSE,
        ARRAY['visitor_id', 'event_at', 'playback_id']::TEXT[],
        'none',
        'btree'
      )
  ),
  inspected AS (
    SELECT
      expected.*,
      table_relation.relname AS actual_table,
      index_state.indisunique AS actual_unique,
      index_state.indisvalid,
      index_state.indisready,
      index_access_method.amname::TEXT AS actual_access_method,
      keys.actual_columns,
      regexp_replace(
        COALESCE(pg_get_expr(index_state.indpred, index_state.indrelid), ''),
        $rx$[()[:space:]]+$rx$,
        '',
        'g'
      ) AS normalized_predicate
    FROM expected
    LEFT JOIN pg_class index_relation
      ON index_relation.oid = to_regclass(expected.index_name)
    LEFT JOIN pg_index index_state
      ON index_state.indexrelid = index_relation.oid
    LEFT JOIN pg_am index_access_method
      ON index_access_method.oid = index_relation.relam
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
  WHERE actual_table IS DISTINCT FROM table_name
     OR actual_unique IS DISTINCT FROM is_unique
     OR indisvalid IS DISTINCT FROM TRUE
     OR indisready IS DISTINCT FROM TRUE
     OR actual_access_method IS DISTINCT FROM access_method
     OR actual_columns IS DISTINCT FROM key_columns
     OR CASE predicate_kind
          WHEN 'none' THEN normalized_predicate <> ''
          WHEN 'event_id_nonempty' THEN normalized_predicate <> $expr$event_idISNOTNULLANDevent_id<>''::text$expr$
          WHEN 'event_sequence_nonnull' THEN normalized_predicate <> 'event_sequenceISNOTNULL'
          ELSE TRUE
        END;

  IF mismatched_indexes IS NOT NULL THEN
    RAISE EXCEPTION
      'Índices de Sites Analytics con definición incorrecta: %',
      mismatched_indexes
      USING ERRCODE = '55000';
  END IF;
END
$$;
