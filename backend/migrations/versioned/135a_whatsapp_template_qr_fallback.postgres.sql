ALTER TABLE whatsapp_api_template_sends
  ADD COLUMN IF NOT EXISTS qr_fallback_authorized INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS whatsapp_api_qr_fallback_attempts (
  api_message_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_message_id TEXT,
  error_code TEXT,
  error_message TEXT,
  fallback_reason TEXT NOT NULL,
  qr_phone_number_id TEXT,
  qr_message_id TEXT,
  status TEXT NOT NULL DEFAULT 'claimed',
  attempt_count INTEGER NOT NULL DEFAULT 1,
  last_error TEXT,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  sent_at TIMESTAMPTZ,
  FOREIGN KEY (api_message_id) REFERENCES whatsapp_api_messages(id) ON DELETE CASCADE,
  FOREIGN KEY (qr_phone_number_id) REFERENCES whatsapp_api_phone_numbers(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_api_template_sends_fallback
  ON whatsapp_api_template_sends(qr_fallback_authorized, provider, provider_message_id);

CREATE INDEX IF NOT EXISTS idx_whatsapp_api_qr_fallback_status
  ON whatsapp_api_qr_fallback_attempts(status, updated_at);
