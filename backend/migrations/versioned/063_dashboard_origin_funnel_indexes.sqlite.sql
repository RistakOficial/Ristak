CREATE INDEX IF NOT EXISTS idx_dashboard_appointments_added_contact_calendar
  ON appointments(date_added, contact_id, calendar_id);

CREATE INDEX IF NOT EXISTS idx_contact_source_sessions_visitor_first
  ON sessions(visitor_id, started_at, created_at, id);

CREATE INDEX IF NOT EXISTS idx_contact_source_sessions_email_first
  ON sessions(LOWER(email), started_at, created_at, id);

CREATE INDEX IF NOT EXISTS idx_contact_source_whatsapp_first
  ON whatsapp_attribution(contact_id, created_at, id);

CREATE INDEX IF NOT EXISTS idx_contact_source_whatsapp_api_first
  ON whatsapp_api_messages(
    contact_id,
    LOWER(COALESCE(direction, '')),
    COALESCE(message_timestamp, created_at),
    id
  );
