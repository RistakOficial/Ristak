-- Deploy O(1): sólo registra estado y trigger. El backfill histórico es
-- keyset/batched y corre fuera del arranque para no bloquear producción.
INSERT INTO crm_list_projection_state (projection_key, status)
VALUES ('contact_rows', 'backfilling')
ON CONFLICT (projection_key) DO NOTHING;

CREATE OR REPLACE FUNCTION ristak_contact_list_activity_contact_insert()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO contact_list_activity(contact_id) VALUES (NEW.id)
  ON CONFLICT (contact_id) DO NOTHING;
  UPDATE crm_list_projection_state
  SET generation = generation + 1, updated_at = CURRENT_TIMESTAMP
  WHERE projection_key = 'contact_rows' AND status != 'ready';
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_contact_list_activity_contact_insert ON contacts;
CREATE TRIGGER trg_contact_list_activity_contact_insert
AFTER INSERT ON contacts
FOR EACH ROW EXECUTE FUNCTION ristak_contact_list_activity_contact_insert();
