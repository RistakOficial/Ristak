CREATE INDEX IF NOT EXISTS idx_contacts_assignment_test_effect
  ON contacts(assignment_test_effect_id)
  WHERE assignment_test_effect_id IS NOT NULL AND assignment_test_effect_id != '';
