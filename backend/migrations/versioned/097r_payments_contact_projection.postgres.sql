CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contact_payment_items_contact_purchase
  ON contact_payment_activity_items(contact_id, purchase_sort DESC, payment_id DESC)
  WHERE purchase_sort IS NOT NULL;
