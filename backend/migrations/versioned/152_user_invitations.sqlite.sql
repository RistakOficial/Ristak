-- Invitaciones de acceso sin contraseña. Sólo se guarda el hash del token.
CREATE TABLE user_invitations (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  phone TEXT,
  first_name TEXT,
  last_name TEXT,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'employee')),
  access_config TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  invited_by_user_id INTEGER NOT NULL,
  accepted_user_id INTEGER,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepting', 'accepted', 'revoked', 'expired')),
  expires_at DATETIME NOT NULL,
  delivered_at DATETIME,
  accepted_at DATETIME,
  revoked_at DATETIME,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (invited_by_user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (accepted_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX idx_user_invitations_email_status
  ON user_invitations(email, status, created_at);
CREATE INDEX idx_user_invitations_expiry
  ON user_invitations(expires_at, status);
