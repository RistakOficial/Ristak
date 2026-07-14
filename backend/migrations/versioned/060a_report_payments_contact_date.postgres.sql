CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_report_payments_contact_date
  ON payments(contact_id, date DESC, status, payment_mode);
