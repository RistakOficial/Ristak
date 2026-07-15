-- Amplía el trigger instalado por 097a: el search de transacciones consume
-- nombre parcial, teléfono y fuentes, no sólo full_name/email.
CREATE OR REPLACE FUNCTION ristak_payment_list_contact_trigger()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE payment_list_activity
  SET contact_name_sort = LOWER(COALESCE(NEW.full_name, '')),
      contact_email_sort = LOWER(COALESCE(NEW.email, '')),
      updated_at = CURRENT_TIMESTAMP
  WHERE contact_id = NEW.id;
  UPDATE crm_list_projection_state
  SET generation = generation + 1, updated_at = CURRENT_TIMESTAMP
  WHERE projection_key = 'payment_list' AND status != 'ready';
  UPDATE payment_list_revisions
  SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP
  WHERE scope = 'transactions'
    AND EXISTS (SELECT 1 FROM payments WHERE contact_id = NEW.id LIMIT 1);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_payment_list_contact_update ON contacts;
CREATE TRIGGER trg_payment_list_contact_update
AFTER UPDATE OF
  full_name, first_name, last_name, email, phone, source,
  attribution_session_source
ON contacts
FOR EACH ROW EXECUTE FUNCTION ristak_payment_list_contact_trigger();

CREATE OR REPLACE FUNCTION ristak_bump_transaction_revision_for_contact_phone()
RETURNS TRIGGER AS $$
DECLARE
  old_contact_id TEXT := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.contact_id END;
  new_contact_id TEXT := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE NEW.contact_id END;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM payments
    WHERE contact_id = old_contact_id OR contact_id = new_contact_id
    LIMIT 1
  ) THEN
    UPDATE payment_list_revisions
    SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP
    WHERE scope = 'transactions';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_payment_list_contact_phone_revision ON contact_phone_numbers;
CREATE TRIGGER trg_payment_list_contact_phone_revision
AFTER INSERT OR DELETE OR UPDATE OF contact_id, phone ON contact_phone_numbers
FOR EACH ROW EXECUTE FUNCTION ristak_bump_transaction_revision_for_contact_phone();
