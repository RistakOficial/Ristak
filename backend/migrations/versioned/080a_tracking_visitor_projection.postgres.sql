ALTER TABLE sessions ADD COLUMN IF NOT EXISTS visitor_key TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS visitor_projection_version INTEGER NOT NULL DEFAULT 0;

-- Dos rollups complementarios por identidad/scope: día UTC para el interior
-- del rango y cuarto de hora UTC sólo para sus bordes parciales. Así un bot de
-- años no reaparece como millones de probes y los días del negocio siguen
-- respetando exactamente sus límites UTC.
CREATE TABLE IF NOT EXISTS tracking_visitor_latest (
  scope_type TEXT NOT NULL CHECK (scope_type IN ('all', 'campaign', 'adset', 'ad')),
  scope_id TEXT NOT NULL,
  bucket_kind TEXT NOT NULL CHECK (bucket_kind IN ('day', 'quarter')),
  bucket_start TIMESTAMPTZ NOT NULL,
  visitor_key TEXT NOT NULL,
  session_row_id UUID NOT NULL,
  latest_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (scope_type, scope_id, bucket_kind, bucket_start, visitor_key)
);

CREATE INDEX IF NOT EXISTS idx_tracking_visitor_latest_day_page
  ON tracking_visitor_latest(scope_type, scope_id, latest_at DESC, session_row_id DESC)
  INCLUDE (bucket_start, visitor_key)
  WHERE bucket_kind = 'day';
CREATE INDEX IF NOT EXISTS idx_tracking_visitor_latest_quarter_page
  ON tracking_visitor_latest(scope_type, scope_id, latest_at DESC, session_row_id DESC)
  INCLUDE (bucket_start, visitor_key)
  WHERE bucket_kind = 'quarter';
CREATE INDEX IF NOT EXISTS idx_tracking_visitor_latest_day_identity
  ON tracking_visitor_latest(scope_type, scope_id, visitor_key, latest_at DESC, session_row_id DESC)
  INCLUDE (bucket_start)
  WHERE bucket_kind = 'day';
CREATE INDEX IF NOT EXISTS idx_tracking_visitor_latest_quarter_identity
  ON tracking_visitor_latest(scope_type, scope_id, visitor_key, latest_at DESC, session_row_id DESC)
  INCLUDE (bucket_start)
  WHERE bucket_kind = 'quarter';
CREATE INDEX IF NOT EXISTS idx_tracking_visitor_latest_session
  ON tracking_visitor_latest(session_row_id);

CREATE OR REPLACE FUNCTION ristak_sync_session_visitor_projection()
RETURNS TRIGGER AS $$
BEGIN
  NEW.visitor_key := CASE
    WHEN NEW.contact_id IS NOT NULL AND NEW.contact_id != '' THEN 'contact:' || NEW.contact_id
    WHEN NEW.visitor_id IS NOT NULL AND NEW.visitor_id != '' THEN 'visitor:' || NEW.visitor_id
    WHEN NEW.session_id IS NOT NULL AND NEW.session_id != '' THEN 'session:' || NEW.session_id
    ELSE NULL
  END;
  NEW.visitor_projection_version := 3;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sessions_visitor_projection ON sessions;
CREATE TRIGGER trg_sessions_visitor_projection
BEFORE INSERT OR UPDATE OF contact_id, visitor_id, session_id ON sessions
FOR EACH ROW EXECUTE FUNCTION ristak_sync_session_visitor_projection();

CREATE OR REPLACE FUNCTION ristak_upsert_tracking_visitor_scope(
  p_scope_type TEXT,
  p_scope_id TEXT,
  p_bucket_kind TEXT,
  p_bucket_start TIMESTAMPTZ,
  p_visitor_key TEXT,
  p_session_row_id UUID,
  p_latest_at TIMESTAMPTZ
)
RETURNS VOID AS $$
BEGIN
  IF p_visitor_key IS NULL OR p_visitor_key = '' OR p_scope_id IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO tracking_visitor_latest (
    scope_type,
    scope_id,
    bucket_kind,
    bucket_start,
    visitor_key,
    session_row_id,
    latest_at,
    updated_at
  ) VALUES (
    p_scope_type,
    p_scope_id,
    p_bucket_kind,
    p_bucket_start,
    p_visitor_key,
    p_session_row_id,
    p_latest_at,
    CURRENT_TIMESTAMP
  )
  ON CONFLICT (scope_type, scope_id, bucket_kind, bucket_start, visitor_key) DO UPDATE SET
    session_row_id = EXCLUDED.session_row_id,
    latest_at = EXCLUDED.latest_at,
    updated_at = CURRENT_TIMESTAMP
  WHERE (EXCLUDED.latest_at, EXCLUDED.session_row_id) >
        (tracking_visitor_latest.latest_at, tracking_visitor_latest.session_row_id);
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ristak_upsert_tracking_visitor_session(p_session sessions)
RETURNS VOID AS $$
DECLARE
  day_bucket TIMESTAMPTZ;
  quarter_bucket TIMESTAMPTZ;
