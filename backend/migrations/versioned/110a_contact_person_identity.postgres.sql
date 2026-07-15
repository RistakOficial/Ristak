-- Read model angosto para deduplicar contactos sin ventanas globales. La
-- migracion queda O(1): la tabla nace vacia y el historico se llena en lotes.
CREATE TABLE IF NOT EXISTS contact_person_identity (
  contact_id TEXT PRIMARY KEY REFERENCES contacts(id) ON DELETE CASCADE,
  campaign_person_key TEXT NOT NULL,
  report_person_key TEXT NOT NULL,
  projection_version INTEGER NOT NULL DEFAULT 1,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- La tabla esta vacia antes del backfill, por eso estos indices no bloquean una
-- tabla historica ni necesitan un tren CONCURRENTLY separado.
CREATE INDEX IF NOT EXISTS idx_contact_person_identity_campaign
  ON contact_person_identity(campaign_person_key, contact_id);
CREATE INDEX IF NOT EXISTS idx_contact_person_identity_report
  ON contact_person_identity(report_person_key, contact_id);

CREATE TABLE IF NOT EXISTS contact_person_identity_projection_state (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  projection_version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'backfilling'
    CHECK (status IN ('backfilling', 'ready', 'failed')),
  generation BIGINT NOT NULL DEFAULT 0,
  processed_count BIGINT NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO contact_person_identity_projection_state (
  singleton_id, projection_version, status
) VALUES (1, 1, 'backfilling')
ON CONFLICT (singleton_id) DO NOTHING;

CREATE OR REPLACE VIEW ristak_contact_person_identity_source AS
SELECT
  c.id AS contact_id,
  CASE
    WHEN c.email IS NOT NULL AND c.email LIKE '%@%'
      THEN CONCAT('email::', LOWER(TRIM(c.email)))
    WHEN c.phone IS NOT NULL
      AND LENGTH(REGEXP_REPLACE(COALESCE(c.phone, ''), '[^0-9]', '', 'g')) >= 10
      THEN CONCAT(
        'phone::',
        RIGHT(REGEXP_REPLACE(COALESCE(c.phone, ''), '[^0-9]', '', 'g'), 10)
      )
    ELSE CONCAT('id::', c.id)
  END AS campaign_person_key,
  CASE
    WHEN c.email IS NOT NULL AND c.email LIKE '%@%'
      THEN CONCAT('email::', LOWER(TRIM(c.email)))
    WHEN c.phone IS NOT NULL
      AND LENGTH(REGEXP_REPLACE(COALESCE(c.phone, ''), '[^0-9]', '', 'g')) >= 10
      THEN CONCAT(
        'phone::',
        RIGHT(REGEXP_REPLACE(COALESCE(c.phone, ''), '[^0-9]', '', 'g'), 10)
      )
    ELSE CONCAT('id::', c.id)
  END AS report_person_key
FROM contacts c;

CREATE OR REPLACE FUNCTION ristak_sync_contact_person_identity()
RETURNS TRIGGER AS $$
DECLARE
  affected_contact_id TEXT;
BEGIN
  affected_contact_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END;

  IF TG_OP = 'DELETE' THEN
    DELETE FROM contact_person_identity WHERE contact_id = affected_contact_id;
  ELSE
    INSERT INTO contact_person_identity (
      contact_id, campaign_person_key, report_person_key, projection_version, updated_at
    )
    SELECT contact_id, campaign_person_key, report_person_key, 1, CURRENT_TIMESTAMP
    FROM ristak_contact_person_identity_source
    WHERE contact_id = affected_contact_id
    ON CONFLICT (contact_id) DO UPDATE SET
      campaign_person_key = EXCLUDED.campaign_person_key,
      report_person_key = EXCLUDED.report_person_key,
      projection_version = EXCLUDED.projection_version,
      updated_at = CURRENT_TIMESTAMP;
  END IF;

  UPDATE contact_person_identity_projection_state
  SET generation = generation + 1, updated_at = CURRENT_TIMESTAMP
  WHERE singleton_id = 1 AND status != 'ready';
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_contact_person_identity_contact_insert ON contacts;
CREATE TRIGGER trg_contact_person_identity_contact_insert
AFTER INSERT ON contacts
FOR EACH ROW EXECUTE FUNCTION ristak_sync_contact_person_identity();

DROP TRIGGER IF EXISTS trg_contact_person_identity_contact_update ON contacts;
CREATE TRIGGER trg_contact_person_identity_contact_update
AFTER UPDATE OF email, phone ON contacts
FOR EACH ROW EXECUTE FUNCTION ristak_sync_contact_person_identity();

DROP TRIGGER IF EXISTS trg_contact_person_identity_contact_delete ON contacts;
CREATE TRIGGER trg_contact_person_identity_contact_delete
AFTER DELETE ON contacts
FOR EACH ROW EXECUTE FUNCTION ristak_sync_contact_person_identity();
