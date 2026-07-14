CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_subscriptions_search_trgm
  ON subscriptions USING GIN ((
    LOWER(
      COALESCE(id, '') || ' ' ||
      COALESCE(name, '') || ' ' ||
      COALESCE(description, '') || ' ' ||
      COALESCE(contact_name, '') || ' ' ||
      COALESCE(contact_email, '') || ' ' ||
      COALESCE(contact_phone, '') || ' ' ||
      COALESCE(payment_provider, '') || ' ' ||
      COALESCE(payment_method, '')
    )
  ) gin_trgm_ops)
  WHERE COALESCE(status, '') <> 'deleted';
