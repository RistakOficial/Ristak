ALTER TABLE whatsapp_api_phone_numbers
  ADD COLUMN IF NOT EXISTS qr_fallback_phone_number_id TEXT
  REFERENCES whatsapp_api_phone_numbers(id) ON DELETE SET NULL;
