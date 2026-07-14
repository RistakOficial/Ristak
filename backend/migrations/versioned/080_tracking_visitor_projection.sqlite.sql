ALTER TABLE sessions ADD COLUMN visitor_key TEXT;
ALTER TABLE sessions ADD COLUMN visitor_projection_version INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS tracking_visitor_latest (
  scope_type TEXT NOT NULL CHECK (scope_type IN ('all', 'campaign', 'adset', 'ad')),
  scope_id TEXT NOT NULL,
  bucket_kind TEXT NOT NULL CHECK (bucket_kind IN ('day', 'quarter')),
  bucket_start TEXT NOT NULL,
  visitor_key TEXT NOT NULL,
  session_row_id TEXT NOT NULL,
  latest_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (scope_type, scope_id, bucket_kind, bucket_start, visitor_key)
);

CREATE INDEX IF NOT EXISTS idx_tracking_visitor_latest_day_page
  ON tracking_visitor_latest(scope_type, scope_id, latest_at DESC, session_row_id DESC)
  WHERE bucket_kind = 'day';
CREATE INDEX IF NOT EXISTS idx_tracking_visitor_latest_quarter_page
  ON tracking_visitor_latest(scope_type, scope_id, latest_at DESC, session_row_id DESC)
  WHERE bucket_kind = 'quarter';
CREATE INDEX IF NOT EXISTS idx_tracking_visitor_latest_day_identity
  ON tracking_visitor_latest(scope_type, scope_id, visitor_key, latest_at DESC, session_row_id DESC)
  WHERE bucket_kind = 'day';
CREATE INDEX IF NOT EXISTS idx_tracking_visitor_latest_quarter_identity
  ON tracking_visitor_latest(scope_type, scope_id, visitor_key, latest_at DESC, session_row_id DESC)
  WHERE bucket_kind = 'quarter';
CREATE INDEX IF NOT EXISTS idx_tracking_visitor_latest_session
  ON tracking_visitor_latest(session_row_id);
CREATE INDEX IF NOT EXISTS idx_tracking_visitor_latest_visitor
  ON tracking_visitor_latest(visitor_key);

DROP TRIGGER IF EXISTS trg_sessions_visitor_projection_insert;
DROP TRIGGER IF EXISTS trg_sessions_visitor_projection_update;
DROP TRIGGER IF EXISTS trg_sessions_tracking_visitor_latest_insert;
DROP TRIGGER IF EXISTS trg_sessions_tracking_visitor_latest_delete;
DROP TRIGGER IF EXISTS trg_sessions_tracking_visitor_latest_update;

CREATE TRIGGER trg_sessions_visitor_projection_insert
AFTER INSERT ON sessions
BEGIN
  UPDATE sessions
  SET visitor_key = CASE
        WHEN NEW.contact_id IS NOT NULL AND NEW.contact_id != '' THEN 'contact:' || NEW.contact_id
        WHEN NEW.visitor_id IS NOT NULL AND NEW.visitor_id != '' THEN 'visitor:' || NEW.visitor_id
        WHEN NEW.session_id IS NOT NULL AND NEW.session_id != '' THEN 'session:' || NEW.session_id
        ELSE NULL
      END,
      visitor_projection_version = 3
  WHERE id = NEW.id;
END;

CREATE TRIGGER trg_sessions_visitor_projection_update
AFTER UPDATE OF contact_id, visitor_id, session_id ON sessions
BEGIN
  UPDATE sessions
  SET visitor_key = CASE
        WHEN NEW.contact_id IS NOT NULL AND NEW.contact_id != '' THEN 'contact:' || NEW.contact_id
        WHEN NEW.visitor_id IS NOT NULL AND NEW.visitor_id != '' THEN 'visitor:' || NEW.visitor_id
        WHEN NEW.session_id IS NOT NULL AND NEW.session_id != '' THEN 'session:' || NEW.session_id
        ELSE NULL
      END,
      visitor_projection_version = 3
  WHERE id = NEW.id;
END;

