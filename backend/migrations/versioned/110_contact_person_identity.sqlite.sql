-- Read model angosto para deduplicar contactos sin ventanas globales. La
-- migracion no recorre contacts: el historico lo llena el worker en lotes.
CREATE TABLE IF NOT EXISTS contact_person_identity (
  contact_id TEXT PRIMARY KEY,
  campaign_person_key TEXT NOT NULL,
  report_person_key TEXT NOT NULL,
  projection_version INTEGER NOT NULL DEFAULT 1,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_contact_person_identity_campaign
  ON contact_person_identity(campaign_person_key, contact_id);
CREATE INDEX IF NOT EXISTS idx_contact_person_identity_report
  ON contact_person_identity(report_person_key, contact_id);

CREATE TABLE IF NOT EXISTS contact_person_identity_projection_state (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  projection_version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'backfilling'
    CHECK (status IN ('backfilling', 'ready', 'failed')),
  generation INTEGER NOT NULL DEFAULT 0,
  processed_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO contact_person_identity_projection_state (
  singleton_id, projection_version, status
) VALUES (1, 1, 'backfilling');

DROP VIEW IF EXISTS ristak_contact_person_identity_source;
CREATE VIEW ristak_contact_person_identity_source AS
WITH contact_keys AS (
  SELECT
    c.id AS contact_id,
    CASE
      WHEN c.email IS NOT NULL AND c.email LIKE '%@%'
        THEN 'email::' || LOWER(TRIM(c.email))
      WHEN c.phone IS NOT NULL AND LENGTH(
        REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
          COALESCE(c.phone, ''), ' ', ''), '-', ''), '(', ''), ')', ''), '+', ''), '.', ''), '/', '')
      ) >= 10
        THEN 'phone::' || SUBSTR(
          REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
            COALESCE(c.phone, ''), ' ', ''), '-', ''), '(', ''), ')', ''), '+', ''), '.', ''), '/', ''),
          -10
        )
      ELSE 'id::' || c.id
    END AS campaign_person_key,
    CASE
      WHEN c.email IS NOT NULL AND c.email LIKE '%@%'
        THEN 'email::' || LOWER(TRIM(c.email))
      ELSE COALESCE(
        (
          SELECT CASE
            WHEN LENGTH(REPLACE(COALESCE(cpn.phone, ''), '+', '')) >= 10
              THEN 'phone::' || SUBSTR(REPLACE(COALESCE(cpn.phone, ''), '+', ''), -10)
            ELSE NULL
          END
          FROM contact_phone_numbers cpn
          WHERE cpn.contact_id = c.id
          ORDER BY cpn.is_primary DESC, cpn.updated_at DESC, cpn.id
          LIMIT 1
        ),
        (
          WITH RECURSIVE normalized_phone(rest, digits) AS (
            SELECT COALESCE(CAST(c.phone AS TEXT), ''), ''
            UNION ALL
            SELECT
              SUBSTR(rest, 2),
              digits || CASE
                WHEN SUBSTR(rest, 1, 1) GLOB '[0-9]' THEN SUBSTR(rest, 1, 1)
                ELSE ''
              END
            FROM normalized_phone
            WHERE rest != ''
          )
          SELECT CASE
            WHEN LENGTH(digits) >= 10 THEN 'phone::' || SUBSTR(digits, -10)
            ELSE 'id::' || c.id
          END
          FROM normalized_phone
          WHERE rest = ''
          LIMIT 1
        )
      )
    END AS report_person_key
  FROM contacts c
)
SELECT contact_id, campaign_person_key, report_person_key
FROM contact_keys;

DROP TRIGGER IF EXISTS trg_contact_person_identity_contact_insert;
CREATE TRIGGER trg_contact_person_identity_contact_insert
AFTER INSERT ON contacts BEGIN
  INSERT INTO contact_person_identity (
    contact_id, campaign_person_key, report_person_key, projection_version, updated_at
  )
  SELECT contact_id, campaign_person_key, report_person_key, 1, CURRENT_TIMESTAMP
  FROM ristak_contact_person_identity_source
  WHERE contact_id = NEW.id
  ON CONFLICT(contact_id) DO UPDATE SET
    campaign_person_key = excluded.campaign_person_key,
    report_person_key = excluded.report_person_key,
    projection_version = excluded.projection_version,
    updated_at = CURRENT_TIMESTAMP;
  UPDATE contact_person_identity_projection_state
  SET generation = generation + 1, updated_at = CURRENT_TIMESTAMP
  WHERE singleton_id = 1 AND status != 'ready';
END;

