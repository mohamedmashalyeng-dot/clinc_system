-- Luma Clinic schema. Money is INTEGER minor units; instants are UTC ISO-8601 text;
-- calendar dates (birthdays, expiry) are clinic-local YYYY-MM-DD text.

CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  data TEXT NOT NULL,
  logo_file TEXT,
  updated_at TEXT NOT NULL,
  updated_by INTEGER
);

CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','receptionist','practitioner','accountant','assistant','call_center')),
  extra_permissions TEXT NOT NULL DEFAULT '[]',
  -- Personal appearance and start-page choices (JSON; see preferencesSchema).
  preferences TEXT NOT NULL DEFAULT '{}',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role TEXT NOT NULL,
  permission TEXT NOT NULL,
  PRIMARY KEY (role, permission)
);

CREATE TABLE IF NOT EXISTS qualifications (
  code TEXT PRIMARY KEY,
  name_en TEXT NOT NULL,
  name_ar TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS practitioners (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER UNIQUE REFERENCES users(id),
  display_name TEXT NOT NULL,
  display_name_ar TEXT NOT NULL,
  qualifications TEXT NOT NULL DEFAULT '[]',
  color TEXT NOT NULL,
  hours TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

-- Leave, sickness, training and other absences. Bookings that overlap active time off are refused;
-- cancelling keeps the record (cancelled_*) so the schedule history stays explainable.
CREATE TABLE IF NOT EXISTS practitioner_time_off (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  practitioner_id INTEGER NOT NULL REFERENCES practitioners(id),
  kind TEXT NOT NULL CHECK (kind IN ('leave','sick','training','other')),
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  all_day INTEGER NOT NULL DEFAULT 1,
  note TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  cancelled_by INTEGER REFERENCES users(id),
  cancelled_at TEXT,
  cancel_reason TEXT,
  CHECK (end_at > start_at)
);
CREATE INDEX IF NOT EXISTS idx_time_off ON practitioner_time_off(practitioner_id, start_at);

CREATE TABLE IF NOT EXISTS rooms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  name_ar TEXT,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  name_ar TEXT,
  model TEXT,
  room_id INTEGER REFERENCES rooms(id),
  active INTEGER NOT NULL DEFAULT 1,
  maintenance_note TEXT
);

CREATE TABLE IF NOT EXISTS service_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name_en TEXT NOT NULL,
  name_ar TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS services (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name_en TEXT NOT NULL,
  name_ar TEXT NOT NULL,
  category_id INTEGER NOT NULL REFERENCES service_categories(id),
  duration_min INTEGER NOT NULL CHECK (duration_min > 0),
  price INTEGER NOT NULL CHECK (price >= 0),
  deposit_amount INTEGER NOT NULL DEFAULT 0,
  qualification TEXT REFERENCES qualifications(code),
  room_ids TEXT NOT NULL DEFAULT '[]',
  device_ids TEXT NOT NULL DEFAULT '[]',
  buffer_before_min INTEGER NOT NULL DEFAULT 0,
  buffer_after_min INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS patients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  phone_normalized TEXT NOT NULL,
  alt_phone TEXT,
  alt_phone_normalized TEXT,
  email TEXT,
  dob TEXT,
  gender TEXT NOT NULL DEFAULT 'unspecified',
  address TEXT,
  emergency_name TEXT,
  emergency_phone TEXT,
  emergency_relation TEXT,
  preferred_language TEXT NOT NULL DEFAULT 'ar',
  contact_channel TEXT NOT NULL DEFAULT 'whatsapp',
  allow_reminders INTEGER NOT NULL DEFAULT 1,
  allow_marketing INTEGER NOT NULL DEFAULT 0,
  primary_practitioner_id INTEGER REFERENCES practitioners(id),
  admin_notes TEXT,
  -- How the patient found the clinic (marketing attribution) and who referred them.
  source TEXT,
  referred_by_patient_id INTEGER REFERENCES patients(id),
  created_at TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_patients_phone ON patients(phone_normalized);
CREATE INDEX IF NOT EXISTS idx_patients_alt_phone ON patients(alt_phone_normalized);
CREATE INDEX IF NOT EXISTS idx_patients_name ON patients(last_name, first_name);

CREATE TABLE IF NOT EXISTS patient_medical (
  patient_id INTEGER PRIMARY KEY REFERENCES patients(id),
  data TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  updated_by INTEGER REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS patient_medical_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  version INTEGER NOT NULL,
  data TEXT NOT NULL,
  author_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS treatment_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  title TEXT NOT NULL,
  service_id INTEGER REFERENCES services(id),
  body_areas TEXT NOT NULL DEFAULT '[]',
  planned_sessions INTEGER NOT NULL,
  interval_weeks INTEGER NOT NULL DEFAULT 4,
  goals TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS package_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name_en TEXT NOT NULL,
  name_ar TEXT NOT NULL,
  price INTEGER NOT NULL,
  validity_days INTEGER NOT NULL,
  terms_en TEXT,
  terms_ar TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS package_template_items (
  template_id INTEGER NOT NULL REFERENCES package_templates(id),
  service_id INTEGER NOT NULL REFERENCES services(id),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (template_id, service_id)
);

CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT NOT NULL UNIQUE,
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  appointment_id INTEGER REFERENCES appointments(id),
  kind TEXT NOT NULL CHECK (kind IN ('service','package','custom')),
  status TEXT NOT NULL DEFAULT 'issued' CHECK (status IN ('issued','void')),
  issue_date TEXT NOT NULL,
  subtotal INTEGER NOT NULL,
  discount_total INTEGER NOT NULL DEFAULT 0,
  tax_rate REAL NOT NULL DEFAULT 0,
  tax INTEGER NOT NULL DEFAULT 0,
  adjustments_total INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL,
  discount_reason TEXT,
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  voided_by INTEGER REFERENCES users(id),
  voided_at TEXT,
  void_reason TEXT,
  idempotency_key TEXT UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_invoices_patient ON invoices(patient_id);
CREATE INDEX IF NOT EXISTS idx_invoices_date ON invoices(issue_date);
-- One live invoice per appointment: deposits and the balance land on the same invoice.
CREATE UNIQUE INDEX IF NOT EXISTS ux_invoice_appointment ON invoices(appointment_id) WHERE appointment_id IS NOT NULL AND status <> 'void';

CREATE TABLE IF NOT EXISTS invoice_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  description TEXT NOT NULL,
  service_id INTEGER REFERENCES services(id),
  package_template_id INTEGER REFERENCES package_templates(id),
  quantity INTEGER NOT NULL,
  unit_price INTEGER NOT NULL,
  discount INTEGER NOT NULL DEFAULT 0,
  line_total INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS invoice_adjustments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  amount INTEGER NOT NULL,
  reason TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS invoice_installments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  seq INTEGER NOT NULL,
  due_date TEXT NOT NULL,
  amount INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT NOT NULL UNIQUE,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  amount INTEGER NOT NULL CHECK (amount > 0),
  method TEXT NOT NULL CHECK (method IN ('cash','card','bank_transfer')),
  reference TEXT,
  kind TEXT NOT NULL DEFAULT 'payment' CHECK (kind IN ('payment','deposit')),
  received_at TEXT NOT NULL,
  received_by INTEGER REFERENCES users(id),
  idempotency_key TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_payments_invoice ON payments(invoice_id);
CREATE INDEX IF NOT EXISTS idx_payments_received ON payments(received_at);
CREATE INDEX IF NOT EXISTS idx_payments_patient ON payments(patient_id);

CREATE TABLE IF NOT EXISTS refunds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT NOT NULL UNIQUE,
  payment_id INTEGER NOT NULL REFERENCES payments(id),
  invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  amount INTEGER NOT NULL CHECK (amount > 0),
  method TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  category TEXT NOT NULL,
  description TEXT NOT NULL,
  vendor TEXT,
  amount INTEGER NOT NULL CHECK (amount > 0),
  method TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  voided_by INTEGER REFERENCES users(id),
  voided_at TEXT,
  void_reason TEXT,
  idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS purchased_packages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  template_id INTEGER NOT NULL REFERENCES package_templates(id),
  name_en TEXT NOT NULL,
  name_ar TEXT NOT NULL,
  price INTEGER NOT NULL,
  discount INTEGER NOT NULL DEFAULT 0,
  purchase_date TEXT NOT NULL,
  start_date TEXT NOT NULL,
  expiry_date TEXT NOT NULL,
  terms_en TEXT,
  terms_ar TEXT,
  invoice_id INTEGER REFERENCES invoices(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled')),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_pkg_patient ON purchased_packages(patient_id);

CREATE TABLE IF NOT EXISTS purchased_package_items (
  purchased_package_id INTEGER NOT NULL REFERENCES purchased_packages(id),
  service_id INTEGER NOT NULL REFERENCES services(id),
  quantity INTEGER NOT NULL,
  PRIMARY KEY (purchased_package_id, service_id)
);

CREATE TABLE IF NOT EXISTS appointments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  service_id INTEGER NOT NULL REFERENCES services(id),
  practitioner_id INTEGER NOT NULL REFERENCES practitioners(id),
  room_id INTEGER NOT NULL REFERENCES rooms(id),
  device_id INTEGER REFERENCES devices(id),
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  block_start TEXT NOT NULL,
  block_end TEXT NOT NULL,
  buffer_before_min INTEGER NOT NULL DEFAULT 0,
  buffer_after_min INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('booked','confirmed','arrived','in_treatment','completed','cancelled','no_show')),
  purchased_package_id INTEGER REFERENCES purchased_packages(id),
  notes TEXT,
  arrived_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  cancelled_at TEXT,
  cancel_reason TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_appt_start ON appointments(start_at);
CREATE INDEX IF NOT EXISTS idx_appt_patient ON appointments(patient_id);
CREATE INDEX IF NOT EXISTS idx_appt_practitioner ON appointments(practitioner_id, block_start);
CREATE INDEX IF NOT EXISTS idx_appt_room ON appointments(room_id, block_start);
CREATE INDEX IF NOT EXISTS idx_appt_device ON appointments(device_id, block_start);

-- Database-level guard against double booking (defence in depth behind the API check).
CREATE TRIGGER IF NOT EXISTS trg_appt_overlap_insert BEFORE INSERT ON appointments
WHEN NEW.status IN ('booked','confirmed','arrived','in_treatment','completed')
BEGIN
  SELECT RAISE(ABORT, 'SCHEDULING_CONFLICT') WHERE EXISTS (
    SELECT 1 FROM appointments a
    WHERE a.status IN ('booked','confirmed','arrived','in_treatment','completed')
      AND a.block_start < NEW.block_end AND a.block_end > NEW.block_start
      AND (a.practitioner_id = NEW.practitioner_id OR a.room_id = NEW.room_id
           OR (NEW.device_id IS NOT NULL AND a.device_id = NEW.device_id))
  );
END;

CREATE TRIGGER IF NOT EXISTS trg_appt_overlap_update
BEFORE UPDATE OF block_start, block_end, practitioner_id, room_id, device_id, status ON appointments
WHEN NEW.status IN ('booked','confirmed','arrived','in_treatment','completed')
BEGIN
  SELECT RAISE(ABORT, 'SCHEDULING_CONFLICT') WHERE EXISTS (
    SELECT 1 FROM appointments a
    WHERE a.id <> NEW.id
      AND a.status IN ('booked','confirmed','arrived','in_treatment','completed')
      AND a.block_start < NEW.block_end AND a.block_end > NEW.block_start
      AND (a.practitioner_id = NEW.practitioner_id OR a.room_id = NEW.room_id
           OR (NEW.device_id IS NOT NULL AND a.device_id = NEW.device_id))
  );
END;

CREATE TABLE IF NOT EXISTS appointment_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  appointment_id INTEGER NOT NULL REFERENCES appointments(id),
  kind TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  reason TEXT,
  details TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_appt_events ON appointment_events(appointment_id);

CREATE TABLE IF NOT EXISTS treatment_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  appointment_id INTEGER NOT NULL REFERENCES appointments(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  practitioner_id INTEGER NOT NULL REFERENCES practitioners(id),
  service_id INTEGER NOT NULL REFERENCES services(id),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','completed','reversed')),
  body_areas TEXT NOT NULL DEFAULT '[]',
  assessment TEXT,
  treatment_notes TEXT,
  device_id INTEGER REFERENCES devices(id),
  device_settings TEXT NOT NULL DEFAULT '[]',
  aftercare TEXT,
  follow_up_plan TEXT,
  follow_up_date TEXT,
  purchased_package_id INTEGER REFERENCES purchased_packages(id),
  treatment_plan_id INTEGER REFERENCES treatment_plans(id),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL,
  completed_by INTEGER REFERENCES users(id),
  completed_at TEXT,
  completion_key TEXT UNIQUE,
  reversed_by INTEGER REFERENCES users(id),
  reversed_at TEXT,
  reversal_reason TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_session_appointment ON treatment_sessions(appointment_id) WHERE status <> 'reversed';
CREATE INDEX IF NOT EXISTS idx_sessions_patient ON treatment_sessions(patient_id);

CREATE TABLE IF NOT EXISTS session_consumables (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES treatment_sessions(id),
  item_id INTEGER NOT NULL REFERENCES inventory_items(id),
  batch_id INTEGER NOT NULL REFERENCES inventory_batches(id),
  quantity REAL NOT NULL CHECK (quantity > 0)
);

CREATE TABLE IF NOT EXISTS session_amendments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES treatment_sessions(id),
  author_id INTEGER REFERENCES users(id),
  reason TEXT NOT NULL,
  changes TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Package balances are never stored: remaining = quantity + Σ delta from this ledger.
CREATE TABLE IF NOT EXISTS package_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  purchased_package_id INTEGER NOT NULL REFERENCES purchased_packages(id),
  service_id INTEGER NOT NULL REFERENCES services(id),
  delta INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('consume','reversal','adjustment')),
  session_id INTEGER REFERENCES treatment_sessions(id),
  appointment_id INTEGER REFERENCES appointments(id),
  reason TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  idempotency_key TEXT UNIQUE
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_usage_consume ON package_usage(session_id) WHERE kind = 'consume';
CREATE UNIQUE INDEX IF NOT EXISTS ux_usage_reversal ON package_usage(session_id) WHERE kind = 'reversal';
CREATE INDEX IF NOT EXISTS idx_usage_pkg ON package_usage(purchased_package_id);

CREATE TABLE IF NOT EXISTS inventory_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  unit TEXT NOT NULL,
  supplier TEXT,
  reorder_threshold REAL NOT NULL DEFAULT 0,
  unit_cost INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS inventory_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES inventory_items(id),
  batch_number TEXT NOT NULL,
  expiry_date TEXT,
  unit_cost INTEGER NOT NULL DEFAULT 0,
  received_at TEXT NOT NULL,
  UNIQUE (item_id, batch_number)
);

-- Stock on hand is never stored: on-hand = Σ quantity of movements for the batch.
CREATE TABLE IF NOT EXISTS stock_movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES inventory_items(id),
  batch_id INTEGER NOT NULL REFERENCES inventory_batches(id),
  type TEXT NOT NULL CHECK (type IN ('purchase','usage','waste','adjustment')),
  quantity REAL NOT NULL,
  reason TEXT,
  reference TEXT,
  session_id INTEGER REFERENCES treatment_sessions(id),
  session_consumable_id INTEGER REFERENCES session_consumables(id),
  override_reason TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  idempotency_key TEXT UNIQUE
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_movement_usage ON stock_movements(session_consumable_id) WHERE type = 'usage';
CREATE UNIQUE INDEX IF NOT EXISTS ux_movement_restock ON stock_movements(session_consumable_id) WHERE type = 'adjustment' AND session_consumable_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_movements_batch ON stock_movements(batch_id);
CREATE INDEX IF NOT EXISTS idx_movements_created ON stock_movements(created_at);

CREATE TABLE IF NOT EXISTS consent_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  title_en TEXT NOT NULL,
  title_ar TEXT NOT NULL,
  body_en TEXT NOT NULL,
  body_ar TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS consents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  template_id INTEGER NOT NULL REFERENCES consent_templates(id),
  type TEXT NOT NULL,
  template_version INTEGER NOT NULL,
  title_en TEXT NOT NULL,
  title_ar TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('granted','withdrawn')),
  method TEXT NOT NULL,
  notes TEXT,
  recorded_by INTEGER REFERENCES users(id),
  recorded_at TEXT NOT NULL,
  withdrawn_by INTEGER REFERENCES users(id),
  withdrawn_at TEXT,
  withdraw_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_consents_patient ON consents(patient_id, type);

CREATE TABLE IF NOT EXISTS photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  session_id INTEGER REFERENCES treatment_sessions(id),
  body_area TEXT NOT NULL,
  kind TEXT NOT NULL,
  taken_on TEXT NOT NULL,
  file_name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  notes TEXT,
  consent_id INTEGER REFERENCES consents(id),
  uploaded_by INTEGER REFERENCES users(id),
  uploaded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_photos_patient ON photos(patient_id);

CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  clinical INTEGER NOT NULL DEFAULT 0,
  file_name TEXT NOT NULL,
  original_name TEXT,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  uploaded_by INTEGER REFERENCES users(id),
  uploaded_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS message_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  body_en TEXT NOT NULL,
  body_ar TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  approved_by INTEGER REFERENCES users(id),
  approved_at TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS follow_ups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  session_id INTEGER REFERENCES treatment_sessions(id),
  service_id INTEGER REFERENCES services(id),
  due_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','dismissed')),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  closed_by INTEGER REFERENCES users(id),
  closed_at TEXT,
  close_note TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_followup_session ON follow_ups(session_id) WHERE session_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS communications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  channel TEXT NOT NULL,
  template_id INTEGER REFERENCES message_templates(id),
  follow_up_id INTEGER REFERENCES follow_ups(id),
  appointment_id INTEGER REFERENCES appointments(id),
  body TEXT NOT NULL,
  outcome TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL
);

