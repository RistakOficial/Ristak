CREATE INDEX IF NOT EXISTS idx_appointments_test_cleanup
  ON appointments(test_expires_at)
  WHERE is_test = 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_appointments_test_effect_unique
  ON appointments(test_effect_id)
  WHERE test_effect_id IS NOT NULL AND test_effect_id != '';