DROP TRIGGER IF EXISTS trg_contact_person_identity_contact_update;
CREATE TRIGGER trg_contact_person_identity_contact_update
AFTER UPDATE OF email, phone ON contacts BEGIN
  INSERT INTO contact_person_identity (
    contact_id, campaign_person_key, report_person_key, projection_version, updated_at
  )
  SELECT contact_id, campaign_person_key, report_person_key, 1, CURRENT_TIMESTAMP
  FROM ristak_contact_person_identity_source
  WHERE contact_id = NEW.id
  ON CONFLICT(contact_id) DO UPDATE SET
    campaign_person_key = excluded.campaign_person_key,
    report_person_key = excluded.report_person_key,
    projection_version = excluded.projection_version,
    updated_at = CURRENT_TIMESTAMP;
  UPDATE contact_person_identity_projection_state
  SET generation = generation + 1, updated_at = CURRENT_TIMESTAMP
  WHERE singleton_id = 1 AND status != 'ready';
END;

DROP TRIGGER IF EXISTS trg_contact_person_identity_contact_delete;
CREATE TRIGGER trg_contact_person_identity_contact_delete
AFTER DELETE ON contacts BEGIN
  DELETE FROM contact_person_identity WHERE contact_id = OLD.id;
  UPDATE contact_person_identity_projection_state
  SET generation = generation + 1, updated_at = CURRENT_TIMESTAMP
  WHERE singleton_id = 1 AND status != 'ready';
END;

DROP TRIGGER IF EXISTS trg_contact_person_identity_phone_insert;
CREATE TRIGGER trg_contact_person_identity_phone_insert
AFTER INSERT ON contact_phone_numbers BEGIN
  INSERT INTO contact_person_identity (
    contact_id, campaign_person_key, report_person_key, projection_version, updated_at
  )
  SELECT contact_id, campaign_person_key, report_person_key, 1, CURRENT_TIMESTAMP
  FROM ristak_contact_person_identity_source
  WHERE contact_id = NEW.contact_id
  ON CONFLICT(contact_id) DO UPDATE SET
    campaign_person_key = excluded.campaign_person_key,
    report_person_key = excluded.report_person_key,
    projection_version = excluded.projection_version,
    updated_at = CURRENT_TIMESTAMP;
  UPDATE contact_person_identity_projection_state
  SET generation = generation + 1, updated_at = CURRENT_TIMESTAMP
  WHERE singleton_id = 1 AND status != 'ready';
END;

DROP TRIGGER IF EXISTS trg_contact_person_identity_phone_update;
CREATE TRIGGER trg_contact_person_identity_phone_update
AFTER UPDATE OF contact_id, phone, is_primary, updated_at ON contact_phone_numbers BEGIN
  INSERT INTO contact_person_identity (
    contact_id, campaign_person_key, report_person_key, projection_version, updated_at
  )
  SELECT contact_id, campaign_person_key, report_person_key, 1, CURRENT_TIMESTAMP
  FROM ristak_contact_person_identity_source
  WHERE contact_id = OLD.contact_id
  ON CONFLICT(contact_id) DO UPDATE SET
    campaign_person_key = excluded.campaign_person_key,
    report_person_key = excluded.report_person_key,
    projection_version = excluded.projection_version,
    updated_at = CURRENT_TIMESTAMP;
  INSERT INTO contact_person_identity (
    contact_id, campaign_person_key, report_person_key, projection_version, updated_at
  )
  SELECT contact_id, campaign_person_key, report_person_key, 1, CURRENT_TIMESTAMP
  FROM ristak_contact_person_identity_source
  WHERE contact_id = NEW.contact_id
  ON CONFLICT(contact_id) DO UPDATE SET
    campaign_person_key = excluded.campaign_person_key,
    report_person_key = excluded.report_person_key,
    projection_version = excluded.projection_version,
    updated_at = CURRENT_TIMESTAMP;
  UPDATE contact_person_identity_projection_state
  SET generation = generation + 1, updated_at = CURRENT_TIMESTAMP
  WHERE singleton_id = 1 AND status != 'ready';
END;

DROP TRIGGER IF EXISTS trg_contact_person_identity_phone_delete;
CREATE TRIGGER trg_contact_person_identity_phone_delete
AFTER DELETE ON contact_phone_numbers BEGIN
  INSERT INTO contact_person_identity (
    contact_id, campaign_person_key, report_person_key, projection_version, updated_at
  )
  SELECT contact_id, campaign_person_key, report_person_key, 1, CURRENT_TIMESTAMP
  FROM ristak_contact_person_identity_source
  WHERE contact_id = OLD.contact_id
  ON CONFLICT(contact_id) DO UPDATE SET
    campaign_person_key = excluded.campaign_person_key,
    report_person_key = excluded.report_person_key,
    projection_version = excluded.projection_version,
    updated_at = CURRENT_TIMESTAMP;
  UPDATE contact_person_identity_projection_state
  SET generation = generation + 1, updated_at = CURRENT_TIMESTAMP
  WHERE singleton_id = 1 AND status != 'ready';
END;