CREATE TRIGGER trg_sessions_tracking_visitor_latest_insert
AFTER INSERT ON sessions
BEGIN
  INSERT INTO tracking_visitor_latest (
    scope_type, scope_id, bucket_kind, bucket_start,
    visitor_key, session_row_id, latest_at, updated_at
  )
  SELECT
    scopes.scope_type,
    scopes.scope_id,
    buckets.bucket_kind,
    CASE buckets.bucket_kind
      WHEN 'day' THEN strftime('%Y-%m-%dT00:00:00.000Z', normalized.normalized_at)
      ELSE strftime('%Y-%m-%dT%H:', normalized.normalized_at) ||
        printf('%02d:00.000Z', (CAST(strftime('%M', normalized.normalized_at) AS INTEGER) / 15) * 15)
    END,
    CASE
      WHEN NEW.contact_id IS NOT NULL AND NEW.contact_id != '' THEN 'contact:' || NEW.contact_id
      WHEN NEW.visitor_id IS NOT NULL AND NEW.visitor_id != '' THEN 'visitor:' || NEW.visitor_id
      WHEN NEW.session_id IS NOT NULL AND NEW.session_id != '' THEN 'session:' || NEW.session_id
      ELSE NULL
    END,
    NEW.id,
    strftime('%Y-%m-%dT%H:%M:%fZ', normalized.normalized_at),
    CURRENT_TIMESTAMP
  FROM (
    SELECT 'all' AS scope_type, '' AS scope_id
    UNION ALL SELECT 'campaign', NEW.campaign_id WHERE NEW.campaign_id IS NOT NULL AND NEW.campaign_id != ''
    UNION ALL SELECT 'adset', NEW.adset_id WHERE NEW.adset_id IS NOT NULL AND NEW.adset_id != ''
    UNION ALL SELECT 'ad', NEW.ad_id WHERE NEW.ad_id IS NOT NULL AND NEW.ad_id != ''
  ) scopes
  CROSS JOIN (SELECT 'day' AS bucket_kind UNION ALL SELECT 'quarter') buckets
  CROSS JOIN (
    SELECT CASE
      WHEN typeof(NEW.started_at) IN ('integer', 'real')
        AND ABS(CAST(NEW.started_at AS REAL)) >= 100000000000
        THEN strftime('%Y-%m-%dT%H:%M:%fZ', CAST(NEW.started_at AS REAL) / 1000.0, 'unixepoch')
      WHEN typeof(NEW.started_at) IN ('integer', 'real')
        THEN strftime('%Y-%m-%dT%H:%M:%fZ', CAST(NEW.started_at AS REAL), 'unixepoch')
      ELSE strftime('%Y-%m-%dT%H:%M:%fZ', NEW.started_at)
    END AS normalized_at
  ) normalized
  WHERE normalized.normalized_at IS NOT NULL
    AND CASE
      WHEN NEW.contact_id IS NOT NULL AND NEW.contact_id != '' THEN 'contact:' || NEW.contact_id
      WHEN NEW.visitor_id IS NOT NULL AND NEW.visitor_id != '' THEN 'visitor:' || NEW.visitor_id
      WHEN NEW.session_id IS NOT NULL AND NEW.session_id != '' THEN 'session:' || NEW.session_id
      ELSE NULL
    END IS NOT NULL
  ON CONFLICT(scope_type, scope_id, bucket_kind, bucket_start, visitor_key) DO UPDATE SET
    session_row_id = excluded.session_row_id,
    latest_at = excluded.latest_at,
    updated_at = CURRENT_TIMESTAMP
  WHERE excluded.latest_at > tracking_visitor_latest.latest_at
     OR (excluded.latest_at = tracking_visitor_latest.latest_at
         AND excluded.session_row_id > tracking_visitor_latest.session_row_id);
END;

