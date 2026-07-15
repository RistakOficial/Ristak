CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_appointments_multi_calendar_overview
  ON appointments(start_time, id)
  WHERE start_time IS NOT NULL
    AND deleted_at IS NULL
    AND COALESCE(sync_status, '') != 'pending_delete';
