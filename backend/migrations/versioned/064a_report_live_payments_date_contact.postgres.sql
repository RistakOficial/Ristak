CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_report_live_payments_date_contact
  ON payments(date, contact_id)
  WHERE LOWER(COALESCE(status, '')) IN ('succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success')
    AND COALESCE(payment_mode, 'live') != 'test';
