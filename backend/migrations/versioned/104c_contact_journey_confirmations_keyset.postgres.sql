CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contact_journey_confirmations_keyset
  ON appointment_confirmation_windows(contact_id, processed_at DESC, updated_at DESC, created_at DESC, id DESC);

