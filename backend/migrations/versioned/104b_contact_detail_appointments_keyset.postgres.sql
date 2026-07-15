CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contact_detail_appointments_keyset
  ON appointments(contact_id, start_time DESC, id DESC);

