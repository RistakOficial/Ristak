-- Contact origin V2: superficie de adquisición y evidencia de anuncio quedan
-- ortogonales a la plataforma de marketing ya guardada en resolved_source.
ALTER TABLE contact_origin_contact_fact
  ADD COLUMN IF NOT EXISTS acquisition_surface TEXT NOT NULL DEFAULT 'unknown'
  CHECK (acquisition_surface IN (
    'website', 'whatsapp', 'messenger', 'instagram', 'email',
    'manual', 'import', 'api', 'other', 'unknown'
  ));

ALTER TABLE contact_origin_contact_fact
  ADD COLUMN IF NOT EXISTS acquisition_kind TEXT NOT NULL DEFAULT 'unattributed'
  CHECK (acquisition_kind IN ('paid_ad', 'unattributed'));

ALTER TABLE contact_origin_contact_fact
  ADD COLUMN IF NOT EXISTS evidence_type TEXT NOT NULL DEFAULT 'no_verified_evidence';

UPDATE contact_origin_projection_state
SET projection_version = 2,
    status = 'backfilling',
    last_error = NULL,
    updated_at = CURRENT_TIMESTAMP
WHERE singleton_id = 1;

DROP TRIGGER IF EXISTS trg_contact_origin_payments ON payments;
CREATE TRIGGER trg_contact_origin_payments
AFTER INSERT OR DELETE OR UPDATE OF
  contact_id, amount, status, payment_mode, paid_at, date, created_at
ON payments FOR EACH ROW EXECUTE FUNCTION enqueue_contact_origin_related_change();

DROP TRIGGER IF EXISTS trg_contact_origin_sessions ON sessions;
CREATE TRIGGER trg_contact_origin_sessions
AFTER INSERT OR DELETE OR UPDATE OF
  id, contact_id, visitor_id, email, event_name, started_at, created_at,
  referrer_url, site_source_name, utm_source, utm_medium, source_platform,
  channel, gclid, fbclid, wbraid, gbraid, msclkid, ttclid, campaign_id, ad_id
ON sessions FOR EACH ROW EXECUTE FUNCTION enqueue_contact_origin_session_identities();
