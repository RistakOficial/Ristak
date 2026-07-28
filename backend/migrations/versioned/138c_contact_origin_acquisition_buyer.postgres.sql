CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contact_origin_fact_acquisition_buyer
  ON contact_origin_contact_fact(
    generation, first_payment_business_date, acquisition_surface,
    acquisition_kind, resolved_source, contact_id
  )
  WHERE first_payment_business_date IS NOT NULL;
