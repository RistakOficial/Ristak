CREATE INDEX IF NOT EXISTS idx_report_payments_contact_date
  ON payments(contact_id, date DESC, status, payment_mode);

CREATE INDEX IF NOT EXISTS idx_report_appointments_contact_added
  ON appointments(contact_id, date_added DESC, calendar_id);

CREATE INDEX IF NOT EXISTS idx_subscriptions_list_status_next
  ON subscriptions(status, next_run_at, updated_at DESC, id DESC);
