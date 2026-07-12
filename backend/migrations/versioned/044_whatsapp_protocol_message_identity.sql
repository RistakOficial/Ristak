-- La mayoría de instalaciones ya tiene whatsapp_api_messages, pero el bootstrap
-- completo se omite después de su primera ejecución. Por eso la columna debe
-- agregarse en una migración propia antes de crear cualquier índice que la use.
--
-- Si una instalación nueva ya recibió la columna desde initTables(), el runner
-- tolera "duplicate column" y marca esta migración como aplicada. El índice vive
-- en 044a para que también se ejecute en ese caso.
ALTER TABLE whatsapp_api_messages
  ADD COLUMN protocol_message_key_id TEXT;
