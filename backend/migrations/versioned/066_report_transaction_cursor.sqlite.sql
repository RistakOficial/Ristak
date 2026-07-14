CREATE INDEX IF NOT EXISTS idx_report_transactions_live_date_id
  ON payments(date DESC, id DESC)
  WHERE COALESCE(payment_mode, 'live') != 'test';
