CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_automation_enrollments_active_contact
  ON automation_enrollments (automation_id, dedupe_contact_id)
  WHERE dedupe_contact_id IS NOT NULL
    AND status IN ('active', 'waiting', 'paused');
