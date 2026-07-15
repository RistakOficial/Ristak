CREATE TABLE IF NOT EXISTS contact_list_activity (
  contact_id TEXT PRIMARY KEY REFERENCES contacts(id) ON DELETE CASCADE,
  total_paid NUMERIC(30, 6) NOT NULL DEFAULT 0,
  payments_count BIGINT NOT NULL DEFAULT 0,
  purchases_count BIGINT NOT NULL DEFAULT 0,
  customer_payments_count BIGINT NOT NULL DEFAULT 0,
  failed_payments_count BIGINT NOT NULL DEFAULT 0,
  last_purchase_date TIMESTAMPTZ,
  last_purchase_sort TIMESTAMPTZ,
  last_purchase_payment_id TEXT,
  first_payment_date TIMESTAMPTZ,
  first_payment_sort TIMESTAMPTZ,
  first_payment_id TEXT,
  last_customer_payment_date TIMESTAMPTZ,
  last_customer_payment_sort TIMESTAMPTZ,
  last_customer_payment_id TEXT,
  appointments_count BIGINT NOT NULL DEFAULT 0,
  active_appointments_count BIGINT NOT NULL DEFAULT 0,
  attended_appointments_count BIGINT NOT NULL DEFAULT 0,
  last_appointment_date TIMESTAMPTZ,
  last_appointment_sort TIMESTAMPTZ,
  last_appointment_id TEXT,
  attendance_signals_count BIGINT NOT NULL DEFAULT 0,
  priority INTEGER NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS contact_payment_activity_items (
  payment_id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL,
  total_paid_contribution NUMERIC(30, 6) NOT NULL DEFAULT 0,
  payments_count_contribution INTEGER NOT NULL DEFAULT 0,
  purchases_count_contribution INTEGER NOT NULL DEFAULT 0,
  customer_payments_count_contribution INTEGER NOT NULL DEFAULT 0,
  failed_payments_count_contribution INTEGER NOT NULL DEFAULT 0,
  purchase_date TIMESTAMPTZ,
  purchase_sort TIMESTAMPTZ,
  first_payment_date TIMESTAMPTZ,
  first_payment_sort TIMESTAMPTZ,
  customer_payment_date TIMESTAMPTZ,
  customer_payment_sort TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS contact_appointment_activity_items (
  appointment_id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL,
  active_contribution INTEGER NOT NULL DEFAULT 0,
  attended_contribution INTEGER NOT NULL DEFAULT 0,
  appointment_date TIMESTAMPTZ,
  appointment_sort TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS contact_attendance_activity_items (
  signal_id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS payment_list_activity (
  payment_id TEXT PRIMARY KEY,
  contact_id TEXT,
  date_sort NUMERIC(30, 9) NOT NULL DEFAULT 0,
  date_cursor TEXT NOT NULL DEFAULT '0',
  created_sort NUMERIC(30, 9) NOT NULL DEFAULT 0,
  created_cursor TEXT NOT NULL DEFAULT '0',
  amount_sort NUMERIC(30, 6) NOT NULL DEFAULT 0,
  status_sort TEXT NOT NULL DEFAULT '',
  contact_name_sort TEXT NOT NULL DEFAULT '',
  contact_email_sort TEXT NOT NULL DEFAULT '',
  method_sort TEXT NOT NULL DEFAULT '',
  provider_sort TEXT NOT NULL DEFAULT '',
  title_sort TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS crm_list_projection_state (
  projection_key TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'backfilling',
  processed_count BIGINT NOT NULL DEFAULT 0,
  generation BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO crm_list_projection_state (projection_key, status) VALUES ('contact_payments', 'backfilling')
ON CONFLICT (projection_key) DO NOTHING;
INSERT INTO crm_list_projection_state (projection_key, status) VALUES ('contact_appointments', 'backfilling')
ON CONFLICT (projection_key) DO NOTHING;
INSERT INTO crm_list_projection_state (projection_key, status) VALUES ('contact_attendance', 'backfilling')
ON CONFLICT (projection_key) DO NOTHING;
INSERT INTO crm_list_projection_state (projection_key, status) VALUES ('payment_list', 'backfilling')
ON CONFLICT (projection_key) DO NOTHING;
INSERT INTO payment_list_revisions (scope, revision) VALUES ('transactions', 0)
ON CONFLICT (scope) DO NOTHING;

CREATE OR REPLACE VIEW contact_payment_activity_source AS
SELECT
  p.id AS payment_id,
  p.contact_id,
  CASE WHEN p.amount > 0
    AND LOWER(COALESCE(p.status, '')) IN ('succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success')
    AND COALESCE(p.payment_mode, 'live') != 'test' THEN p.amount ELSE 0 END AS total_paid_contribution,
  CASE WHEN p.amount > 0 AND COALESCE(p.payment_mode, 'live') != 'test' THEN 1 ELSE 0 END AS payments_count_contribution,
  CASE WHEN p.amount > 0
    AND LOWER(COALESCE(p.status, '')) IN ('succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success')
    AND COALESCE(p.payment_mode, 'live') != 'test' THEN 1 ELSE 0 END AS purchases_count_contribution,
  CASE WHEN p.amount > 0
    AND LOWER(COALESCE(p.status, '')) IN ('succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success')
    THEN 1 ELSE 0 END AS customer_payments_count_contribution,
  CASE WHEN p.amount > 0
    AND LOWER(COALESCE(p.status, '')) IN ('failed', 'declined', 'rejected', 'canceled', 'cancelled', 'expired', 'void', 'voided', 'refunded', 'chargeback', 'disputed')
    AND COALESCE(p.payment_mode, 'live') != 'test' THEN 1 ELSE 0 END AS failed_payments_count_contribution,
  CASE WHEN p.amount > 0
    AND LOWER(COALESCE(p.status, '')) IN ('succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success')
    AND COALESCE(p.payment_mode, 'live') != 'test' THEN COALESCE(p.paid_at, p.date, p.created_at) END AS purchase_date,
  CASE WHEN p.amount > 0
    AND LOWER(COALESCE(p.status, '')) IN ('succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success')
    AND COALESCE(p.payment_mode, 'live') != 'test' THEN COALESCE(p.paid_at, p.date, p.created_at) END AS purchase_sort,
  CASE WHEN LOWER(COALESCE(p.status, '')) IN ('succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success')
    AND COALESCE(p.payment_mode, 'live') != 'test' THEN p.date END AS first_payment_date,
  CASE WHEN LOWER(COALESCE(p.status, '')) IN ('succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success')
    AND COALESCE(p.payment_mode, 'live') != 'test' THEN p.date END AS first_payment_sort,
  CASE WHEN p.amount > 0
    AND LOWER(COALESCE(p.status, '')) IN ('succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success')
    THEN COALESCE(p.paid_at, p.date, p.created_at) END AS customer_payment_date,
  CASE WHEN p.amount > 0
    AND LOWER(COALESCE(p.status, '')) IN ('succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success')
    THEN COALESCE(p.paid_at, p.date, p.created_at) END AS customer_payment_sort
FROM payments p
JOIN contacts projection_contact ON projection_contact.id = p.contact_id
WHERE p.contact_id IS NOT NULL AND p.contact_id != '';

CREATE OR REPLACE VIEW contact_appointment_activity_source AS
SELECT
  a.id AS appointment_id,
  a.contact_id,
  CASE WHEN LOWER(COALESCE(a.appointment_status, a.status, '')) NOT IN
    ('cancelled', 'canceled', 'no_show', 'noshow', 'invalid', 'failed', 'missed', 'deleted', 'void', 'voided')
    THEN 1 ELSE 0 END AS active_contribution,
  CASE WHEN LOWER(COALESCE(a.appointment_status, a.status, '')) IN
    ('showed', 'show', 'attended', 'completed', 'complete') THEN 1 ELSE 0 END AS attended_contribution,
  COALESCE(a.start_time, a.date_added, a.date_updated) AS appointment_date,
  COALESCE(a.start_time, a.date_added, a.date_updated) AS appointment_sort
FROM appointments a
JOIN contacts projection_contact ON projection_contact.id = a.contact_id
WHERE a.contact_id IS NOT NULL AND a.contact_id != '';

CREATE OR REPLACE VIEW contact_attendance_activity_source AS
SELECT signal.id AS signal_id, signal.contact_id
FROM appointment_attendance_signals signal
JOIN contacts projection_contact ON projection_contact.id = signal.contact_id
WHERE signal.contact_id IS NOT NULL AND signal.contact_id != '';

CREATE OR REPLACE VIEW payment_list_activity_source AS
SELECT
  p.id AS payment_id,
  p.contact_id,
  COALESCE(EXTRACT(EPOCH FROM p.date), 0) AS date_sort,
  COALESCE(EXTRACT(EPOCH FROM p.date), 0)::text AS date_cursor,
  COALESCE(EXTRACT(EPOCH FROM p.created_at), 0) AS created_sort,
  COALESCE(EXTRACT(EPOCH FROM p.created_at), 0)::text AS created_cursor,
  COALESCE(p.amount, 0) AS amount_sort,
  CASE WHEN LOWER(COALESCE(p.status, '')) IN ('succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success')
    THEN 'paid' ELSE LOWER(COALESCE(p.status, '')) END AS status_sort,
  LOWER(COALESCE(c.full_name, '')) AS contact_name_sort,
  LOWER(COALESCE(c.email, '')) AS contact_email_sort,
  LOWER(COALESCE(p.payment_method, '')) AS method_sort,
  LOWER(COALESCE(p.payment_provider, '')) AS provider_sort,
  LOWER(COALESCE(p.title, p.description, '')) AS title_sort
FROM payments p
LEFT JOIN contacts c ON c.id = p.contact_id;

CREATE OR REPLACE FUNCTION ristak_recalculate_contact_list_priority(target_contact_id TEXT)
RETURNS VOID AS $$
BEGIN
  UPDATE contact_list_activity SET priority = CASE
    WHEN customer_payments_count > 0 THEN 4
    WHEN attended_appointments_count > 0 OR attendance_signals_count > 0 THEN 3
    WHEN active_appointments_count > 0 THEN 2
    ELSE 1 END,
    updated_at = CURRENT_TIMESTAMP
  WHERE contact_id = target_contact_id;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ristak_contact_payment_item_summary_trigger()
RETURNS TRIGGER AS $$
DECLARE
  current_purchase_id TEXT;
  current_first_payment_id TEXT;
  current_customer_id TEXT;
  replacement_date TIMESTAMPTZ;
  replacement_sort TIMESTAMPTZ;
  replacement_id TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO contact_list_activity(contact_id) VALUES (NEW.contact_id) ON CONFLICT DO NOTHING;
    UPDATE contact_list_activity SET
      total_paid = total_paid + NEW.total_paid_contribution,
      payments_count = payments_count + NEW.payments_count_contribution,
      purchases_count = purchases_count + NEW.purchases_count_contribution,
      customer_payments_count = customer_payments_count + NEW.customer_payments_count_contribution,
      failed_payments_count = failed_payments_count + NEW.failed_payments_count_contribution,
      last_purchase_date = CASE WHEN NEW.purchase_sort IS NOT NULL AND
        (last_purchase_sort IS NULL OR (NEW.purchase_sort, NEW.payment_id) > (last_purchase_sort, COALESCE(last_purchase_payment_id, '')))
        THEN NEW.purchase_date ELSE last_purchase_date END,
      last_purchase_sort = CASE WHEN NEW.purchase_sort IS NOT NULL AND
        (last_purchase_sort IS NULL OR (NEW.purchase_sort, NEW.payment_id) > (last_purchase_sort, COALESCE(last_purchase_payment_id, '')))
        THEN NEW.purchase_sort ELSE last_purchase_sort END,
      last_purchase_payment_id = CASE WHEN NEW.purchase_sort IS NOT NULL AND
        (last_purchase_sort IS NULL OR (NEW.purchase_sort, NEW.payment_id) > (last_purchase_sort, COALESCE(last_purchase_payment_id, '')))
        THEN NEW.payment_id ELSE last_purchase_payment_id END,
      first_payment_date = CASE WHEN NEW.first_payment_sort IS NOT NULL AND
        (first_payment_sort IS NULL OR (NEW.first_payment_sort, NEW.payment_id) < (first_payment_sort, COALESCE(first_payment_id, NEW.payment_id)))
        THEN NEW.first_payment_date ELSE first_payment_date END,
      first_payment_sort = CASE WHEN NEW.first_payment_sort IS NOT NULL AND
        (first_payment_sort IS NULL OR (NEW.first_payment_sort, NEW.payment_id) < (first_payment_sort, COALESCE(first_payment_id, NEW.payment_id)))
        THEN NEW.first_payment_sort ELSE first_payment_sort END,
      first_payment_id = CASE WHEN NEW.first_payment_sort IS NOT NULL AND
        (first_payment_sort IS NULL OR (NEW.first_payment_sort, NEW.payment_id) < (first_payment_sort, COALESCE(first_payment_id, NEW.payment_id)))
        THEN NEW.payment_id ELSE first_payment_id END,
      last_customer_payment_date = CASE WHEN NEW.customer_payment_sort IS NOT NULL AND
        (last_customer_payment_sort IS NULL OR (NEW.customer_payment_sort, NEW.payment_id) > (last_customer_payment_sort, COALESCE(last_customer_payment_id, '')))
        THEN NEW.customer_payment_date ELSE last_customer_payment_date END,
      last_customer_payment_sort = CASE WHEN NEW.customer_payment_sort IS NOT NULL AND
        (last_customer_payment_sort IS NULL OR (NEW.customer_payment_sort, NEW.payment_id) > (last_customer_payment_sort, COALESCE(last_customer_payment_id, '')))
        THEN NEW.customer_payment_sort ELSE last_customer_payment_sort END,
      last_customer_payment_id = CASE WHEN NEW.customer_payment_sort IS NOT NULL AND
        (last_customer_payment_sort IS NULL OR (NEW.customer_payment_sort, NEW.payment_id) > (last_customer_payment_sort, COALESCE(last_customer_payment_id, '')))
        THEN NEW.payment_id ELSE last_customer_payment_id END,
      updated_at = CURRENT_TIMESTAMP
    WHERE contact_id = NEW.contact_id;
    PERFORM ristak_recalculate_contact_list_priority(NEW.contact_id);
    RETURN NULL;
  END IF;

  SELECT last_purchase_payment_id, first_payment_id, last_customer_payment_id
  INTO current_purchase_id, current_first_payment_id, current_customer_id
  FROM contact_list_activity WHERE contact_id = OLD.contact_id FOR UPDATE;
  UPDATE contact_list_activity SET
    total_paid = GREATEST(0, total_paid - OLD.total_paid_contribution),
    payments_count = GREATEST(0, payments_count - OLD.payments_count_contribution),
    purchases_count = GREATEST(0, purchases_count - OLD.purchases_count_contribution),
    customer_payments_count = GREATEST(0, customer_payments_count - OLD.customer_payments_count_contribution),
    failed_payments_count = GREATEST(0, failed_payments_count - OLD.failed_payments_count_contribution),
    updated_at = CURRENT_TIMESTAMP
  WHERE contact_id = OLD.contact_id;
  IF current_purchase_id = OLD.payment_id THEN
    SELECT purchase_date, purchase_sort, payment_id INTO replacement_date, replacement_sort, replacement_id
    FROM contact_payment_activity_items WHERE contact_id = OLD.contact_id AND payment_id != OLD.payment_id AND purchase_sort IS NOT NULL
    ORDER BY purchase_sort DESC, payment_id DESC LIMIT 1;
    UPDATE contact_list_activity SET last_purchase_date = replacement_date,
      last_purchase_sort = replacement_sort, last_purchase_payment_id = replacement_id
    WHERE contact_id = OLD.contact_id;
  END IF;
  IF current_first_payment_id = OLD.payment_id THEN
    replacement_date := NULL; replacement_sort := NULL; replacement_id := NULL;
    SELECT first_payment_date, first_payment_sort, payment_id INTO replacement_date, replacement_sort, replacement_id
    FROM contact_payment_activity_items WHERE contact_id = OLD.contact_id AND payment_id != OLD.payment_id AND first_payment_sort IS NOT NULL
    ORDER BY first_payment_sort ASC, payment_id ASC LIMIT 1;
    UPDATE contact_list_activity SET first_payment_date = replacement_date,
      first_payment_sort = replacement_sort, first_payment_id = replacement_id
    WHERE contact_id = OLD.contact_id;
  END IF;
  IF current_customer_id = OLD.payment_id THEN
    replacement_date := NULL; replacement_sort := NULL; replacement_id := NULL;
    SELECT customer_payment_date, customer_payment_sort, payment_id INTO replacement_date, replacement_sort, replacement_id
    FROM contact_payment_activity_items WHERE contact_id = OLD.contact_id AND payment_id != OLD.payment_id AND customer_payment_sort IS NOT NULL
    ORDER BY customer_payment_sort DESC, payment_id DESC LIMIT 1;
    UPDATE contact_list_activity SET last_customer_payment_date = replacement_date,
      last_customer_payment_sort = replacement_sort, last_customer_payment_id = replacement_id
    WHERE contact_id = OLD.contact_id;
  END IF;
  PERFORM ristak_recalculate_contact_list_priority(OLD.contact_id);
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_contact_payment_item_insert ON contact_payment_activity_items;
DROP TRIGGER IF EXISTS trg_contact_payment_item_delete ON contact_payment_activity_items;
CREATE TRIGGER trg_contact_payment_item_insert AFTER INSERT ON contact_payment_activity_items
FOR EACH ROW EXECUTE FUNCTION ristak_contact_payment_item_summary_trigger();
CREATE TRIGGER trg_contact_payment_item_delete BEFORE DELETE ON contact_payment_activity_items
FOR EACH ROW EXECUTE FUNCTION ristak_contact_payment_item_summary_trigger();

CREATE OR REPLACE FUNCTION ristak_contact_payment_source_trigger()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM contact_payment_activity_items WHERE payment_id = OLD.id;
    UPDATE crm_list_projection_state SET generation = generation + 1, updated_at = CURRENT_TIMESTAMP
    WHERE projection_key = 'contact_payments' AND status != 'ready';
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' THEN DELETE FROM contact_payment_activity_items WHERE payment_id = NEW.id; END IF;
  INSERT INTO contact_payment_activity_items SELECT * FROM contact_payment_activity_source WHERE payment_id = NEW.id
  ON CONFLICT (payment_id) DO NOTHING;
  UPDATE crm_list_projection_state SET generation = generation + 1, updated_at = CURRENT_TIMESTAMP
  WHERE projection_key = 'contact_payments' AND status != 'ready';
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_contact_payment_source ON payments;
CREATE TRIGGER trg_contact_payment_source
AFTER INSERT OR DELETE OR UPDATE OF contact_id, amount, status, payment_mode, paid_at, date, created_at ON payments
FOR EACH ROW EXECUTE FUNCTION ristak_contact_payment_source_trigger();

CREATE OR REPLACE FUNCTION ristak_contact_appointment_item_summary_trigger()
RETURNS TRIGGER AS $$
DECLARE
  current_last_id TEXT;
  replacement_date TIMESTAMPTZ;
  replacement_sort TIMESTAMPTZ;
  replacement_id TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO contact_list_activity(contact_id) VALUES (NEW.contact_id) ON CONFLICT DO NOTHING;
    UPDATE contact_list_activity SET appointments_count = appointments_count + 1,
      active_appointments_count = active_appointments_count + NEW.active_contribution,
      attended_appointments_count = attended_appointments_count + NEW.attended_contribution,
      last_appointment_date = CASE WHEN last_appointment_sort IS NULL OR
        (NEW.appointment_sort, NEW.appointment_id) > (last_appointment_sort, COALESCE(last_appointment_id, ''))
        THEN NEW.appointment_date ELSE last_appointment_date END,
      last_appointment_sort = CASE WHEN last_appointment_sort IS NULL OR
        (NEW.appointment_sort, NEW.appointment_id) > (last_appointment_sort, COALESCE(last_appointment_id, ''))
        THEN NEW.appointment_sort ELSE last_appointment_sort END,
      last_appointment_id = CASE WHEN last_appointment_sort IS NULL OR
        (NEW.appointment_sort, NEW.appointment_id) > (last_appointment_sort, COALESCE(last_appointment_id, ''))
        THEN NEW.appointment_id ELSE last_appointment_id END,
      updated_at = CURRENT_TIMESTAMP WHERE contact_id = NEW.contact_id;
    PERFORM ristak_recalculate_contact_list_priority(NEW.contact_id);
    RETURN NULL;
  END IF;
  SELECT last_appointment_id INTO current_last_id FROM contact_list_activity WHERE contact_id = OLD.contact_id FOR UPDATE;
  UPDATE contact_list_activity SET appointments_count = GREATEST(0, appointments_count - 1),
    active_appointments_count = GREATEST(0, active_appointments_count - OLD.active_contribution),
    attended_appointments_count = GREATEST(0, attended_appointments_count - OLD.attended_contribution),
    updated_at = CURRENT_TIMESTAMP WHERE contact_id = OLD.contact_id;
  IF current_last_id = OLD.appointment_id THEN
    SELECT appointment_date, appointment_sort, appointment_id INTO replacement_date, replacement_sort, replacement_id
    FROM contact_appointment_activity_items WHERE contact_id = OLD.contact_id AND appointment_id != OLD.appointment_id
    ORDER BY appointment_sort DESC, appointment_id DESC LIMIT 1;
    UPDATE contact_list_activity SET last_appointment_date = replacement_date,
      last_appointment_sort = replacement_sort, last_appointment_id = replacement_id WHERE contact_id = OLD.contact_id;
  END IF;
  PERFORM ristak_recalculate_contact_list_priority(OLD.contact_id);
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_contact_appointment_item_insert ON contact_appointment_activity_items;
DROP TRIGGER IF EXISTS trg_contact_appointment_item_delete ON contact_appointment_activity_items;
CREATE TRIGGER trg_contact_appointment_item_insert AFTER INSERT ON contact_appointment_activity_items
FOR EACH ROW EXECUTE FUNCTION ristak_contact_appointment_item_summary_trigger();
CREATE TRIGGER trg_contact_appointment_item_delete BEFORE DELETE ON contact_appointment_activity_items
FOR EACH ROW EXECUTE FUNCTION ristak_contact_appointment_item_summary_trigger();

CREATE OR REPLACE FUNCTION ristak_contact_appointment_source_trigger()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM contact_appointment_activity_items WHERE appointment_id = OLD.id;
    UPDATE crm_list_projection_state SET generation = generation + 1, updated_at = CURRENT_TIMESTAMP
    WHERE projection_key = 'contact_appointments' AND status != 'ready';
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN DELETE FROM contact_appointment_activity_items WHERE appointment_id = NEW.id; END IF;
  INSERT INTO contact_appointment_activity_items SELECT * FROM contact_appointment_activity_source WHERE appointment_id = NEW.id
  ON CONFLICT (appointment_id) DO NOTHING;
  UPDATE crm_list_projection_state SET generation = generation + 1, updated_at = CURRENT_TIMESTAMP
  WHERE projection_key = 'contact_appointments' AND status != 'ready';
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_contact_appointment_source ON appointments;
CREATE TRIGGER trg_contact_appointment_source
AFTER INSERT OR DELETE OR UPDATE OF contact_id, appointment_status, status, start_time, date_added, date_updated ON appointments
FOR EACH ROW EXECUTE FUNCTION ristak_contact_appointment_source_trigger();

CREATE OR REPLACE FUNCTION ristak_contact_attendance_item_trigger()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    UPDATE contact_list_activity SET attendance_signals_count = GREATEST(0, attendance_signals_count - 1)
    WHERE contact_id = OLD.contact_id;
    PERFORM ristak_recalculate_contact_list_priority(OLD.contact_id);
    RETURN OLD;
  ELSE
    INSERT INTO contact_list_activity(contact_id) VALUES (NEW.contact_id) ON CONFLICT DO NOTHING;
    UPDATE contact_list_activity SET attendance_signals_count = attendance_signals_count + 1 WHERE contact_id = NEW.contact_id;
    PERFORM ristak_recalculate_contact_list_priority(NEW.contact_id);
    RETURN NULL;
  END IF;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_contact_attendance_item_insert ON contact_attendance_activity_items;
DROP TRIGGER IF EXISTS trg_contact_attendance_item_delete ON contact_attendance_activity_items;
CREATE TRIGGER trg_contact_attendance_item_insert AFTER INSERT ON contact_attendance_activity_items
FOR EACH ROW EXECUTE FUNCTION ristak_contact_attendance_item_trigger();
CREATE TRIGGER trg_contact_attendance_item_delete BEFORE DELETE ON contact_attendance_activity_items
FOR EACH ROW EXECUTE FUNCTION ristak_contact_attendance_item_trigger();

CREATE OR REPLACE FUNCTION ristak_contact_attendance_source_trigger()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM contact_attendance_activity_items WHERE signal_id = OLD.id;
    UPDATE crm_list_projection_state SET generation = generation + 1, updated_at = CURRENT_TIMESTAMP
    WHERE projection_key = 'contact_attendance' AND status != 'ready';
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' THEN DELETE FROM contact_attendance_activity_items WHERE signal_id = NEW.id; END IF;
  INSERT INTO contact_attendance_activity_items SELECT * FROM contact_attendance_activity_source WHERE signal_id = NEW.id
  ON CONFLICT (signal_id) DO NOTHING;
  UPDATE crm_list_projection_state SET generation = generation + 1, updated_at = CURRENT_TIMESTAMP
  WHERE projection_key = 'contact_attendance' AND status != 'ready';
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_contact_attendance_signal ON appointment_attendance_signals;
CREATE TRIGGER trg_contact_attendance_signal AFTER INSERT OR DELETE OR UPDATE OF contact_id ON appointment_attendance_signals
FOR EACH ROW EXECUTE FUNCTION ristak_contact_attendance_source_trigger();

CREATE OR REPLACE FUNCTION ristak_payment_list_source_trigger()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM payment_list_activity WHERE payment_id = OLD.id;
    UPDATE crm_list_projection_state SET generation = generation + 1, updated_at = CURRENT_TIMESTAMP
    WHERE projection_key = 'payment_list' AND status != 'ready';
    RETURN NULL;
  END IF;
  INSERT INTO payment_list_activity SELECT source.*, CURRENT_TIMESTAMP FROM payment_list_activity_source source WHERE payment_id = NEW.id
  ON CONFLICT (payment_id) DO UPDATE SET
    contact_id = EXCLUDED.contact_id, date_sort = EXCLUDED.date_sort, date_cursor = EXCLUDED.date_cursor,
    created_sort = EXCLUDED.created_sort, created_cursor = EXCLUDED.created_cursor,
    amount_sort = EXCLUDED.amount_sort, status_sort = EXCLUDED.status_sort,
    contact_name_sort = EXCLUDED.contact_name_sort, contact_email_sort = EXCLUDED.contact_email_sort,
    method_sort = EXCLUDED.method_sort, provider_sort = EXCLUDED.provider_sort,
    title_sort = EXCLUDED.title_sort, updated_at = EXCLUDED.updated_at;
  UPDATE crm_list_projection_state SET generation = generation + 1, updated_at = CURRENT_TIMESTAMP
  WHERE projection_key = 'payment_list' AND status != 'ready';
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_payment_list_source ON payments;
CREATE TRIGGER trg_payment_list_source
AFTER INSERT OR DELETE OR UPDATE OF contact_id, date, created_at, amount, status, payment_method, payment_provider, title, description ON payments
FOR EACH ROW EXECUTE FUNCTION ristak_payment_list_source_trigger();

CREATE OR REPLACE FUNCTION ristak_payment_list_contact_trigger()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE payment_list_activity SET contact_name_sort = LOWER(COALESCE(NEW.full_name, '')),
    contact_email_sort = LOWER(COALESCE(NEW.email, '')), updated_at = CURRENT_TIMESTAMP
  WHERE contact_id = NEW.id;
  UPDATE crm_list_projection_state SET generation = generation + 1, updated_at = CURRENT_TIMESTAMP
  WHERE projection_key = 'payment_list' AND status != 'ready';
  UPDATE payment_list_revisions SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP
  WHERE scope = 'transactions' AND EXISTS (
    SELECT 1 FROM payment_list_activity WHERE contact_id = NEW.id LIMIT 1
  );
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_payment_list_contact_update ON contacts;
CREATE TRIGGER trg_payment_list_contact_update AFTER UPDATE OF full_name, email ON contacts
FOR EACH ROW EXECUTE FUNCTION ristak_payment_list_contact_trigger();

-- Las integraciones pueden crear pagos/citas antes que el contacto. Este hook
-- reconcilia únicamente ese ID al insertarlo y limpia sus ledgers antes de un
-- DELETE para impedir que un ID reutilizado herede actividad anterior. Los
-- pagos huérfanos permanecen en payment_list_activity deliberadamente.
CREATE OR REPLACE FUNCTION ristak_crm_projection_contact_lifecycle_trigger()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM contact_payment_activity_items WHERE contact_id = OLD.id;
    DELETE FROM contact_appointment_activity_items WHERE contact_id = OLD.id;
    DELETE FROM contact_attendance_activity_items WHERE contact_id = OLD.id;
    UPDATE payment_list_activity
    SET contact_name_sort = '', contact_email_sort = '', updated_at = CURRENT_TIMESTAMP
    WHERE contact_id = OLD.id;
    UPDATE crm_list_projection_state SET generation = generation + 1, updated_at = CURRENT_TIMESTAMP
    WHERE projection_key IN ('contact_payments', 'contact_appointments', 'contact_attendance', 'payment_list')
    AND status != 'ready';
    UPDATE payment_list_revisions SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP
    WHERE scope = 'transactions' AND EXISTS (
      SELECT 1 FROM payment_list_activity WHERE contact_id = OLD.id LIMIT 1
    );
    RETURN OLD;
  END IF;

  INSERT INTO contact_payment_activity_items
  SELECT * FROM contact_payment_activity_source WHERE contact_id = NEW.id
  ON CONFLICT (payment_id) DO NOTHING;
  INSERT INTO contact_appointment_activity_items
  SELECT * FROM contact_appointment_activity_source WHERE contact_id = NEW.id
  ON CONFLICT (appointment_id) DO NOTHING;
  INSERT INTO contact_attendance_activity_items
  SELECT * FROM contact_attendance_activity_source WHERE contact_id = NEW.id
  ON CONFLICT (signal_id) DO NOTHING;
  UPDATE payment_list_activity
  SET contact_name_sort = LOWER(COALESCE(NEW.full_name, '')),
      contact_email_sort = LOWER(COALESCE(NEW.email, '')),
      updated_at = CURRENT_TIMESTAMP
  WHERE contact_id = NEW.id;
  UPDATE crm_list_projection_state SET generation = generation + 1, updated_at = CURRENT_TIMESTAMP
  WHERE projection_key IN ('contact_payments', 'contact_appointments', 'contact_attendance', 'payment_list')
    AND status != 'ready';
  UPDATE payment_list_revisions SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP
  WHERE scope = 'transactions' AND EXISTS (
    SELECT 1 FROM payment_list_activity WHERE contact_id = NEW.id LIMIT 1
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_crm_projection_contact_insert ON contacts;
DROP TRIGGER IF EXISTS trg_crm_projection_contact_delete ON contacts;
CREATE TRIGGER trg_crm_projection_contact_insert AFTER INSERT ON contacts
FOR EACH ROW EXECUTE FUNCTION ristak_crm_projection_contact_lifecycle_trigger();
CREATE TRIGGER trg_crm_projection_contact_delete BEFORE DELETE ON contacts
FOR EACH ROW EXECUTE FUNCTION ristak_crm_projection_contact_lifecycle_trigger();

DROP TRIGGER IF EXISTS trg_payment_list_transactions ON payments;
CREATE TRIGGER trg_payment_list_transactions AFTER INSERT OR UPDATE OR DELETE ON payments
FOR EACH STATEMENT EXECUTE FUNCTION ristak_bump_payment_list_revision('transactions');
