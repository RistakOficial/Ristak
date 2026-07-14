ALTER TABLE calendars
  ADD COLUMN availability_schedule_configured INTEGER NOT NULL DEFAULT 0;

UPDATE calendars
SET availability_schedule_configured = 1
WHERE COALESCE(availability_schedule_configured, 0) = 0
  AND open_hours IS NOT NULL
  AND TRIM(open_hours) NOT IN ('', '[]');

UPDATE calendars
SET open_hours = '[{"daysOfTheWeek":[1,2,3,4,5],"hours":[{"openHour":9,"openMinute":0,"closeHour":17,"closeMinute":0}]}]',
    availability_schedule_configured = 1
WHERE COALESCE(availability_schedule_configured, 0) = 0
  AND (open_hours IS NULL OR TRIM(open_hours) IN ('', '[]'));
