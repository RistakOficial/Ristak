CREATE INDEX IF NOT EXISTS idx_contact_detail_payments_keyset
  ON payments(contact_id, date DESC, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_contact_detail_appointments_keyset
  ON appointments(contact_id, start_time DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_contact_journey_confirmations_keyset
  ON appointment_confirmation_windows(contact_id, processed_at DESC, updated_at DESC, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_contact_journey_video_keyset
  ON video_playback_sessions(contact_id, first_event_at DESC, id DESC);