-- Sólo las filas que eran cabeza de algún bucket necesitan reparación.
CREATE TRIGGER trg_sessions_tracking_visitor_latest_delete
AFTER DELETE ON sessions
WHEN EXISTS (SELECT 1 FROM tracking_visitor_latest WHERE session_row_id = OLD.id)
BEGIN
  INSERT INTO tracking_visitor_latest (
    scope_type, scope_id, bucket_kind, bucket_start,
    visitor_key, session_row_id, latest_at, updated_at
  )
  SELECT
    scope_type, scope_id, bucket_kind, bucket_start,
    visitor_key, session_row_id, latest_at, CURRENT_TIMESTAMP
  FROM (
    SELECT
      current.scope_type,
      current.scope_id,
      current.bucket_kind,
      current.bucket_start,
      candidate.visitor_key,
      candidate.id AS session_row_id,
      strftime('%Y-%m-%dT%H:%M:%fZ', CASE
        WHEN typeof(candidate.started_at) IN ('integer', 'real')
          AND ABS(CAST(candidate.started_at AS REAL)) >= 100000000000
          THEN strftime('%Y-%m-%dT%H:%M:%fZ', CAST(candidate.started_at AS REAL) / 1000.0, 'unixepoch')
        WHEN typeof(candidate.started_at) IN ('integer', 'real')
          THEN strftime('%Y-%m-%dT%H:%M:%fZ', CAST(candidate.started_at AS REAL), 'unixepoch')
        ELSE strftime('%Y-%m-%dT%H:%M:%fZ', candidate.started_at)
      END) AS latest_at,
      ROW_NUMBER() OVER (
        PARTITION BY current.scope_type, current.scope_id, current.bucket_kind, current.bucket_start, current.visitor_key
        ORDER BY strftime('%Y-%m-%dT%H:%M:%fZ', CASE
          WHEN typeof(candidate.started_at) IN ('integer', 'real')
            AND ABS(CAST(candidate.started_at AS REAL)) >= 100000000000
            THEN strftime('%Y-%m-%dT%H:%M:%fZ', CAST(candidate.started_at AS REAL) / 1000.0, 'unixepoch')
          WHEN typeof(candidate.started_at) IN ('integer', 'real')
            THEN strftime('%Y-%m-%dT%H:%M:%fZ', CAST(candidate.started_at AS REAL), 'unixepoch')
          ELSE strftime('%Y-%m-%dT%H:%M:%fZ', candidate.started_at)
        END) DESC, candidate.id DESC
      ) AS replacement_rank
    FROM tracking_visitor_latest current
    INNER JOIN sessions candidate
      ON candidate.visitor_key = OLD.visitor_key
     AND candidate.id != OLD.id
     AND strftime('%Y-%m-%dT%H:%M:%fZ', CASE
       WHEN typeof(candidate.started_at) IN ('integer', 'real')
         AND ABS(CAST(candidate.started_at AS REAL)) >= 100000000000
         THEN strftime('%Y-%m-%dT%H:%M:%fZ', CAST(candidate.started_at AS REAL) / 1000.0, 'unixepoch')
       WHEN typeof(candidate.started_at) IN ('integer', 'real')
         THEN strftime('%Y-%m-%dT%H:%M:%fZ', CAST(candidate.started_at AS REAL), 'unixepoch')
       ELSE strftime('%Y-%m-%dT%H:%M:%fZ', candidate.started_at)
     END) >= current.bucket_start
     AND strftime('%Y-%m-%dT%H:%M:%fZ', CASE
       WHEN typeof(candidate.started_at) IN ('integer', 'real')
         AND ABS(CAST(candidate.started_at AS REAL)) >= 100000000000
         THEN strftime('%Y-%m-%dT%H:%M:%fZ', CAST(candidate.started_at AS REAL) / 1000.0, 'unixepoch')
       WHEN typeof(candidate.started_at) IN ('integer', 'real')
         THEN strftime('%Y-%m-%dT%H:%M:%fZ', CAST(candidate.started_at AS REAL), 'unixepoch')
       ELSE strftime('%Y-%m-%dT%H:%M:%fZ', candidate.started_at)
     END) < CASE current.bucket_kind
       WHEN 'day' THEN strftime('%Y-%m-%dT%H:%M:%fZ', current.bucket_start, '+1 day')
       ELSE strftime('%Y-%m-%dT%H:%M:%fZ', current.bucket_start, '+15 minutes')
     END
     AND (
       current.scope_type = 'all'
       OR (current.scope_type = 'campaign' AND candidate.campaign_id = current.scope_id)
       OR (current.scope_type = 'adset' AND candidate.adset_id = current.scope_id)
       OR (current.scope_type = 'ad' AND candidate.ad_id = current.scope_id)
     )
    WHERE current.session_row_id = OLD.id
  ) replacements
  WHERE replacement_rank = 1
  ON CONFLICT(scope_type, scope_id, bucket_kind, bucket_start, visitor_key) DO UPDATE SET
    session_row_id = excluded.session_row_id,
    latest_at = excluded.latest_at,
    updated_at = CURRENT_TIMESTAMP;

  DELETE FROM tracking_visitor_latest WHERE session_row_id = OLD.id;