-- Patients waiting for a sooner or specific slot. Booking the patient for the same service
-- fulfils the entry; removing it keeps the record with a reason.
CREATE TABLE IF NOT EXISTS waitlist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  service_id INTEGER NOT NULL REFERENCES services(id),
  practitioner_id INTEGER REFERENCES practitioners(id),
  earliest_date TEXT NOT NULL,
  latest_date TEXT NOT NULL,
  time_of_day TEXT NOT NULL DEFAULT 'any' CHECK (time_of_day IN ('any','morning','afternoon','evening')),
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','booked','removed')),
  appointment_id INTEGER REFERENCES appointments(id),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  closed_by INTEGER REFERENCES users(id),
  closed_at TEXT,
  close_reason TEXT,
  CHECK (latest_date >= earliest_date)
);
CREATE INDEX IF NOT EXISTS idx_waitlist_status ON waitlist(status, earliest_date);

-- End-of-day drawer count. Expected amounts are computed by the server from payments, refunds and
-- cash expenses; a re-count supersedes the earlier closing and both are kept.
CREATE TABLE IF NOT EXISTS day_closings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  opening_float INTEGER NOT NULL DEFAULT 0,
  cash_in INTEGER NOT NULL,
  cash_refunds INTEGER NOT NULL,
  cash_expenses INTEGER NOT NULL,
  expected_cash INTEGER NOT NULL,
  counted_cash INTEGER NOT NULL,
  variance INTEGER NOT NULL,
  card_total INTEGER NOT NULL,
  transfer_total INTEGER NOT NULL,
  notes TEXT,
  closed_by INTEGER REFERENCES users(id),
  closed_at TEXT NOT NULL,
  superseded_by INTEGER REFERENCES day_closings(id),
  idempotency_key TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_day_closings_date ON day_closings(date);

-- Audit trail. Summaries name the action and record ids only — never clinical content.
CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id INTEGER,
  patient_id INTEGER,
  summary TEXT,
  meta TEXT,
  sensitive INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_events(at);
CREATE INDEX IF NOT EXISTS idx_audit_patient ON audit_events(patient_id);
