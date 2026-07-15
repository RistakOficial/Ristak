CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_appointments_upcoming_page
  ON appointments(calendar_id, start_time, id)
  WHERE start_time IS NOT NULL
    AND deleted_at IS NULL
    AND COALESCE(sync_status, '') != 'pending_delete';
