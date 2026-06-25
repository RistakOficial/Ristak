-- (AUTH-003) Versión de token por usuario para poder revocar sesiones. Al cambiar la
-- contraseña se incrementa token_version y los JWT emitidos con la versión anterior dejan
-- de validar en requireAuth. Aditiva e idempotente vía el runner versionado.
ALTER TABLE users ADD COLUMN token_version INTEGER DEFAULT 0;
