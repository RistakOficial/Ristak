CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contact_payment_items_contact
  ON contact_payment_activity_items(contact_id, payment_id);
