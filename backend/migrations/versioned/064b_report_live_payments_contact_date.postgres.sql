CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_report_live_payments_contact_date
  ON payments(contact_id, date)
  WHERE LOWER(COALESCE(status, '')) IN ('succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success')
    AND COALESCE(payment_mode, 'live') != 'test';
