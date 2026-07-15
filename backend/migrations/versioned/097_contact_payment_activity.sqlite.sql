CREATE TABLE IF NOT EXISTS contact_list_activity (
  contact_id TEXT PRIMARY KEY,
  total_paid REAL NOT NULL DEFAULT 0,
  payments_count INTEGER NOT NULL DEFAULT 0,
  purchases_count INTEGER NOT NULL DEFAULT 0,
  customer_payments_count INTEGER NOT NULL DEFAULT 0,
  failed_payments_count INTEGER NOT NULL DEFAULT 0,
  last_purchase_date TEXT,
  last_purchase_sort REAL,
  last_purchase_payment_id TEXT,
  first_payment_date TEXT,
  first_payment_sort REAL,
  first_payment_id TEXT,
  last_customer_payment_date TEXT,
  last_customer_payment_sort REAL,
  last_customer_payment_id TEXT,
  appointments_count INTEGER NOT NULL DEFAULT 0,
  active_appointments_count INTEGER NOT NULL DEFAULT 0,
  attended_appointments_count INTEGER NOT NULL DEFAULT 0,
  last_appointment_date TEXT,
  last_appointment_sort REAL,
  last_appointment_id TEXT,
  attendance_signals_count INTEGER NOT NULL DEFAULT 0,
  priority INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS contact_payment_activity_items (
  payment_id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL,
  total_paid_contribution REAL NOT NULL DEFAULT 0,
  payments_count_contribution INTEGER NOT NULL DEFAULT 0,
  purchases_count_contribution INTEGER NOT NULL DEFAULT 0,
  customer_payments_count_contribution INTEGER NOT NULL DEFAULT 0,
  failed_payments_count_contribution INTEGER NOT NULL DEFAULT 0,
  purchase_date TEXT,
  purchase_sort REAL,
  first_payment_date TEXT,
  first_payment_sort REAL,
  customer_payment_date TEXT,
  customer_payment_sort REAL
);

CREATE TABLE IF NOT EXISTS contact_appointment_activity_items (
  appointment_id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL,
  active_contribution INTEGER NOT NULL DEFAULT 0,
  attended_contribution INTEGER NOT NULL DEFAULT 0,
  appointment_date TEXT,
  appointment_sort REAL
);

CREATE TABLE IF NOT EXISTS contact_attendance_activity_items (
  signal_id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS payment_list_activity (
  payment_id TEXT PRIMARY KEY,
  contact_id TEXT,
  date_sort REAL NOT NULL DEFAULT 0,
  date_cursor TEXT NOT NULL DEFAULT '0',
  created_sort REAL NOT NULL DEFAULT 0,
  created_cursor TEXT NOT NULL DEFAULT '0',
  amount_sort REAL NOT NULL DEFAULT 0,
  status_sort TEXT NOT NULL DEFAULT '',
  contact_name_sort TEXT NOT NULL DEFAULT '',
  contact_email_sort TEXT NOT NULL DEFAULT '',
  method_sort TEXT NOT NULL DEFAULT '',
  provider_sort TEXT NOT NULL DEFAULT '',
  title_sort TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS crm_list_projection_state (
  projection_key TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'backfilling',
  processed_count INTEGER NOT NULL DEFAULT 0,
  generation INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO crm_list_projection_state (projection_key, status)
VALUES ('contact_payments', 'backfilling');
INSERT OR IGNORE INTO crm_list_projection_state (projection_key, status)
VALUES ('contact_appointments', 'backfilling');
INSERT OR IGNORE INTO crm_list_projection_state (projection_key, status)
VALUES ('contact_attendance', 'backfilling');
INSERT OR IGNORE INTO crm_list_projection_state (projection_key, status)
VALUES ('payment_list', 'backfilling');
INSERT OR IGNORE INTO payment_list_revisions (scope, revision)
VALUES ('transactions', 0);

DROP VIEW IF EXISTS contact_payment_activity_source;
CREATE VIEW contact_payment_activity_source AS
SELECT
  p.id AS payment_id,
  p.contact_id,
  CASE WHEN p.amount > 0
    AND LOWER(COALESCE(p.status, '')) IN ('succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success')
    AND COALESCE(p.payment_mode, 'live') != 'test'
    THEN p.amount ELSE 0 END AS total_paid_contribution,
  CASE WHEN p.amount > 0 AND COALESCE(p.payment_mode, 'live') != 'test' THEN 1 ELSE 0 END AS payments_count_contribution,
  CASE WHEN p.amount > 0
    AND LOWER(COALESCE(p.status, '')) IN ('succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success')
    AND COALESCE(p.payment_mode, 'live') != 'test'
    THEN 1 ELSE 0 END AS purchases_count_contribution,
  CASE WHEN p.amount > 0
    AND LOWER(COALESCE(p.status, '')) IN ('succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success')
    THEN 1 ELSE 0 END AS customer_payments_count_contribution,
  CASE WHEN p.amount > 0
    AND LOWER(COALESCE(p.status, '')) IN ('failed', 'declined', 'rejected', 'canceled', 'cancelled', 'expired', 'void', 'voided', 'refunded', 'chargeback', 'disputed')
    AND COALESCE(p.payment_mode, 'live') != 'test'
    THEN 1 ELSE 0 END AS failed_payments_count_contribution,
  CASE WHEN p.amount > 0
    AND LOWER(COALESCE(p.status, '')) IN ('succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success')
    AND COALESCE(p.payment_mode, 'live') != 'test'
    THEN COALESCE(p.paid_at, p.date, p.created_at) END AS purchase_date,
  CASE WHEN p.amount > 0
    AND LOWER(COALESCE(p.status, '')) IN ('succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success')
    AND COALESCE(p.payment_mode, 'live') != 'test'
    THEN COALESCE(julianday(p.paid_at), julianday(p.date), julianday(p.created_at), 0) END AS purchase_sort,
  CASE WHEN LOWER(COALESCE(p.status, '')) IN ('succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success')
    AND COALESCE(p.payment_mode, 'live') != 'test'
    THEN p.date END AS first_payment_date,
  CASE WHEN LOWER(COALESCE(p.status, '')) IN ('succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success')
    AND COALESCE(p.payment_mode, 'live') != 'test'
    THEN julianday(p.date) END AS first_payment_sort,
  CASE WHEN p.amount > 0
    AND LOWER(COALESCE(p.status, '')) IN ('succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success')
    THEN COALESCE(p.paid_at, p.date, p.created_at) END AS customer_payment_date,
  CASE WHEN p.amount > 0
    AND LOWER(COALESCE(p.status, '')) IN ('succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success')
    THEN COALESCE(julianday(p.paid_at), julianday(p.date), julianday(p.created_at), 0) END AS customer_payment_sort
FROM payments p
JOIN contacts projection_contact ON projection_contact.id = p.contact_id
WHERE p.contact_id IS NOT NULL AND p.contact_id != '';

DROP VIEW IF EXISTS contact_appointment_activity_source;
CREATE VIEW contact_appointment_activity_source AS
SELECT
  a.id AS appointment_id,
  a.contact_id,
  CASE WHEN LOWER(COALESCE(a.appointment_status, a.status, '')) NOT IN
    ('cancelled', 'canceled', 'no_show', 'noshow', 'invalid', 'failed', 'missed', 'deleted', 'void', 'voided')
    THEN 1 ELSE 0 END AS active_contribution,
  CASE WHEN LOWER(COALESCE(a.appointment_status, a.status, '')) IN
    ('showed', 'show', 'attended', 'completed', 'complete')
    THEN 1 ELSE 0 END AS attended_contribution,
  COALESCE(a.start_time, a.date_added, a.date_updated) AS appointment_date,
  COALESCE(julianday(a.start_time), julianday(a.date_added), julianday(a.date_updated), 0) AS appointment_sort
FROM appointments a
JOIN contacts projection_contact ON projection_contact.id = a.contact_id
WHERE a.contact_id IS NOT NULL AND a.contact_id != '';

DROP VIEW IF EXISTS contact_attendance_activity_source;
CREATE VIEW contact_attendance_activity_source AS
SELECT signal.id AS signal_id, signal.contact_id
FROM appointment_attendance_signals signal
JOIN contacts projection_contact ON projection_contact.id = signal.contact_id
WHERE signal.contact_id IS NOT NULL AND signal.contact_id != '';

DROP VIEW IF EXISTS payment_list_activity_source;
CREATE VIEW payment_list_activity_source AS
SELECT
  p.id AS payment_id,
  p.contact_id,
  COALESCE(julianday(p.date), julianday(REPLACE(REPLACE(p.date, 'T', ' '), 'Z', '')), 0) AS date_sort,
  printf('%.17g', COALESCE(julianday(p.date), julianday(REPLACE(REPLACE(p.date, 'T', ' '), 'Z', '')), 0)) AS date_cursor,
  COALESCE(julianday(p.created_at), julianday(REPLACE(REPLACE(p.created_at, 'T', ' '), 'Z', '')), 0) AS created_sort,
  printf('%.17g', COALESCE(julianday(p.created_at), julianday(REPLACE(REPLACE(p.created_at, 'T', ' '), 'Z', '')), 0)) AS created_cursor,
  COALESCE(p.amount, 0) AS amount_sort,
  CASE
    WHEN LOWER(COALESCE(p.status, '')) IN ('succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success') THEN 'paid'
    ELSE LOWER(COALESCE(p.status, ''))
  END AS status_sort,
  LOWER(COALESCE(c.full_name, '')) AS contact_name_sort,
  LOWER(COALESCE(c.email, '')) AS contact_email_sort,
  LOWER(COALESCE(p.payment_method, '')) AS method_sort,
  LOWER(COALESCE(p.payment_provider, '')) AS provider_sort,
  LOWER(COALESCE(p.title, p.description, '')) AS title_sort
FROM payments p
LEFT JOIN contacts c ON c.id = p.contact_id;

CREATE INDEX IF NOT EXISTS idx_contact_payment_items_contact_purchase
  ON contact_payment_activity_items(contact_id, purchase_sort DESC, payment_id DESC)
  WHERE purchase_sort IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_contact_payment_items_contact_customer
  ON contact_payment_activity_items(contact_id, customer_payment_sort DESC, payment_id DESC)
  WHERE customer_payment_sort IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_contact_payment_items_contact_first
  ON contact_payment_activity_items(contact_id, first_payment_sort ASC, payment_id ASC)
  WHERE first_payment_sort IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_contact_payment_items_contact
  ON contact_payment_activity_items(contact_id, payment_id);
CREATE INDEX IF NOT EXISTS idx_contact_appointment_items_contact_date
  ON contact_appointment_activity_items(contact_id, appointment_sort DESC, appointment_id DESC);
CREATE INDEX IF NOT EXISTS idx_contact_attendance_items_contact
  ON contact_attendance_activity_items(contact_id, signal_id);
CREATE INDEX IF NOT EXISTS idx_contact_list_activity_priority
  ON contact_list_activity(priority, contact_id);
CREATE INDEX IF NOT EXISTS idx_contact_list_activity_total
  ON contact_list_activity(total_paid, contact_id);
CREATE INDEX IF NOT EXISTS idx_contact_list_activity_payments
  ON contact_list_activity(payments_count, contact_id);
CREATE INDEX IF NOT EXISTS idx_contact_list_activity_purchases
  ON contact_list_activity(purchases_count, contact_id);
CREATE INDEX IF NOT EXISTS idx_contact_list_activity_failed
  ON contact_list_activity(failed_payments_count, contact_id);
CREATE INDEX IF NOT EXISTS idx_contact_list_activity_last_purchase
  ON contact_list_activity(last_purchase_sort, contact_id);
CREATE INDEX IF NOT EXISTS idx_contact_list_activity_appointments
  ON contact_list_activity(appointments_count, contact_id);
CREATE INDEX IF NOT EXISTS idx_contact_list_activity_active_appointments
  ON contact_list_activity(active_appointments_count, contact_id);
CREATE INDEX IF NOT EXISTS idx_contact_list_activity_attended_appointments
  ON contact_list_activity(attended_appointments_count, contact_id);
CREATE INDEX IF NOT EXISTS idx_contact_list_activity_last_appointment
  ON contact_list_activity(last_appointment_sort, contact_id);

CREATE INDEX IF NOT EXISTS idx_payment_list_activity_date
  ON payment_list_activity(date_sort, created_sort, payment_id);
CREATE INDEX IF NOT EXISTS idx_payment_list_activity_created
  ON payment_list_activity(created_sort, payment_id);
CREATE INDEX IF NOT EXISTS idx_payment_list_activity_amount
  ON payment_list_activity(amount_sort, created_sort, payment_id);
CREATE INDEX IF NOT EXISTS idx_payment_list_activity_status
  ON payment_list_activity(status_sort, created_sort, payment_id);
CREATE INDEX IF NOT EXISTS idx_payment_list_activity_contact_name
  ON payment_list_activity(contact_name_sort, created_sort, payment_id);
CREATE INDEX IF NOT EXISTS idx_payment_list_activity_contact_email
  ON payment_list_activity(contact_email_sort, created_sort, payment_id);
CREATE INDEX IF NOT EXISTS idx_payment_list_activity_method
  ON payment_list_activity(method_sort, created_sort, payment_id);
CREATE INDEX IF NOT EXISTS idx_payment_list_activity_provider
  ON payment_list_activity(provider_sort, created_sort, payment_id);
CREATE INDEX IF NOT EXISTS idx_payment_list_activity_title
  ON payment_list_activity(title_sort, created_sort, payment_id);
CREATE INDEX IF NOT EXISTS idx_payment_list_activity_contact
  ON payment_list_activity(contact_id, payment_id);

CREATE INDEX IF NOT EXISTS idx_sessions_contact_first
  ON sessions(contact_id, started_at, created_at, id)
  WHERE contact_id IS NOT NULL AND contact_id != '';
CREATE INDEX IF NOT EXISTS idx_sessions_visitor_first
  ON sessions(visitor_id, started_at, created_at, id)
  WHERE visitor_id IS NOT NULL AND visitor_id != '';
CREATE INDEX IF NOT EXISTS idx_sessions_email_first
  ON sessions(LOWER(email), started_at, created_at, id)
  WHERE email IS NOT NULL AND email != '';
CREATE INDEX IF NOT EXISTS idx_contacts_cursor_created
  ON contacts(created_at, id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_contacts_cursor_updated
  ON contacts(updated_at, id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_contacts_cursor_name
  ON contacts(LOWER(COALESCE(full_name, '')), id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_contacts_cursor_email
  ON contacts(LOWER(COALESCE(email, '')), id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_contacts_cursor_phone
  ON contacts(COALESCE(phone, ''), id) WHERE deleted_at IS NULL;

DROP TRIGGER IF EXISTS trg_contact_payment_item_insert;
DROP TRIGGER IF EXISTS trg_contact_payment_item_delete;
DROP TRIGGER IF EXISTS trg_contact_payment_source_insert;
DROP TRIGGER IF EXISTS trg_contact_payment_source_update;
DROP TRIGGER IF EXISTS trg_contact_payment_source_delete;

CREATE TRIGGER trg_contact_payment_item_insert
AFTER INSERT ON contact_payment_activity_items
BEGIN
  INSERT OR IGNORE INTO contact_list_activity(contact_id) VALUES (NEW.contact_id);
  UPDATE contact_list_activity
  SET total_paid = total_paid + NEW.total_paid_contribution,
      payments_count = payments_count + NEW.payments_count_contribution,
      purchases_count = purchases_count + NEW.purchases_count_contribution,
      customer_payments_count = customer_payments_count + NEW.customer_payments_count_contribution,
      failed_payments_count = failed_payments_count + NEW.failed_payments_count_contribution,
      last_purchase_date = CASE WHEN NEW.purchase_sort IS NOT NULL AND (
        last_purchase_sort IS NULL OR NEW.purchase_sort > last_purchase_sort OR
        (NEW.purchase_sort = last_purchase_sort AND NEW.payment_id > COALESCE(last_purchase_payment_id, ''))
      ) THEN NEW.purchase_date ELSE last_purchase_date END,
      last_purchase_sort = CASE WHEN NEW.purchase_sort IS NOT NULL AND (
        last_purchase_sort IS NULL OR NEW.purchase_sort > last_purchase_sort OR
        (NEW.purchase_sort = last_purchase_sort AND NEW.payment_id > COALESCE(last_purchase_payment_id, ''))
      ) THEN NEW.purchase_sort ELSE last_purchase_sort END,
      last_purchase_payment_id = CASE WHEN NEW.purchase_sort IS NOT NULL AND (
        last_purchase_sort IS NULL OR NEW.purchase_sort > last_purchase_sort OR
        (NEW.purchase_sort = last_purchase_sort AND NEW.payment_id > COALESCE(last_purchase_payment_id, ''))
      ) THEN NEW.payment_id ELSE last_purchase_payment_id END,
      first_payment_date = CASE WHEN NEW.first_payment_sort IS NOT NULL AND (
        first_payment_sort IS NULL OR NEW.first_payment_sort < first_payment_sort OR
        (NEW.first_payment_sort = first_payment_sort AND NEW.payment_id < COALESCE(first_payment_id, NEW.payment_id))
      ) THEN NEW.first_payment_date ELSE first_payment_date END,
      first_payment_sort = CASE WHEN NEW.first_payment_sort IS NOT NULL AND (
        first_payment_sort IS NULL OR NEW.first_payment_sort < first_payment_sort OR
        (NEW.first_payment_sort = first_payment_sort AND NEW.payment_id < COALESCE(first_payment_id, NEW.payment_id))
      ) THEN NEW.first_payment_sort ELSE first_payment_sort END,
      first_payment_id = CASE WHEN NEW.first_payment_sort IS NOT NULL AND (
        first_payment_sort IS NULL OR NEW.first_payment_sort < first_payment_sort OR
        (NEW.first_payment_sort = first_payment_sort AND NEW.payment_id < COALESCE(first_payment_id, NEW.payment_id))
      ) THEN NEW.payment_id ELSE first_payment_id END,
      last_customer_payment_date = CASE WHEN NEW.customer_payment_sort IS NOT NULL AND (
        last_customer_payment_sort IS NULL OR NEW.customer_payment_sort > last_customer_payment_sort OR
        (NEW.customer_payment_sort = last_customer_payment_sort AND NEW.payment_id > COALESCE(last_customer_payment_id, ''))
      ) THEN NEW.customer_payment_date ELSE last_customer_payment_date END,
      last_customer_payment_sort = CASE WHEN NEW.customer_payment_sort IS NOT NULL AND (
        last_customer_payment_sort IS NULL OR NEW.customer_payment_sort > last_customer_payment_sort OR
        (NEW.customer_payment_sort = last_customer_payment_sort AND NEW.payment_id > COALESCE(last_customer_payment_id, ''))
      ) THEN NEW.customer_payment_sort ELSE last_customer_payment_sort END,
      last_customer_payment_id = CASE WHEN NEW.customer_payment_sort IS NOT NULL AND (
        last_customer_payment_sort IS NULL OR NEW.customer_payment_sort > last_customer_payment_sort OR
        (NEW.customer_payment_sort = last_customer_payment_sort AND NEW.payment_id > COALESCE(last_customer_payment_id, ''))
      ) THEN NEW.payment_id ELSE last_customer_payment_id END,
      updated_at = CURRENT_TIMESTAMP
  WHERE contact_id = NEW.contact_id;
  UPDATE contact_list_activity
  SET priority = CASE
    WHEN customer_payments_count > 0 THEN 4
    WHEN attended_appointments_count > 0 OR attendance_signals_count > 0 THEN 3
    WHEN active_appointments_count > 0 THEN 2
    ELSE 1 END
  WHERE contact_id = NEW.contact_id;
END;

CREATE TRIGGER trg_contact_payment_item_delete
BEFORE DELETE ON contact_payment_activity_items
BEGIN
  UPDATE contact_list_activity
  SET total_paid = MAX(0, total_paid - OLD.total_paid_contribution),
      payments_count = MAX(0, payments_count - OLD.payments_count_contribution),
      purchases_count = MAX(0, purchases_count - OLD.purchases_count_contribution),
      customer_payments_count = MAX(0, customer_payments_count - OLD.customer_payments_count_contribution),
      failed_payments_count = MAX(0, failed_payments_count - OLD.failed_payments_count_contribution),
      last_purchase_date = CASE WHEN last_purchase_payment_id = OLD.payment_id THEN (
        SELECT purchase_date FROM contact_payment_activity_items
        WHERE contact_id = OLD.contact_id AND payment_id != OLD.payment_id AND purchase_sort IS NOT NULL
        ORDER BY purchase_sort DESC, payment_id DESC LIMIT 1
      ) ELSE last_purchase_date END,
      last_purchase_sort = CASE WHEN last_purchase_payment_id = OLD.payment_id THEN (
        SELECT purchase_sort FROM contact_payment_activity_items
        WHERE contact_id = OLD.contact_id AND payment_id != OLD.payment_id AND purchase_sort IS NOT NULL
        ORDER BY purchase_sort DESC, payment_id DESC LIMIT 1
      ) ELSE last_purchase_sort END,
      last_purchase_payment_id = CASE WHEN last_purchase_payment_id = OLD.payment_id THEN (
        SELECT payment_id FROM contact_payment_activity_items
        WHERE contact_id = OLD.contact_id AND payment_id != OLD.payment_id AND purchase_sort IS NOT NULL
        ORDER BY purchase_sort DESC, payment_id DESC LIMIT 1
      ) ELSE last_purchase_payment_id END,
      first_payment_date = CASE WHEN first_payment_id = OLD.payment_id THEN (
        SELECT first_payment_date FROM contact_payment_activity_items
        WHERE contact_id = OLD.contact_id AND payment_id != OLD.payment_id AND first_payment_sort IS NOT NULL
        ORDER BY first_payment_sort ASC, payment_id ASC LIMIT 1
      ) ELSE first_payment_date END,
      first_payment_sort = CASE WHEN first_payment_id = OLD.payment_id THEN (
        SELECT first_payment_sort FROM contact_payment_activity_items
        WHERE contact_id = OLD.contact_id AND payment_id != OLD.payment_id AND first_payment_sort IS NOT NULL
        ORDER BY first_payment_sort ASC, payment_id ASC LIMIT 1
      ) ELSE first_payment_sort END,
      first_payment_id = CASE WHEN first_payment_id = OLD.payment_id THEN (
        SELECT payment_id FROM contact_payment_activity_items
        WHERE contact_id = OLD.contact_id AND payment_id != OLD.payment_id AND first_payment_sort IS NOT NULL
        ORDER BY first_payment_sort ASC, payment_id ASC LIMIT 1
      ) ELSE first_payment_id END,
      last_customer_payment_date = CASE WHEN last_customer_payment_id = OLD.payment_id THEN (
        SELECT customer_payment_date FROM contact_payment_activity_items
        WHERE contact_id = OLD.contact_id AND payment_id != OLD.payment_id AND customer_payment_sort IS NOT NULL
        ORDER BY customer_payment_sort DESC, payment_id DESC LIMIT 1
      ) ELSE last_customer_payment_date END,
      last_customer_payment_sort = CASE WHEN last_customer_payment_id = OLD.payment_id THEN (
        SELECT customer_payment_sort FROM contact_payment_activity_items
        WHERE contact_id = OLD.contact_id AND payment_id != OLD.payment_id AND customer_payment_sort IS NOT NULL
        ORDER BY customer_payment_sort DESC, payment_id DESC LIMIT 1
      ) ELSE last_customer_payment_sort END,
      last_customer_payment_id = CASE WHEN last_customer_payment_id = OLD.payment_id THEN (
        SELECT payment_id FROM contact_payment_activity_items
        WHERE contact_id = OLD.contact_id AND payment_id != OLD.payment_id AND customer_payment_sort IS NOT NULL
        ORDER BY customer_payment_sort DESC, payment_id DESC LIMIT 1
      ) ELSE last_customer_payment_id END,
      updated_at = CURRENT_TIMESTAMP
  WHERE contact_id = OLD.contact_id;
  UPDATE contact_list_activity
  SET priority = CASE
    WHEN customer_payments_count > 0 THEN 4
    WHEN attended_appointments_count > 0 OR attendance_signals_count > 0 THEN 3
    WHEN active_appointments_count > 0 THEN 2
    ELSE 1 END
  WHERE contact_id = OLD.contact_id;
END;

CREATE TRIGGER trg_contact_payment_source_insert
AFTER INSERT ON payments
BEGIN
  INSERT INTO contact_payment_activity_items
  SELECT * FROM contact_payment_activity_source WHERE payment_id = NEW.id
  ON CONFLICT(payment_id) DO NOTHING;
  UPDATE crm_list_projection_state SET generation = generation + 1, updated_at = CURRENT_TIMESTAMP
  WHERE projection_key = 'contact_payments' AND status != 'ready';
END;
CREATE TRIGGER trg_contact_payment_source_update
AFTER UPDATE OF contact_id, amount, status, payment_mode, paid_at, date, created_at ON payments
BEGIN
  DELETE FROM contact_payment_activity_items WHERE payment_id = NEW.id;
  INSERT INTO contact_payment_activity_items
  SELECT * FROM contact_payment_activity_source WHERE payment_id = NEW.id
  ON CONFLICT(payment_id) DO NOTHING;
  UPDATE crm_list_projection_state SET generation = generation + 1, updated_at = CURRENT_TIMESTAMP
  WHERE projection_key = 'contact_payments' AND status != 'ready';
END;
CREATE TRIGGER trg_contact_payment_source_delete
AFTER DELETE ON payments
BEGIN
  DELETE FROM contact_payment_activity_items WHERE payment_id = OLD.id;
  UPDATE crm_list_projection_state SET generation = generation + 1, updated_at = CURRENT_TIMESTAMP
  WHERE projection_key = 'contact_payments' AND status != 'ready';
END;

DROP TRIGGER IF EXISTS trg_contact_appointment_item_insert;
DROP TRIGGER IF EXISTS trg_contact_appointment_item_delete;
DROP TRIGGER IF EXISTS trg_contact_appointment_source_insert;
DROP TRIGGER IF EXISTS trg_contact_appointment_source_update;
DROP TRIGGER IF EXISTS trg_contact_appointment_source_delete;

CREATE TRIGGER trg_contact_appointment_item_insert
AFTER INSERT ON contact_appointment_activity_items
BEGIN
  INSERT OR IGNORE INTO contact_list_activity(contact_id) VALUES (NEW.contact_id);
  UPDATE contact_list_activity
  SET appointments_count = appointments_count + 1,
      active_appointments_count = active_appointments_count + NEW.active_contribution,
      attended_appointments_count = attended_appointments_count + NEW.attended_contribution,
      last_appointment_date = CASE WHEN last_appointment_sort IS NULL OR NEW.appointment_sort > last_appointment_sort OR
        (NEW.appointment_sort = last_appointment_sort AND NEW.appointment_id > COALESCE(last_appointment_id, ''))
        THEN NEW.appointment_date ELSE last_appointment_date END,
      last_appointment_sort = CASE WHEN last_appointment_sort IS NULL OR NEW.appointment_sort > last_appointment_sort OR
        (NEW.appointment_sort = last_appointment_sort AND NEW.appointment_id > COALESCE(last_appointment_id, ''))
        THEN NEW.appointment_sort ELSE last_appointment_sort END,
      last_appointment_id = CASE WHEN last_appointment_sort IS NULL OR NEW.appointment_sort > last_appointment_sort OR
        (NEW.appointment_sort = last_appointment_sort AND NEW.appointment_id > COALESCE(last_appointment_id, ''))
        THEN NEW.appointment_id ELSE last_appointment_id END,
      updated_at = CURRENT_TIMESTAMP
  WHERE contact_id = NEW.contact_id;
  UPDATE contact_list_activity SET priority = CASE
    WHEN customer_payments_count > 0 THEN 4
    WHEN attended_appointments_count > 0 OR attendance_signals_count > 0 THEN 3
    WHEN active_appointments_count > 0 THEN 2 ELSE 1 END
  WHERE contact_id = NEW.contact_id;
END;

CREATE TRIGGER trg_contact_appointment_item_delete
BEFORE DELETE ON contact_appointment_activity_items
BEGIN
  UPDATE contact_list_activity
  SET appointments_count = MAX(0, appointments_count - 1),
      active_appointments_count = MAX(0, active_appointments_count - OLD.active_contribution),
      attended_appointments_count = MAX(0, attended_appointments_count - OLD.attended_contribution),
      last_appointment_date = CASE WHEN last_appointment_id = OLD.appointment_id THEN (
        SELECT appointment_date FROM contact_appointment_activity_items
        WHERE contact_id = OLD.contact_id AND appointment_id != OLD.appointment_id
        ORDER BY appointment_sort DESC, appointment_id DESC LIMIT 1
      ) ELSE last_appointment_date END,
      last_appointment_sort = CASE WHEN last_appointment_id = OLD.appointment_id THEN (
        SELECT appointment_sort FROM contact_appointment_activity_items
        WHERE contact_id = OLD.contact_id AND appointment_id != OLD.appointment_id
        ORDER BY appointment_sort DESC, appointment_id DESC LIMIT 1
      ) ELSE last_appointment_sort END,
      last_appointment_id = CASE WHEN last_appointment_id = OLD.appointment_id THEN (
        SELECT appointment_id FROM contact_appointment_activity_items
        WHERE contact_id = OLD.contact_id AND appointment_id != OLD.appointment_id
        ORDER BY appointment_sort DESC, appointment_id DESC LIMIT 1
      ) ELSE last_appointment_id END,
      updated_at = CURRENT_TIMESTAMP
  WHERE contact_id = OLD.contact_id;
  UPDATE contact_list_activity SET priority = CASE
    WHEN customer_payments_count > 0 THEN 4
    WHEN attended_appointments_count > 0 OR attendance_signals_count > 0 THEN 3
    WHEN active_appointments_count > 0 THEN 2 ELSE 1 END
  WHERE contact_id = OLD.contact_id;
END;

CREATE TRIGGER trg_contact_appointment_source_insert
AFTER INSERT ON appointments
BEGIN
  INSERT INTO contact_appointment_activity_items
  SELECT * FROM contact_appointment_activity_source WHERE appointment_id = NEW.id
  ON CONFLICT(appointment_id) DO NOTHING;
  UPDATE crm_list_projection_state SET generation = generation + 1, updated_at = CURRENT_TIMESTAMP
  WHERE projection_key = 'contact_appointments' AND status != 'ready';
END;
CREATE TRIGGER trg_contact_appointment_source_update
AFTER UPDATE OF contact_id, appointment_status, status, start_time, date_added, date_updated ON appointments
BEGIN
  DELETE FROM contact_appointment_activity_items WHERE appointment_id = NEW.id;
  INSERT INTO contact_appointment_activity_items
  SELECT * FROM contact_appointment_activity_source WHERE appointment_id = NEW.id
  ON CONFLICT(appointment_id) DO NOTHING;
  UPDATE crm_list_projection_state SET generation = generation + 1, updated_at = CURRENT_TIMESTAMP
  WHERE projection_key = 'contact_appointments' AND status != 'ready';
END;
CREATE TRIGGER trg_contact_appointment_source_delete
AFTER DELETE ON appointments
BEGIN
  DELETE FROM contact_appointment_activity_items WHERE appointment_id = OLD.id;
  UPDATE crm_list_projection_state SET generation = generation + 1, updated_at = CURRENT_TIMESTAMP
  WHERE projection_key = 'contact_appointments' AND status != 'ready';
END;

DROP TRIGGER IF EXISTS trg_contact_attendance_signal_insert;
DROP TRIGGER IF EXISTS trg_contact_attendance_signal_update;
DROP TRIGGER IF EXISTS trg_contact_attendance_signal_delete;
DROP TRIGGER IF EXISTS trg_contact_attendance_item_insert;
DROP TRIGGER IF EXISTS trg_contact_attendance_item_delete;
CREATE TRIGGER trg_contact_attendance_item_insert AFTER INSERT ON contact_attendance_activity_items BEGIN
  INSERT OR IGNORE INTO contact_list_activity(contact_id) VALUES (NEW.contact_id);
  UPDATE contact_list_activity SET attendance_signals_count = attendance_signals_count + 1, priority = CASE
    WHEN customer_payments_count > 0 THEN 4 ELSE 3 END, updated_at = CURRENT_TIMESTAMP
  WHERE contact_id = NEW.contact_id;
END;
CREATE TRIGGER trg_contact_attendance_item_delete BEFORE DELETE ON contact_attendance_activity_items BEGIN
  UPDATE contact_list_activity SET attendance_signals_count = MAX(0, attendance_signals_count - 1), updated_at = CURRENT_TIMESTAMP
  WHERE contact_id = OLD.contact_id;
  UPDATE contact_list_activity SET priority = CASE WHEN customer_payments_count > 0 THEN 4
    WHEN attended_appointments_count > 0 OR attendance_signals_count > 0 THEN 3
    WHEN active_appointments_count > 0 THEN 2 ELSE 1 END WHERE contact_id = OLD.contact_id;
END;
CREATE TRIGGER trg_contact_attendance_signal_insert AFTER INSERT ON appointment_attendance_signals BEGIN
  INSERT INTO contact_attendance_activity_items
  SELECT * FROM contact_attendance_activity_source WHERE signal_id = NEW.id
  ON CONFLICT(signal_id) DO NOTHING;
  UPDATE crm_list_projection_state SET generation = generation + 1, updated_at = CURRENT_TIMESTAMP
  WHERE projection_key = 'contact_attendance' AND status != 'ready';
END;
CREATE TRIGGER trg_contact_attendance_signal_update AFTER UPDATE OF contact_id ON appointment_attendance_signals BEGIN
  DELETE FROM contact_attendance_activity_items WHERE signal_id = NEW.id;
  INSERT INTO contact_attendance_activity_items
  SELECT * FROM contact_attendance_activity_source WHERE signal_id = NEW.id
  ON CONFLICT(signal_id) DO NOTHING;
  UPDATE crm_list_projection_state SET generation = generation + 1, updated_at = CURRENT_TIMESTAMP
  WHERE projection_key = 'contact_attendance' AND status != 'ready';
END;
CREATE TRIGGER trg_contact_attendance_signal_delete AFTER DELETE ON appointment_attendance_signals BEGIN
  DELETE FROM contact_attendance_activity_items WHERE signal_id = OLD.id;
  UPDATE crm_list_projection_state SET generation = generation + 1, updated_at = CURRENT_TIMESTAMP
  WHERE projection_key = 'contact_attendance' AND status != 'ready';
END;

DROP TRIGGER IF EXISTS trg_payment_list_source_insert;
DROP TRIGGER IF EXISTS trg_payment_list_source_update;
DROP TRIGGER IF EXISTS trg_payment_list_source_delete;
DROP TRIGGER IF EXISTS trg_payment_list_contact_update;
CREATE TRIGGER trg_payment_list_source_insert AFTER INSERT ON payments BEGIN
  INSERT INTO payment_list_activity
  SELECT *, CURRENT_TIMESTAMP FROM payment_list_activity_source WHERE payment_id = NEW.id
  ON CONFLICT(payment_id) DO UPDATE SET
    contact_id = excluded.contact_id, date_sort = excluded.date_sort, date_cursor = excluded.date_cursor,
    created_sort = excluded.created_sort, created_cursor = excluded.created_cursor,
    amount_sort = excluded.amount_sort, status_sort = excluded.status_sort,
    contact_name_sort = excluded.contact_name_sort, contact_email_sort = excluded.contact_email_sort,
    method_sort = excluded.method_sort, provider_sort = excluded.provider_sort,
    title_sort = excluded.title_sort, updated_at = excluded.updated_at;
  UPDATE crm_list_projection_state SET generation = generation + 1, updated_at = CURRENT_TIMESTAMP
  WHERE projection_key = 'payment_list' AND status != 'ready';
END;
CREATE TRIGGER trg_payment_list_source_update
AFTER UPDATE OF contact_id, date, created_at, amount, status, payment_method, payment_provider, title, description ON payments BEGIN
  INSERT INTO payment_list_activity
  SELECT *, CURRENT_TIMESTAMP FROM payment_list_activity_source WHERE payment_id = NEW.id
  ON CONFLICT(payment_id) DO UPDATE SET
    contact_id = excluded.contact_id, date_sort = excluded.date_sort, date_cursor = excluded.date_cursor,
    created_sort = excluded.created_sort, created_cursor = excluded.created_cursor,
    amount_sort = excluded.amount_sort, status_sort = excluded.status_sort,
    contact_name_sort = excluded.contact_name_sort, contact_email_sort = excluded.contact_email_sort,
    method_sort = excluded.method_sort, provider_sort = excluded.provider_sort,
    title_sort = excluded.title_sort, updated_at = excluded.updated_at;
  UPDATE crm_list_projection_state SET generation = generation + 1, updated_at = CURRENT_TIMESTAMP
  WHERE projection_key = 'payment_list' AND status != 'ready';
END;
CREATE TRIGGER trg_payment_list_source_delete AFTER DELETE ON payments BEGIN
  DELETE FROM payment_list_activity WHERE payment_id = OLD.id;
  UPDATE crm_list_projection_state SET generation = generation + 1, updated_at = CURRENT_TIMESTAMP
  WHERE projection_key = 'payment_list' AND status != 'ready';
END;
CREATE TRIGGER trg_payment_list_contact_update AFTER UPDATE OF full_name, email ON contacts BEGIN
  UPDATE payment_list_activity
  SET contact_name_sort = LOWER(COALESCE(NEW.full_name, '')),
      contact_email_sort = LOWER(COALESCE(NEW.email, '')),
      updated_at = CURRENT_TIMESTAMP
  WHERE contact_id = NEW.id;
  UPDATE crm_list_projection_state SET generation = generation + 1, updated_at = CURRENT_TIMESTAMP
  WHERE projection_key = 'payment_list' AND status != 'ready';
  UPDATE payment_list_revisions SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP
  WHERE scope = 'transactions' AND EXISTS (
    SELECT 1 FROM payment_list_activity WHERE contact_id = NEW.id LIMIT 1
  );
END;

-- Integraciones asincronas pueden crear actividad antes que su contacto. Al
-- aparecer el contacto reconciliamos solo ese ID; al borrarlo retiramos sus
-- ledgers para que un ID reutilizado nunca herede actividad vieja. La lista de
-- pagos conserva deliberadamente cualquier pago que quede huérfano.
DROP TRIGGER IF EXISTS trg_crm_projection_contact_insert;
DROP TRIGGER IF EXISTS trg_crm_projection_contact_delete;
CREATE TRIGGER trg_crm_projection_contact_insert AFTER INSERT ON contacts BEGIN
  INSERT INTO contact_payment_activity_items
  SELECT * FROM contact_payment_activity_source WHERE contact_id = NEW.id
  ON CONFLICT(payment_id) DO NOTHING;
  INSERT INTO contact_appointment_activity_items
  SELECT * FROM contact_appointment_activity_source WHERE contact_id = NEW.id
  ON CONFLICT(appointment_id) DO NOTHING;
  INSERT INTO contact_attendance_activity_items
  SELECT * FROM contact_attendance_activity_source WHERE contact_id = NEW.id
  ON CONFLICT(signal_id) DO NOTHING;
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
END;
CREATE TRIGGER trg_crm_projection_contact_delete BEFORE DELETE ON contacts BEGIN
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
END;

DROP TRIGGER IF EXISTS trg_payment_list_transactions_insert;
DROP TRIGGER IF EXISTS trg_payment_list_transactions_update;
DROP TRIGGER IF EXISTS trg_payment_list_transactions_delete;
CREATE TRIGGER trg_payment_list_transactions_insert AFTER INSERT ON payments BEGIN
  UPDATE payment_list_revisions SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE scope = 'transactions';
END;
CREATE TRIGGER trg_payment_list_transactions_update AFTER UPDATE ON payments BEGIN
  UPDATE payment_list_revisions SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE scope = 'transactions';
END;
CREATE TRIGGER trg_payment_list_transactions_delete AFTER DELETE ON payments BEGIN
  UPDATE payment_list_revisions SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE scope = 'transactions';
END;
