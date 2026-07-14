CREATE INDEX IF NOT EXISTS idx_report_live_payments_date_contact
  ON payments(date, contact_id)
  WHERE LOWER(COALESCE(status, '')) IN ('succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success')
    AND COALESCE(payment_mode, 'live') != 'test';

CREATE INDEX IF NOT EXISTS idx_report_live_payments_contact_date
  ON payments(contact_id, date)
  WHERE LOWER(COALESCE(status, '')) IN ('succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success')
    AND COALESCE(payment_mode, 'live') != 'test';

CREATE INDEX IF NOT EXISTS idx_report_appointments_added_normalized
  ON appointments(
    CASE
      WHEN date_added IS NULL OR TRIM(CAST(date_added AS TEXT)) = '' THEN NULL
      WHEN typeof(date_added) IN ('integer', 'real') THEN CASE
        WHEN ABS(CAST(date_added AS REAL)) >= 100000000000
          THEN datetime(CAST(date_added AS REAL) / 1000.0, 'unixepoch')
        ELSE datetime(CAST(date_added AS REAL), 'unixepoch')
      END
      WHEN TRIM(CAST(date_added AS TEXT)) NOT GLOB '*[^0-9]*' THEN CASE
        WHEN ABS(CAST(date_added AS REAL)) >= 100000000000
          THEN datetime(CAST(date_added AS REAL) / 1000.0, 'unixepoch')
        ELSE datetime(CAST(date_added AS REAL), 'unixepoch')
      END
      ELSE datetime(date_added)
    END,
    contact_id,
    calendar_id
  );
