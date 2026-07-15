CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payment_list_activity_contact
  ON payment_list_activity(contact_id, payment_id);
