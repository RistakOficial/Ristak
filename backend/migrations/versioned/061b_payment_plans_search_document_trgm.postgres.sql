CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payment_plans_search_document_trgm
  ON payment_plans USING GIN ((
    LOWER(
      COALESCE(id, '') || ' ' ||
      COALESCE(name, '') || ' ' ||
      COALESCE(title, '') || ' ' ||
      COALESCE(contact_name, '') || ' ' ||
      COALESCE(email, '') || ' ' ||
      COALESCE(phone, '') || ' ' ||
      COALESCE(description, '') || ' ' ||
      COALESCE(recurrence_label, '') || ' ' ||
      COALESCE(source, '')
    )
  ) gin_trgm_ops);
