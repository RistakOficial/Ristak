-- (MOB-006) Configuración de notificaciones del celular POR USUARIO.
-- Espejo por-usuario de app_config: cuando un usuario no tiene fila propia para una
-- clave, hereda el valor global de app_config (fallback en código, ver getUserAppConfig).
-- Solo se sobre-escriben las 7 preferencias de notificaciones móviles; app_config sigue
-- siendo el default global del tenant.
--
-- Aditiva e idempotente (CREATE TABLE IF NOT EXISTS + CREATE UNIQUE INDEX IF NOT EXISTS).
-- Cross-DB: INTEGER PRIMARY KEY AUTOINCREMENT lo normaliza el adaptador a SERIAL en Postgres;
-- DATETIME DEFAULT CURRENT_TIMESTAMP es válido en CREATE TABLE (la restricción de
-- CURRENT_TIMESTAMP solo aplica a ALTER ADD COLUMN). user_id es INTEGER porque users.id es
-- INTEGER. El índice único (user_id, config_key) habilita el ON CONFLICT del upsert.
CREATE TABLE IF NOT EXISTS user_app_config (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  config_key TEXT NOT NULL,
  config_value TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_app_config_user_key ON user_app_config(user_id, config_key);
