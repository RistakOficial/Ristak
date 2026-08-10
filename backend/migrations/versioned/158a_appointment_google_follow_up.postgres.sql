ALTER TABLE appointments
ADD COLUMN IF NOT EXISTS follow_up_from_appointment_id TEXT;

CREATE INDEX IF NOT EXISTS idx_appointments_follow_up_from
ON appointments(follow_up_from_appointment_id);
