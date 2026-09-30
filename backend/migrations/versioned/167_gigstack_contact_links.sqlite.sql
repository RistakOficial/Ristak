CREATE TABLE IF NOT EXISTS gigstack_contact_links (
  contact_id TEXT NOT NULL,
  payment_mode TEXT NOT NULL,
  team_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  client_profile_json TEXT NOT NULL,
  source TEXT NOT NULL,
  actor_id TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(contact_id, payment_mode, team_id),
  FOREIGN KEY(contact_id) REFERENCES contacts(id) ON DELETE CASCADE
);
