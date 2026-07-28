-- Contact origin V2: separa superficie real, evidencia de anuncio y fuente de
-- marketing. La generación V1 se conserva hasta que el worker publique V2.
ALTER TABLE contact_origin_contact_fact
  ADD COLUMN acquisition_surface TEXT NOT NULL DEFAULT 'unknown'
  CHECK (acquisition_surface IN (
    'website', 'whatsapp', 'messenger', 'instagram', 'email',
    'manual', 'import', 'api', 'other', 'unknown'
  ));

ALTER TABLE contact_origin_contact_fact
  ADD COLUMN acquisition_kind TEXT NOT NULL DEFAULT 'unattributed'
  CHECK (acquisition_kind IN ('paid_ad', 'unattributed'));

ALTER TABLE contact_origin_contact_fact
  ADD COLUMN evidence_type TEXT NOT NULL DEFAULT 'no_verified_evidence';

CREATE INDEX IF NOT EXISTS idx_contact_origin_fact_acquisition_lead
  ON contact_origin_contact_fact(
    generation, lead_business_date, acquisition_surface,
    acquisition_kind, resolved_source, contact_id
  );

CREATE INDEX IF NOT EXISTS idx_contact_origin_fact_acquisition_buyer
  ON contact_origin_contact_fact(
    generation, first_payment_business_date, acquisition_surface,
    acquisition_kind, resolved_source, contact_id
  )
  WHERE first_payment_business_date IS NOT NULL;

UPDATE contact_origin_projection_state
SET projection_version = 2,
    status = 'backfilling',
    last_error = NULL,
    updated_at = CURRENT_TIMESTAMP
WHERE singleton_id = 1;

-- Compradores V2 se deriva directamente de pagos live exitosos con importe
-- positivo. Cada mutación sólo coalesce las llaves afectadas; el worker hace la
-- consulta histórica fuera del write path.
DROP TRIGGER IF EXISTS trg_contact_origin_payment_insert;
CREATE TRIGGER trg_contact_origin_payment_insert AFTER INSERT ON payments BEGIN
  INSERT INTO contact_origin_contact_queue(contact_id, revision, enqueued_at)
  SELECT NEW.contact_id, 1, CURRENT_TIMESTAMP
  WHERE NEW.contact_id IS NOT NULL AND NEW.contact_id != ''
  ON CONFLICT(contact_id) DO UPDATE SET
    revision = contact_origin_contact_queue.revision + 1,
    enqueued_at = CURRENT_TIMESTAMP;
END;

DROP TRIGGER IF EXISTS trg_contact_origin_payment_update;
CREATE TRIGGER trg_contact_origin_payment_update
AFTER UPDATE OF contact_id, amount, status, payment_mode, paid_at, date, created_at
ON payments
WHEN NEW.contact_id IS NOT OLD.contact_id
  OR NEW.amount IS NOT OLD.amount
  OR NEW.status IS NOT OLD.status
  OR NEW.payment_mode IS NOT OLD.payment_mode
  OR NEW.paid_at IS NOT OLD.paid_at
  OR NEW.date IS NOT OLD.date
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  INSERT INTO contact_origin_contact_queue(contact_id, revision, enqueued_at)
  SELECT contact_id, 1, CURRENT_TIMESTAMP
  FROM (
    SELECT CAST(OLD.contact_id AS TEXT) AS contact_id
    UNION
    SELECT CAST(NEW.contact_id AS TEXT)
  ) changed
  WHERE contact_id IS NOT NULL AND contact_id != ''
  ON CONFLICT(contact_id) DO UPDATE SET
    revision = contact_origin_contact_queue.revision + 1,
    enqueued_at = CURRENT_TIMESTAMP;
END;

DROP TRIGGER IF EXISTS trg_contact_origin_payment_delete;
CREATE TRIGGER trg_contact_origin_payment_delete AFTER DELETE ON payments BEGIN
  INSERT INTO contact_origin_contact_queue(contact_id, revision, enqueued_at)
  SELECT OLD.contact_id, 1, CURRENT_TIMESTAMP
  WHERE OLD.contact_id IS NOT NULL AND OLD.contact_id != ''
  ON CONFLICT(contact_id) DO UPDATE SET
    revision = contact_origin_contact_queue.revision + 1,
    enqueued_at = CURRENT_TIMESTAMP;
END;

-- El read model sólo acepta page_view como visita verificada. Si un evento
-- cambia de tipo, hay que reconciliar las identidades relacionadas.
DROP TRIGGER IF EXISTS trg_contact_origin_session_update;
CREATE TRIGGER trg_contact_origin_session_update
AFTER UPDATE OF id, contact_id, visitor_id, email, event_name, started_at, created_at,
  referrer_url, site_source_name, utm_source, utm_medium, source_platform,
  channel, gclid, fbclid, wbraid, gbraid, msclkid, ttclid, campaign_id, ad_id
ON sessions
WHEN NEW.id IS NOT OLD.id
  OR NEW.contact_id IS NOT OLD.contact_id OR NEW.visitor_id IS NOT OLD.visitor_id
  OR NEW.email IS NOT OLD.email OR NEW.event_name IS NOT OLD.event_name
  OR NEW.started_at IS NOT OLD.started_at OR NEW.created_at IS NOT OLD.created_at
  OR NEW.referrer_url IS NOT OLD.referrer_url
  OR NEW.site_source_name IS NOT OLD.site_source_name
  OR NEW.utm_source IS NOT OLD.utm_source OR NEW.utm_medium IS NOT OLD.utm_medium
  OR NEW.source_platform IS NOT OLD.source_platform OR NEW.channel IS NOT OLD.channel
  OR NEW.gclid IS NOT OLD.gclid OR NEW.fbclid IS NOT OLD.fbclid
  OR NEW.wbraid IS NOT OLD.wbraid OR NEW.gbraid IS NOT OLD.gbraid
  OR NEW.msclkid IS NOT OLD.msclkid OR NEW.ttclid IS NOT OLD.ttclid
  OR NEW.campaign_id IS NOT OLD.campaign_id OR NEW.ad_id IS NOT OLD.ad_id
BEGIN
  INSERT INTO contact_origin_identity_queue(identity_kind, identity_value, revision, enqueued_at)
  SELECT kind, value, 1, CURRENT_TIMESTAMP
  FROM (
    SELECT 'contact' AS kind, CAST(OLD.contact_id AS TEXT) AS value
    UNION ALL SELECT 'contact', CAST(NEW.contact_id AS TEXT)
    UNION ALL SELECT 'visitor', CAST(OLD.visitor_id AS TEXT)
    UNION ALL SELECT 'visitor', CAST(NEW.visitor_id AS TEXT)
    UNION ALL SELECT 'email', LOWER(TRIM(CAST(OLD.email AS TEXT)))
    UNION ALL SELECT 'email', LOWER(TRIM(CAST(NEW.email AS TEXT)))
  ) identities
  WHERE value IS NOT NULL AND value != ''
  ON CONFLICT(identity_kind, identity_value) DO UPDATE SET
    revision = contact_origin_identity_queue.revision + 1,
    enqueued_at = CURRENT_TIMESTAMP;
END;
