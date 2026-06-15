-- Enlaces de disparo: URLs publicas que registran cada visita y redirigen al destino final.

CREATE TABLE IF NOT EXISTS trigger_links (
  id TEXT PRIMARY KEY,
  public_id TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  destination_url TEXT NOT NULL,
  description TEXT,
  active INTEGER DEFAULT 1,
  archived INTEGER DEFAULT 0,
  click_count INTEGER DEFAULT 0,
  last_clicked_at TIMESTAMP,
  created_by_user_id TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS trigger_link_events (
  id TEXT PRIMARY KEY,
  trigger_link_id TEXT NOT NULL,
  public_id TEXT NOT NULL,
  contact_id TEXT,
  visitor_id TEXT,
  ip_address TEXT,
  user_agent TEXT,
  referrer TEXT,
  query_json TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (trigger_link_id) REFERENCES trigger_links(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_trigger_links_public_id ON trigger_links(public_id);
CREATE INDEX IF NOT EXISTS idx_trigger_links_active ON trigger_links(active, archived);
CREATE INDEX IF NOT EXISTS idx_trigger_links_updated ON trigger_links(updated_at);
CREATE INDEX IF NOT EXISTS idx_trigger_link_events_link ON trigger_link_events(trigger_link_id, created_at);
CREATE INDEX IF NOT EXISTS idx_trigger_link_events_contact ON trigger_link_events(contact_id);
CREATE INDEX IF NOT EXISTS idx_trigger_link_events_public ON trigger_link_events(public_id, created_at);
