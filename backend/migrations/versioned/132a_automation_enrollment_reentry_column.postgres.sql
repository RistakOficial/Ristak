ALTER TABLE automation_enrollments
  ADD COLUMN IF NOT EXISTS dedupe_contact_id TEXT;

UPDATE automation_enrollments
SET dedupe_contact_id = contact_id
WHERE contact_id IS NOT NULL
  AND status IN ('active', 'waiting', 'paused')
  AND dedupe_contact_id IS NULL;
