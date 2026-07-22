ALTER TABLE appointment_reminders
  ADD COLUMN IF NOT EXISTS schedule_key TEXT;

WITH reminder_schedule_candidates AS (
  SELECT
    id,
    COALESCE(timing_anchor, 'before_appointment') || ':' || CAST(
      CASE
        WHEN COALESCE(timing_anchor, 'before_appointment') = 'after_booking' THEN
          CASE COALESCE(offset_unit, 'minutes')
            WHEN 'seconds' THEN COALESCE(offset_value, 0) * 1000
            WHEN 'hours' THEN COALESCE(offset_value, 0) * 3600000
            ELSE COALESCE(offset_value, 0) * 60000
          END
        ELSE
          CASE COALESCE(offset_unit, 'days')
            WHEN 'minutes' THEN COALESCE(offset_value, 1) * 60000
            WHEN 'hours' THEN COALESCE(offset_value, 1) * 3600000
            ELSE COALESCE(offset_value, 1) * 86400000
          END
      END AS TEXT
    ) AS candidate_key,
    created_at
  FROM appointment_reminders
), ranked_reminder_schedules AS (
  SELECT
    id,
    candidate_key,
    ROW_NUMBER() OVER (
      PARTITION BY candidate_key
      ORDER BY created_at ASC, id ASC
    ) AS schedule_rank
  FROM reminder_schedule_candidates
)
UPDATE appointment_reminders
SET schedule_key = ranked_reminder_schedules.candidate_key
FROM ranked_reminder_schedules
WHERE appointment_reminders.id = ranked_reminder_schedules.id
  AND appointment_reminders.schedule_key IS NULL
  AND ranked_reminder_schedules.schedule_rank = 1
  AND NOT EXISTS (
    SELECT 1
    FROM appointment_reminders occupied_schedule
    WHERE occupied_schedule.schedule_key = ranked_reminder_schedules.candidate_key
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_appointment_reminders_schedule_key
  ON appointment_reminders(schedule_key)
  WHERE schedule_key IS NOT NULL;
