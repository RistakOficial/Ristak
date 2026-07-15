-- Una fila angosta por contacto permite que los ordenamientos de actividad
-- recorran directamente idx_contact_list_activity_* en vez de ordenar toda la
-- tabla contacts. El histórico se rellena en lotes por el worker, no aquí.
INSERT OR IGNORE INTO crm_list_projection_state (projection_key, status)
VALUES ('contact_rows', 'backfilling');

DROP TRIGGER IF EXISTS trg_contact_list_activity_contact_insert;
CREATE TRIGGER trg_contact_list_activity_contact_insert
AFTER INSERT ON contacts BEGIN
  INSERT OR IGNORE INTO contact_list_activity(contact_id) VALUES (NEW.id);
  UPDATE crm_list_projection_state
  SET generation = generation + 1, updated_at = CURRENT_TIMESTAMP
  WHERE projection_key = 'contact_rows' AND status != 'ready';
END;
