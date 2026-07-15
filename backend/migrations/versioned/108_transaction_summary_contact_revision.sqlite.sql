-- Las búsquedas/facetas de transacciones leen todos estos campos del contacto.
-- La proyección de orden sólo materializa nombre/email, pero su revisión debe
-- avanzar ante cualquier mutación capaz de cambiar un resultado cacheado.
DROP TRIGGER IF EXISTS trg_payment_list_contact_update;
CREATE TRIGGER trg_payment_list_contact_update
AFTER UPDATE OF
  full_name, first_name, last_name, email, phone, source,
  attribution_session_source
ON contacts BEGIN
  UPDATE payment_list_activity
  SET contact_name_sort = LOWER(COALESCE(NEW.full_name, '')),
      contact_email_sort = LOWER(COALESCE(NEW.email, '')),
      updated_at = CURRENT_TIMESTAMP
  WHERE contact_id = NEW.id;
  UPDATE crm_list_projection_state SET generation = generation + 1, updated_at = CURRENT_TIMESTAMP
  WHERE projection_key = 'payment_list' AND status != 'ready';
  UPDATE payment_list_revisions SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP
  WHERE scope = 'transactions' AND EXISTS (
    SELECT 1 FROM payments WHERE contact_id = NEW.id LIMIT 1
  );
END;

DROP TRIGGER IF EXISTS trg_payment_list_contact_phone_insert;
DROP TRIGGER IF EXISTS trg_payment_list_contact_phone_update;
DROP TRIGGER IF EXISTS trg_payment_list_contact_phone_delete;

CREATE TRIGGER trg_payment_list_contact_phone_insert
AFTER INSERT ON contact_phone_numbers
WHEN EXISTS (SELECT 1 FROM payments WHERE contact_id = NEW.contact_id LIMIT 1)
BEGIN
  UPDATE payment_list_revisions SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP
  WHERE scope = 'transactions';
END;

CREATE TRIGGER trg_payment_list_contact_phone_update
AFTER UPDATE OF contact_id, phone ON contact_phone_numbers
WHEN EXISTS (
  SELECT 1 FROM payments
  WHERE contact_id IN (OLD.contact_id, NEW.contact_id)
  LIMIT 1
)
BEGIN
  UPDATE payment_list_revisions SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP
  WHERE scope = 'transactions';
END;

CREATE TRIGGER trg_payment_list_contact_phone_delete
AFTER DELETE ON contact_phone_numbers
WHEN EXISTS (SELECT 1 FROM payments WHERE contact_id = OLD.contact_id LIMIT 1)
BEGIN
  UPDATE payment_list_revisions SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP
  WHERE scope = 'transactions';
END;
