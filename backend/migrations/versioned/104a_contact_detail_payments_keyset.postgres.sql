CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contact_detail_payments_keyset
  ON payments(contact_id, date DESC, created_at DESC, id DESC);

