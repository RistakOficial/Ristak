CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payment_list_activity_contact_email
  ON payment_list_activity(contact_email_sort, created_sort, payment_id);
