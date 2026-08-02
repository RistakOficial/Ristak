ALTER TABLE contacts
ADD COLUMN IF NOT EXISTS referred_by_contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_contacts_referred_by
ON contacts(referred_by_contact_id);

CREATE OR REPLACE VIEW contact_effective_ad_attribution AS
WITH RECURSIVE referral_chain(contact_id, candidate_contact_id, referral_depth) AS (
  SELECT id, id, 0
  FROM contacts
  UNION ALL
  SELECT chain.contact_id, referrer.id, chain.referral_depth + 1
  FROM referral_chain chain
  INNER JOIN contacts current_contact ON current_contact.id = chain.candidate_contact_id
  INNER JOIN contacts referrer ON referrer.id = current_contact.referred_by_contact_id
  WHERE chain.referral_depth < 25
), ranked_candidates AS (
  SELECT
    chain.contact_id,
    chain.candidate_contact_id,
    chain.referral_depth,
    ROW_NUMBER() OVER (
      PARTITION BY chain.contact_id
      ORDER BY
        CASE
          WHEN NULLIF(TRIM(candidate.attribution_ad_id), '') IS NOT NULL THEN 0
          ELSE 1
        END,
        chain.referral_depth,
        chain.candidate_contact_id
    ) AS attribution_rank
  FROM referral_chain chain
  INNER JOIN contacts candidate ON candidate.id = chain.candidate_contact_id
)
SELECT
  contact_id,
  candidate_contact_id AS attribution_contact_id,
  referral_depth,
  referral_depth > 0 AS inherited_from_referral
FROM ranked_candidates
WHERE attribution_rank = 1;

DROP TRIGGER IF EXISTS trg_campaign_perf_contacts_update ON contacts;
CREATE TRIGGER trg_campaign_perf_contacts_update
AFTER UPDATE OF
  attribution_ad_id, referred_by_contact_id, created_at, purchases_count,
  total_paid, appointment_date, full_name, email, phone
ON contacts
FOR EACH STATEMENT EXECUTE FUNCTION ristak_bump_campaign_performance_revision();