BEGIN
  IF p_session.visitor_key IS NULL OR p_session.started_at IS NULL THEN
    RETURN;
  END IF;

  day_bucket := date_trunc('day', p_session.started_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  quarter_bucket := (
    date_trunc('hour', p_session.started_at AT TIME ZONE 'UTC')
      + ((EXTRACT(MINUTE FROM p_session.started_at AT TIME ZONE 'UTC')::INTEGER / 15) * INTERVAL '15 minutes')
  ) AT TIME ZONE 'UTC';

  -- Una sola sentencia SPI por evento. Llamar 2-8 helpers separados serializa
  -- una identidad caliente y multiplica la latencia de ingestión.
  INSERT INTO tracking_visitor_latest (
    scope_type,
    scope_id,
    bucket_kind,
    bucket_start,
    visitor_key,
    session_row_id,
    latest_at,
    updated_at
  )
  SELECT
    scopes.scope_type,
    scopes.scope_id,
    buckets.bucket_kind,
    buckets.bucket_start,
    p_session.visitor_key,
    p_session.id,
    p_session.started_at,
    CURRENT_TIMESTAMP
  FROM (
    VALUES
      ('all'::text, ''::text),
      ('campaign'::text, p_session.campaign_id),
      ('adset'::text, p_session.adset_id),
      ('ad'::text, p_session.ad_id)
  ) scopes(scope_type, scope_id)
  CROSS JOIN (
    VALUES
      ('day'::text, day_bucket),
      ('quarter'::text, quarter_bucket)
  ) buckets(bucket_kind, bucket_start)
  WHERE scopes.scope_type = 'all' OR COALESCE(scopes.scope_id, '') != ''
  ON CONFLICT (scope_type, scope_id, bucket_kind, bucket_start, visitor_key) DO UPDATE SET
    session_row_id = EXCLUDED.session_row_id,
    latest_at = EXCLUDED.latest_at,
    updated_at = CURRENT_TIMESTAMP
  WHERE (EXCLUDED.latest_at, EXCLUDED.session_row_id) >
        (tracking_visitor_latest.latest_at, tracking_visitor_latest.session_row_id);
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ristak_refresh_tracking_visitor_session()
RETURNS TRIGGER AS $$
DECLARE
  projected RECORD;
  replacement sessions%ROWTYPE;
BEGIN
  IF current_setting('ristak.skip_tracking_visitor_projection', true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
    AND OLD.visitor_key IS NOT DISTINCT FROM NEW.visitor_key
    AND OLD.started_at IS NOT DISTINCT FROM NEW.started_at
    AND OLD.campaign_id IS NOT DISTINCT FROM NEW.campaign_id
    AND OLD.adset_id IS NOT DISTINCT FROM NEW.adset_id
    AND OLD.ad_id IS NOT DISTINCT FROM NEW.ad_id
  THEN
    RETURN NEW;
  END IF;

  IF TG_OP != 'INSERT' THEN
    -- Sólo se reconstruyen los scopes donde OLD era el representante. Borrar
    -- una de 900k filas que no era latest no provoca un escaneo inútil.
    FOR projected IN
      SELECT scope_type, scope_id, bucket_kind, bucket_start
      FROM tracking_visitor_latest
      WHERE session_row_id = OLD.id
    LOOP
      DELETE FROM tracking_visitor_latest
      WHERE scope_type = projected.scope_type
        AND scope_id = projected.scope_id
        AND bucket_kind = projected.bucket_kind
        AND bucket_start = projected.bucket_start
        AND visitor_key = OLD.visitor_key
        AND session_row_id = OLD.id;

      SELECT candidate.*
      INTO replacement
      FROM sessions candidate
      WHERE candidate.visitor_key = OLD.visitor_key
        AND candidate.started_at >= projected.bucket_start
        AND candidate.started_at < projected.bucket_start + CASE
          WHEN projected.bucket_kind = 'day' THEN INTERVAL '1 day'
          ELSE INTERVAL '15 minutes'
        END
        AND (
          projected.scope_type = 'all'
          OR (projected.scope_type = 'campaign' AND candidate.campaign_id = projected.scope_id)
          OR (projected.scope_type = 'adset' AND candidate.adset_id = projected.scope_id)
          OR (projected.scope_type = 'ad' AND candidate.ad_id = projected.scope_id)
        )
      ORDER BY candidate.started_at DESC, candidate.id DESC
      LIMIT 1;

      IF FOUND THEN
        PERFORM ristak_upsert_tracking_visitor_scope(
          projected.scope_type,
          projected.scope_id,
          projected.bucket_kind,
          projected.bucket_start,
          replacement.visitor_key,
          replacement.id,
          replacement.started_at
        );
      END IF;
    END LOOP;
  END IF;

  IF TG_OP != 'DELETE' THEN
    PERFORM ristak_upsert_tracking_visitor_session(NEW);
    RETURN NEW;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sessions_tracking_visitor_latest ON sessions;
CREATE TRIGGER trg_sessions_tracking_visitor_latest
AFTER INSERT OR DELETE OR UPDATE OF
  contact_id,
  visitor_id,
  session_id,
  started_at,
  campaign_id,
  adset_id,
  ad_id
ON sessions
FOR EACH ROW EXECUTE FUNCTION ristak_refresh_tracking_visitor_session();
