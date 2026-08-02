-- initTables repara estas columnas antes de ejecutar migraciones versionadas.
-- Los SELECT validan el contrato y fallan cerrado si una instalación SQLite
-- quedó incompleta, sin intentar duplicar columnas en instalaciones nuevas.
SELECT confirmation_reply_text
FROM appointment_reminders
LIMIT 0;

SELECT
  confirmation_reply_sent_at,
  confirmation_reply_message_id
FROM appointment_reminder_sends
LIMIT 0;
