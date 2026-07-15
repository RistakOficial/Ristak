CREATE INDEX IF NOT EXISTS idx_message_analytics_daily_identity_date
  ON message_analytics_daily_identity(generation, identity_key, business_date);
CREATE INDEX IF NOT EXISTS idx_message_analytics_daily_identity_channel_date
  ON message_analytics_daily_identity(generation, identity_key, channel, business_date);
CREATE INDEX IF NOT EXISTS idx_message_analytics_daily_identity_source_date
  ON message_analytics_daily_identity(generation, identity_key, source, business_date);
CREATE INDEX IF NOT EXISTS idx_message_analytics_daily_identity_pair_date
  ON message_analytics_daily_identity(generation, identity_key, channel, source, business_date);
CREATE INDEX IF NOT EXISTS idx_message_analytics_daily_attributed_date
  ON message_analytics_daily_identity(generation, identity_key, business_date)
  WHERE attributed_message_count > 0;
CREATE INDEX IF NOT EXISTS idx_message_analytics_daily_attributed_channel_date
  ON message_analytics_daily_identity(generation, identity_key, channel, business_date)
  WHERE attributed_message_count > 0;
CREATE INDEX IF NOT EXISTS idx_message_analytics_daily_attributed_source_date
  ON message_analytics_daily_identity(generation, identity_key, source, business_date)
  WHERE attributed_message_count > 0;
CREATE INDEX IF NOT EXISTS idx_message_analytics_daily_attributed_pair_date
  ON message_analytics_daily_identity(generation, identity_key, channel, source, business_date)
  WHERE attributed_message_count > 0;

CREATE TABLE IF NOT EXISTS message_analytics_range_generation (
  generation INTEGER PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'building'
    CHECK (status IN ('building', 'ready')),
  built_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS message_analytics_daily_rollup (
  generation INTEGER NOT NULL,
  business_date TEXT NOT NULL,
  channel TEXT NOT NULL,
  source TEXT NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0 CHECK (message_count >= 0),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (generation, business_date, channel, source)
);
CREATE INDEX IF NOT EXISTS idx_message_analytics_daily_rollup_range
  ON message_analytics_daily_rollup(generation, business_date, channel, source, message_count);

CREATE TABLE IF NOT EXISTS message_analytics_range_delta (
  generation INTEGER NOT NULL,
  metric_kind TEXT NOT NULL CHECK (metric_kind IN ('conversation', 'attributed', 'origin')),
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('all', 'channel', 'source', 'channel_source', 'origin_source')),
  channel TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  start_boundary TEXT NOT NULL,
  occurrence_date TEXT NOT NULL,
  range_delta INTEGER NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (
    generation, metric_kind, scope_kind, channel, source,
    start_boundary, occurrence_date
  )
);
CREATE INDEX IF NOT EXISTS idx_message_analytics_range_delta_query
  ON message_analytics_range_delta(
    generation, metric_kind, scope_kind, channel, source,
    start_boundary, occurrence_date, range_delta
  );
CREATE INDEX IF NOT EXISTS idx_message_analytics_range_delta_facets
  ON message_analytics_range_delta(
    generation, metric_kind, scope_kind, start_boundary, occurrence_date,
    channel, source, range_delta
  );

-- Resolver filtros ocultos exactos no debe escanear la tabla completa de
-- contactos antes de consultar el read model de mensajes.
CREATE INDEX IF NOT EXISTS idx_contacts_hidden_full_name_exact
  ON contacts(LOWER(COALESCE(full_name, '')));
CREATE INDEX IF NOT EXISTS idx_contacts_hidden_email_exact
  ON contacts(LOWER(COALESCE(email, '')));
CREATE INDEX IF NOT EXISTS idx_contacts_hidden_phone_exact
  ON contacts(LOWER(COALESCE(phone, '')));
CREATE INDEX IF NOT EXISTS idx_contacts_hidden_id_exact
  ON contacts(LOWER(id));
