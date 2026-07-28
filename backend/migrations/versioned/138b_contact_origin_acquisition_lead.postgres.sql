CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contact_origin_fact_acquisition_lead
  ON contact_origin_contact_fact(
    generation, lead_business_date, acquisition_surface,
    acquisition_kind, resolved_source, contact_id
  );
