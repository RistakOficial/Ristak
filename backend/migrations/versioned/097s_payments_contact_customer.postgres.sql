CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contact_payment_items_contact_customer
  ON contact_payment_activity_items(contact_id, customer_payment_sort DESC, payment_id DESC)
  WHERE customer_payment_sort IS NOT NULL;
