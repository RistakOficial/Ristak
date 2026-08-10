-- Un submission de Sites ligado a un contacto es evidencia determinista para
-- la proyección de conversiones. Encolar el vínculo mantiene el read model
-- correcto aunque el navegador no haya conservado visitor_id/session_id.
DROP TRIGGER IF EXISTS trg_tracking_conversion_site_submission_insert;
CREATE TRIGGER trg_tracking_conversion_site_submission_insert
AFTER INSERT ON public_site_submissions
WHEN NEW.contact_id IS NOT NULL AND NEW.contact_id != ''
BEGIN
  INSERT INTO tracking_conversion_change_queue(contact_id, revision, enqueued_at)
  VALUES (NEW.contact_id, 1, CURRENT_TIMESTAMP)
  ON CONFLICT(contact_id) DO UPDATE SET
    revision = tracking_conversion_change_queue.revision + 1,
    enqueued_at = CURRENT_TIMESTAMP;
END;

DROP TRIGGER IF EXISTS trg_tracking_conversion_site_submission_update;
CREATE TRIGGER trg_tracking_conversion_site_submission_update
AFTER UPDATE OF contact_id, created_at ON public_site_submissions
WHEN NEW.contact_id IS NOT OLD.contact_id OR NEW.created_at IS NOT OLD.created_at
BEGIN
  INSERT INTO tracking_conversion_change_queue(contact_id, revision, enqueued_at)
  SELECT OLD.contact_id, 1, CURRENT_TIMESTAMP
  WHERE OLD.contact_id IS NOT NULL AND OLD.contact_id != ''
  ON CONFLICT(contact_id) DO UPDATE SET
    revision = tracking_conversion_change_queue.revision + 1,
    enqueued_at = CURRENT_TIMESTAMP;

  INSERT INTO tracking_conversion_change_queue(contact_id, revision, enqueued_at)
  SELECT NEW.contact_id, 1, CURRENT_TIMESTAMP
  WHERE NEW.contact_id IS NOT NULL AND NEW.contact_id != ''
  ON CONFLICT(contact_id) DO UPDATE SET
    revision = tracking_conversion_change_queue.revision + 1,
    enqueued_at = CURRENT_TIMESTAMP;
END;

DROP TRIGGER IF EXISTS trg_tracking_conversion_site_submission_delete;
CREATE TRIGGER trg_tracking_conversion_site_submission_delete
AFTER DELETE ON public_site_submissions
WHEN OLD.contact_id IS NOT NULL AND OLD.contact_id != ''
BEGIN
  INSERT INTO tracking_conversion_change_queue(contact_id, revision, enqueued_at)
  VALUES (OLD.contact_id, 1, CURRENT_TIMESTAMP)
  ON CONFLICT(contact_id) DO UPDATE SET
    revision = tracking_conversion_change_queue.revision + 1,
    enqueued_at = CURRENT_TIMESTAMP;
END;
