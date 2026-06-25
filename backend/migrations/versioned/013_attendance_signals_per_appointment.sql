-- (DB-008) Una señal de asistencia por CITA (opción A: historial completo), no una por contacto.
-- Antes la PK era contact_id => solo sobrevivía la ÚLTIMA señal por contacto y se perdía el
-- historial. Ahora la PK es un id determinista contact_id||':'||appointment_id, de modo que cada
-- (contacto, cita) tiene su propia fila y se conserva el historial completo. Las señales SIN cita
-- (appointment_id vacío) quedan como una por contacto (id = contact_id||':').
--
-- Cambiar la PRIMARY KEY no se puede ALTERar en SQLite, así que se recrea la tabla y se copian los
-- datos existentes con el id determinista. Cross-DB: || concatena igual en SQLite y PostgreSQL;
-- ON CONFLICT(id) DO NOTHING funciona en ambos; CREATE TABLE con DATETIME DEFAULT CURRENT_TIMESTAMP
-- es válido (la restricción de CURRENT_TIMESTAMP solo aplica a ALTER ADD COLUMN). El runner ejecuta
-- el archivo completo en una transacción implícita en Postgres (atómico) y secuencialmente en SQLite;
-- si fallara a mitad, initTables recrea la tabla vacía en el siguiente boot y la migración se re-aplica.
CREATE TABLE IF NOT EXISTS appointment_attendance_signals_v2 (
  id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL,
  appointment_id TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'webhook_showed',
  first_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- (sin ON CONFLICT: la tabla origen tiene contact_id como PK => único por contacto, así que
--  contact_id||':'||appointment_id no puede colisionar. Además SQLite no acepta ON CONFLICT tras
--  un INSERT...SELECT, lo interpreta como el ON de un JOIN.)
INSERT INTO appointment_attendance_signals_v2 (id, contact_id, appointment_id, source, first_seen_at, updated_at)
  SELECT
    contact_id || ':' || COALESCE(appointment_id, ''),
    contact_id,
    COALESCE(appointment_id, ''),
    COALESCE(source, 'webhook_showed'),
    first_seen_at,
    updated_at
  FROM appointment_attendance_signals;

DROP TABLE appointment_attendance_signals;
ALTER TABLE appointment_attendance_signals_v2 RENAME TO appointment_attendance_signals;

CREATE INDEX IF NOT EXISTS idx_attendance_signals_appointment ON appointment_attendance_signals(appointment_id);
CREATE INDEX IF NOT EXISTS idx_attendance_signals_contact ON appointment_attendance_signals(contact_id);
