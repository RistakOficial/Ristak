ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS booking_origin TEXT;

UPDATE appointments
SET booking_origin = 'contact'
WHERE booking_origin IS NULL
  AND LOWER(COALESCE(source, '')) = 'conversational_agent_v2';
