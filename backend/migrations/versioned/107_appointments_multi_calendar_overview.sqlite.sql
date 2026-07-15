CREATE INDEX IF NOT EXISTS idx_appointments_multi_calendar_overview
  ON appointments(julianday(start_time), id)
  WHERE start_time IS NOT NULL
    AND deleted_at IS NULL
    AND COALESCE(sync_status, '') != 'pending_delete';
