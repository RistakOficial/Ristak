ALTER TABLE users ADD COLUMN access_config TEXT;
CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone);