END;

CREATE TRIGGER trg_sessions_tracking_visitor_latest_update
AFTER UPDATE OF contact_id, visitor_id, session_id, started_at, campaign_id, adset_id, ad_id ON sessions
WHEN
  (CASE
    WHEN OLD.contact_id IS NOT NULL AND OLD.contact_id != '' THEN 'contact:' || OLD.contact_id
    WHEN OLD.visitor_id IS NOT NULL AND OLD.visitor_id != '' THEN 'visitor:' || OLD.visitor_id
    WHEN OLD.session_id IS NOT NULL AND OLD.session_id != '' THEN 'session:' || OLD.session_id
    ELSE NULL
  END) IS NOT (CASE
    WHEN NEW.contact_id IS NOT NULL AND NEW.contact_id != '' THEN 'contact:' || NEW.contact_id
    WHEN NEW.visitor_id IS NOT NULL AND NEW.visitor_id != '' THEN 'visitor:' || NEW.visitor_id
    WHEN NEW.session_id IS NOT NULL AND NEW.session_id != '' THEN 'session:' || NEW.session_id
    ELSE NULL
  END)
  OR OLD.started_at IS NOT NEW.started_at
  OR OLD.campaign_id IS NOT NEW.campaign_id
  OR OLD.adset_id IS NOT NEW.adset_id
  OR OLD.ad_id IS NOT NEW.ad_id
