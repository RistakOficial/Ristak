-- (AUTH-010) Tokens de recuperación de contraseña por correo. Se guarda solo el HASH
-- del token (un dump de la DB no permite usarlos), con expiración y un solo uso.
-- Aditiva e idempotente vía el runner versionado.
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  expires_at DATETIME NOT NULL,
  used_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_password_reset_token_hash ON password_reset_tokens(token_hash);
