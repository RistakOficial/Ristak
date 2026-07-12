CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_conversational_test_effect
  ON payments(conversational_test_effect_id)
  WHERE conversational_test_effect_id IS NOT NULL AND conversational_test_effect_id != '';