BEGIN
  -- Repara OLD antes de publicar NEW. candidate.id != OLD.id impide que el
  -- orden no definido de los triggers de SQLite deje una identidad fantasma.
  INSERT INTO tracking_visitor_latest (
    scope_type, scope_id, bucket_kind, bucket_start,
    visitor_key, session_row_id, latest_at, updated_at
  )
  SELECT
    scope_type, scope_id, bucket_kind, bucket_start,
    visitor_key, session_row_id, latest_at, CURRENT_TIMESTAMP
  FROM (
    SELECT
      current.scope_type,
      current.scope_id,
      current.bucket_kind,
      current.bucket_start,
      candidate.visitor_key,
      candidate.id AS session_row_id,
      strftime('%Y-%m-%dT%H:%M:%fZ', CASE
        WHEN typeof(candidate.started_at) IN ('integer', 'real')
          AND ABS(CAST(candidate.started_at AS REAL)) >= 100000000000
          THEN strftime('%Y-%m-%dT%H:%M:%fZ', CAST(candidate.started_at AS REAL) / 1000.0, 'unixepoch')
        WHEN typeof(candidate.started_at) IN ('integer', 'real')
          THEN strftime('%Y-%m-%dT%H:%M:%fZ', CAST(candidate.started_at AS REAL), 'unixepoch')
        ELSE strftime('%Y-%m-%dT%H:%M:%fZ', candidate.started_at)
      END) AS latest_at,
      ROW_NUMBER() OVER (
        PARTITION BY current.scope_type, current.scope_id, current.bucket_kind, current.bucket_start, current.visitor_key
        ORDER BY strftime('%Y-%m-%dT%H:%M:%fZ', CASE
          WHEN typeof(candidate.started_at) IN ('integer', 'real')
            AND ABS(CAST(candidate.started_at AS REAL)) >= 100000000000
            THEN strftime('%Y-%m-%dT%H:%M:%fZ', CAST(candidate.started_at AS REAL) / 1000.0, 'unixepoch')
          WHEN typeof(candidate.started_at) IN ('integer', 'real')
            THEN strftime('%Y-%m-%dT%H:%M:%fZ', CAST(candidate.started_at AS REAL), 'unixepoch')
          ELSE strftime('%Y-%m-%dT%H:%M:%fZ', candidate.started_at)
        END) DESC, candidate.id DESC
      ) AS replacement_rank
    FROM tracking_visitor_latest current
    INNER JOIN sessions candidate
      ON candidate.visitor_key = CASE
        WHEN OLD.contact_id IS NOT NULL AND OLD.contact_id != '' THEN 'contact:' || OLD.contact_id
        WHEN OLD.visitor_id IS NOT NULL AND OLD.visitor_id != '' THEN 'visitor:' || OLD.visitor_id
        WHEN OLD.session_id IS NOT NULL AND OLD.session_id != '' THEN 'session:' || OLD.session_id
        ELSE NULL
      END
     AND candidate.id != OLD.id
     AND strftime('%Y-%m-%dT%H:%M:%fZ', CASE
       WHEN typeof(candidate.started_at) IN ('integer', 'real')
         AND ABS(CAST(candidate.started_at AS REAL)) >= 100000000000
         THEN strftime('%Y-%m-%dT%H:%M:%fZ', CAST(candidate.started_at AS REAL) / 1000.0, 'unixepoch')
       WHEN typeof(candidate.started_at) IN ('integer', 'real')
         THEN strftime('%Y-%m-%dT%H:%M:%fZ', CAST(candidate.started_at AS REAL), 'unixepoch')
       ELSE strftime('%Y-%m-%dT%H:%M:%fZ', candidate.started_at)
     END) >= current.bucket_start
     AND strftime('%Y-%m-%dT%H:%M:%fZ', CASE
       WHEN typeof(candidate.started_at) IN ('integer', 'real')
         AND ABS(CAST(candidate.started_at AS REAL)) >= 100000000000
         THEN strftime('%Y-%m-%dT%H:%M:%fZ', CAST(candidate.started_at AS REAL) / 1000.0, 'unixepoch')
       WHEN typeof(candidate.started_at) IN ('integer', 'real')
         THEN strftime('%Y-%m-%dT%H:%M:%fZ', CAST(candidate.started_at AS REAL), 'unixepoch')
       ELSE strftime('%Y-%m-%dT%H:%M:%fZ', candidate.started_at)
     END) < CASE current.bucket_kind
       WHEN 'day' THEN strftime('%Y-%m-%dT%H:%M:%fZ', current.bucket_start, '+1 day')
       ELSE strftime('%Y-%m-%dT%H:%M:%fZ', current.bucket_start, '+15 minutes')
     END
     AND (
       current.scope_type = 'all'
       OR (current.scope_type = 'campaign' AND candidate.campaign_id = current.scope_id)
       OR (current.scope_type = 'adset' AND candidate.adset_id = current.scope_id)
       OR (current.scope_type = 'ad' AND candidate.ad_id = current.scope_id)
     )
    WHERE current.session_row_id = OLD.id
  ) replacements
  WHERE replacement_rank = 1
  ON CONFLICT(scope_type, scope_id, bucket_kind, bucket_start, visitor_key) DO UPDATE SET
    session_row_id = excluded.session_row_id,
    latest_at = excluded.latest_at,
    updated_at = CURRENT_TIMESTAMP;

  DELETE FROM tracking_visitor_latest WHERE session_row_id = OLD.id;

  INSERT INTO tracking_visitor_latest (
    scope_type, scope_id, bucket_kind, bucket_start,
    visitor_key, session_row_id, latest_at, updated_at
  )
  SELECT
    scopes.scope_type,
    scopes.scope_id,
    buckets.bucket_kind,
    CASE buckets.bucket_kind
      WHEN 'day' THEN strftime('%Y-%m-%dT00:00:00.000Z', normalized.normalized_at)
      ELSE strftime('%Y-%m-%dT%H:', normalized.normalized_at) ||
        printf('%02d:00.000Z', (CAST(strftime('%M', normalized.normalized_at) AS INTEGER) / 15) * 15)
    END,
    CASE
      WHEN NEW.contact_id IS NOT NULL AND NEW.contact_id != '' THEN 'contact:' || NEW.contact_id
      WHEN NEW.visitor_id IS NOT NULL AND NEW.visitor_id != '' THEN 'visitor:' || NEW.visitor_id
      WHEN NEW.session_id IS NOT NULL AND NEW.session_id != '' THEN 'session:' || NEW.session_id
      ELSE NULL
    END,
    NEW.id,
    strftime('%Y-%m-%dT%H:%M:%fZ', normalized.normalized_at),
    CURRENT_TIMESTAMP
  FROM (
    SELECT 'all' AS scope_type, '' AS scope_id
    UNION ALL SELECT 'campaign', NEW.campaign_id WHERE NEW.campaign_id IS NOT NULL AND NEW.campaign_id != ''
    UNION ALL SELECT 'adset', NEW.adset_id WHERE NEW.adset_id IS NOT NULL AND NEW.adset_id != ''
    UNION ALL SELECT 'ad', NEW.ad_id WHERE NEW.ad_id IS NOT NULL AND NEW.ad_id != ''
  ) scopes
  CROSS JOIN (SELECT 'day' AS bucket_kind UNION ALL SELECT 'quarter') buckets
  CROSS JOIN (
    SELECT CASE
      WHEN typeof(NEW.started_at) IN ('integer', 'real')
        AND ABS(CAST(NEW.started_at AS REAL)) >= 100000000000
        THEN strftime('%Y-%m-%dT%H:%M:%fZ', CAST(NEW.started_at AS REAL) / 1000.0, 'unixepoch')
      WHEN typeof(NEW.started_at) IN ('integer', 'real')
        THEN strftime('%Y-%m-%dT%H:%M:%fZ', CAST(NEW.started_at AS REAL), 'unixepoch')
      ELSE strftime('%Y-%m-%dT%H:%M:%fZ', NEW.started_at)
    END AS normalized_at
  ) normalized
  WHERE normalized.normalized_at IS NOT NULL
    AND CASE
      WHEN NEW.contact_id IS NOT NULL AND NEW.contact_id != '' THEN 'contact:' || NEW.contact_id
      WHEN NEW.visitor_id IS NOT NULL AND NEW.visitor_id != '' THEN 'visitor:' || NEW.visitor_id
      WHEN NEW.session_id IS NOT NULL AND NEW.session_id != '' THEN 'session:' || NEW.session_id
      ELSE NULL
    END IS NOT NULL
  ON CONFLICT(scope_type, scope_id, bucket_kind, bucket_start, visitor_key) DO UPDATE SET
    session_row_id = excluded.session_row_id,
    latest_at = excluded.latest_at,
    updated_at = CURRENT_TIMESTAMP
  WHERE excluded.latest_at > tracking_visitor_latest.latest_at
     OR (excluded.latest_at = tracking_visitor_latest.latest_at
         AND excluded.session_row_id > tracking_visitor_latest.session_row_id);
END;

CREATE INDEX IF NOT EXISTS idx_sessions_visitor_projection_backfill
  ON sessions(visitor_projection_version, id);
CREATE INDEX IF NOT EXISTS idx_sessions_visitor_projection_recent
  ON sessions(started_at DESC, id DESC)
  WHERE visitor_projection_version < 3;
CREATE INDEX IF NOT EXISTS idx_sessions_visitor_key_started_page
  ON sessions(visitor_key, started_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_visitor_key_created_page
  ON sessions(visitor_key, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_campaign_started_page
  ON sessions(campaign_id, started_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_adset_started_page
  ON sessions(adset_id, started_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_ad_started_page
  ON sessions(ad_id, started_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_contacts_created_at_id
  ON contacts(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_contact_created_at_id
  ON sessions(contact_id, created_at DESC, id DESC);
