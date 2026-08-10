-- Un submission de Sites ligado a un contacto es evidencia determinista para
-- la proyección de conversiones. La función compartida encola las identidades
-- anterior y nueva sin hacer consultas históricas dentro del write path.
DROP TRIGGER IF EXISTS trg_tracking_conversion_site_submission_change
ON public_site_submissions;

CREATE TRIGGER trg_tracking_conversion_site_submission_change
AFTER INSERT OR DELETE OR UPDATE OF contact_id, created_at
ON public_site_submissions
FOR EACH ROW EXECUTE FUNCTION enqueue_tracking_conversion_related_change();
