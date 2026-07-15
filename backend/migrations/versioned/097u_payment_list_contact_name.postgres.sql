CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payment_list_activity_contact_name
  ON payment_list_activity(contact_name_sort, created_sort, payment_id);
