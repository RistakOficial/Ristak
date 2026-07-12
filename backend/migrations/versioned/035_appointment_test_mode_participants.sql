CREATE TABLE IF NOT EXISTS appointment_participants (
  id TEXT PRIMARY KEY,
  appointment_id TEXT NOT NULL,
  role TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  contact_id TEXT,
  name_snapshot TEXT,
  phone_snapshot TEXT,
  email_snapshot TEXT,
  relation_snapshot TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE CASCADE,
  FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL,
  UNIQUE(appointment_id, role, position)
);

CREATE INDEX IF NOT EXISTS idx_appointment_participants_appointment
  ON appointment_participants(appointment_id, role, position);

CREATE INDEX IF NOT EXISTS idx_appointment_participants_contact
  ON appointment_participants(contact_id);
