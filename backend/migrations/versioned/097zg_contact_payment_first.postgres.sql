CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contact_payment_items_contact_first
  ON contact_payment_activity_items(contact_id, first_payment_sort ASC, payment_id ASC)
  WHERE first_payment_sort IS NOT NULL;
