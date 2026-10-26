import { Router, type Request } from 'express';
import { all, camel, get, nowIso, parseJson, run, scalar, tx } from '../db/db.js';
import { assertPatientAccess, assertPerm, can, patientScopeSql, requirePerm, type AuthUser } from '../auth.js';
import { audit } from '../audit.js';
import { conflict, intParam, optStr, pageParams, validate } from '../http.js';
import { clinicToday, clinicTz } from '../settings.js';
import { medicalSchema, patientSchema, treatmentPlanSchema } from '../../shared/schemas.js';
import { normalizePhone } from '../../shared/domain.js';
import { ageFrom, zonedParts } from '../../shared/time.js';
import { INVOICE_BALANCE_SQL, appointmentPaymentState, patientOutstanding } from '../services/finance.js';
import { patientPackages } from '../services/packages.js';
import { sessionAmendments } from '../services/sessions.js';

export const patientsRouter = Router();

type Row = Record<string, unknown>;

function mapPatient(r: Row) {
  return {
    id: r.id as number,
    code: r.code as string,
    firstName: r.first_name as string,
    lastName: r.last_name as string,
    fullName: `${r.first_name} ${r.last_name}`,
    phone: r.phone as string,
    altPhone: (r.alt_phone as string) ?? null,
    email: (r.email as string) ?? null,
    dob: (r.dob as string) ?? null,
    age: ageFrom(r.dob as string, clinicToday()),
    gender: r.gender as string,
    address: (r.address as string) ?? null,
    emergencyName: (r.emergency_name as string) ?? null,
    emergencyPhone: (r.emergency_phone as string) ?? null,
    emergencyRelation: (r.emergency_relation as string) ?? null,
    preferredLanguage: r.preferred_language as string,
    contactChannel: r.contact_channel as string,
    allowReminders: !!r.allow_reminders,
    allowMarketing: !!r.allow_marketing,
    primaryPractitionerId: (r.primary_practitioner_id as number) ?? null,
    adminNotes: (r.admin_notes as string) ?? null,
    createdAt: r.created_at as string,
  };
}

function findDuplicates(user: AuthUser, phone: string, altPhone: string | null, excludeId: number | null) {
  const numbers = [normalizePhone(phone), normalizePhone(altPhone)].filter((n) => n.length >= 7);
  if (!numbers.length) return [];
  const ph = numbers.map(() => '?').join(',');
  const scope = patientScopeSql(user);
  return all<Row>(
    `SELECT p.id, p.code, p.first_name, p.last_name, p.phone, p.dob FROM patients p
      WHERE (p.phone_normalized IN (${ph}) OR p.alt_phone_normalized IN (${ph})) AND p.id <> ? AND ${scope.sql}
      LIMIT 5`,
    [...numbers, ...numbers, excludeId ?? 0, ...scope.params],
  ).map((r) => ({ id: r.id, code: r.code, fullName: `${r.first_name} ${r.last_name}`, phone: r.phone, dob: r.dob }));
}

patientsRouter.get('/', requirePerm('patients.view'), (req, res) => {
  const user = req.user!;
  const { page, pageSize, offset } = pageParams(req.query);
  const q = optStr(req.query.q);
  const filter = optStr(req.query.filter);
  const scope = patientScopeSql(user);
  const where = [scope.sql];
  const params: unknown[] = [...scope.params];
  if (q) {
    const digits = q.replace(/\D/g, '');
    where.push(`(p.first_name || ' ' || p.last_name LIKE ? OR p.code LIKE ? OR p.email LIKE ?${digits.length >= 3 ? ' OR p.phone_normalized LIKE ? OR p.alt_phone_normalized LIKE ?' : ''})`);
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    if (digits.length >= 3) params.push(`%${normalizePhone(digits) || digits}%`, `%${digits}%`);
  }
  const today = clinicToday();
  if (filter === 'balance' && can(req, 'billing.view')) {
    where.push(`EXISTS (SELECT 1 FROM invoices i WHERE i.patient_id = p.id AND i.status = 'issued' AND (${INVOICE_BALANCE_SQL}) > 0)`);
  } else if (filter === 'package') {
    where.push(`EXISTS (SELECT 1 FROM purchased_packages pp WHERE pp.patient_id = p.id AND pp.status = 'active' AND pp.expiry_date >= ?)`);
    params.push(today);
  } else if (filter === 'mine' && user.practitionerId) {
    where.push('p.primary_practitioner_id = ?');
    params.push(user.practitionerId);
  }
  const whereSql = where.join(' AND ');
  const total = scalar<number>(`SELECT COUNT(*) FROM patients p WHERE ${whereSql}`, params);
  const nowUtc = nowIso();
  const rows = all<Row>(
    `SELECT p.*,
            (SELECT MAX(a.start_at) FROM appointments a WHERE a.patient_id = p.id AND a.status = 'completed') AS last_visit,
            (SELECT MIN(a.start_at) FROM appointments a WHERE a.patient_id = p.id AND a.start_at >= ? AND a.status IN ('booked','confirmed')) AS next_visit,
            (SELECT COALESCE(SUM(${INVOICE_BALANCE_SQL}), 0) FROM invoices i WHERE i.patient_id = p.id AND i.status = 'issued') AS outstanding,
            (SELECT COUNT(*) FROM purchased_packages pp WHERE pp.patient_id = p.id AND pp.status = 'active' AND pp.expiry_date >= ?) AS active_packages
       FROM patients p WHERE ${whereSql}
      ORDER BY p.last_name COLLATE NOCASE, p.first_name COLLATE NOCASE
      LIMIT ? OFFSET ?`,
    [nowUtc, today, ...params, pageSize, offset],
  );
  const showMoney = can(req, 'billing.view');
  res.json({
    items: rows.map((r) => ({
      ...mapPatient(r),
      lastVisit: r.last_visit ?? null,
      nextVisit: r.next_visit ?? null,
      outstanding: showMoney ? r.outstanding : null,
      activePackages: r.active_packages,
    })),
    total,
    page,
    pageSize,
  });
});

patientsRouter.get('/search', requirePerm('patients.view'), (req, res) => {
  const q = optStr(req.query.q);
  if (!q || q.length < 2) return void res.json({ items: [] });
  const scope = patientScopeSql(req.user!);
  const digits = q.replace(/\D/g, '');
  const rows = all<Row>(
    `SELECT p.id, p.code, p.first_name, p.last_name, p.phone, p.dob FROM patients p
      WHERE ${scope.sql} AND (p.first_name || ' ' || p.last_name LIKE ? OR p.code LIKE ?${digits.length >= 3 ? ' OR p.phone_normalized LIKE ?' : ''})
      ORDER BY p.first_name LIMIT 8`,
    [...scope.params, `%${q}%`, `%${q}%`, ...(digits.length >= 3 ? [`%${digits}%`] : [])],
  );
  res.json({ items: rows.map((r) => ({ id: r.id, code: r.code, fullName: `${r.first_name} ${r.last_name}`, phone: r.phone, dob: r.dob })) });
});

patientsRouter.get('/duplicates', requirePerm('patients.view'), (req, res) => {
  const phone = optStr(req.query.phone) ?? '';
  res.json({ items: findDuplicates(req.user!, phone, optStr(req.query.altPhone), Number(req.query.excludeId) || null) });
});

function patientParams(d: ReturnType<typeof patientSchema.parse>) {
  return [
    d.firstName,
    d.lastName,
    d.phone,
    normalizePhone(d.phone),
    d.altPhone,
    d.altPhone ? normalizePhone(d.altPhone) : null,
    d.email,
    d.dob,
    d.gender,
    d.address,
    d.emergencyName,
    d.emergencyPhone,
    d.emergencyRelation,
    d.preferredLanguage,
    d.contactChannel,
    d.allowReminders,
    d.allowMarketing,
    d.primaryPractitionerId,
    d.adminNotes,
  ];
}

patientsRouter.post('/', requirePerm('patients.edit'), (req, res) => {
  const user = req.user!;
  const d = validate(patientSchema, req.body);
  const dupes = findDuplicates(user, d.phone, d.altPhone, null);
  if (dupes.length && req.body.confirmDuplicate !== true) {
    throw conflict('POSSIBLE_DUPLICATE', 'A patient with this phone number already exists. Open the existing record, or confirm this is a different person.', {
      matches: dupes,
    });
  }
  const id = tx(() => {
    const n = (scalar<number>('SELECT COALESCE(MAX(id), 0) FROM patients') ?? 0) + 1;
    const now = nowIso();
    const r = run(
      `INSERT INTO patients(code, first_name, last_name, phone, phone_normalized, alt_phone, alt_phone_normalized, email, dob, gender, address,
         emergency_name, emergency_phone, emergency_relation, preferred_language, contact_channel, allow_reminders, allow_marketing,
         primary_practitioner_id, admin_notes, created_at, created_by, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [`P-${String(n).padStart(5, '0')}`, ...patientParams(d), now, user.id, now],
    );
    audit(user, 'patient.create', { entityType: 'patient', entityId: r.id, patientId: r.id, summary: 'Patient record created', meta: { duplicateConfirmed: dupes.length > 0 } });
    return r.id;
  });
  res.status(201).json({ id });
});

patientsRouter.put('/:id', requirePerm('patients.edit'), (req, res) => {
  const id = intParam(req.params.id);
  const user = assertPatientAccess(req, id);
  const d = validate(patientSchema, req.body);
  const dupes = findDuplicates(user, d.phone, d.altPhone, id);
  if (dupes.length && req.body.confirmDuplicate !== true) {
    throw conflict('POSSIBLE_DUPLICATE', 'Another patient already uses this phone number. Confirm this is a different person to save.', { matches: dupes });
  }
  run(
    `UPDATE patients SET first_name=?, last_name=?, phone=?, phone_normalized=?, alt_phone=?, alt_phone_normalized=?, email=?, dob=?, gender=?, address=?,
       emergency_name=?, emergency_phone=?, emergency_relation=?, preferred_language=?, contact_channel=?, allow_reminders=?, allow_marketing=?,
       primary_practitioner_id=?, admin_notes=?, updated_at=? WHERE id = ?`,
    [...patientParams(d), nowIso(), id],
  );
  audit(user, 'patient.update', { entityType: 'patient', entityId: id, patientId: id, summary: 'Contact details updated' });
  res.json({ ok: true });
});

function consentSummary(patientId: number) {
  const rows = all<{ type: string; status: string; recorded_at: string }>(
    `SELECT type, status, recorded_at FROM consents WHERE patient_id = ? AND id IN (SELECT MAX(id) FROM consents WHERE patient_id = ? GROUP BY type)`,
    [patientId, patientId],
  );
  const by = Object.fromEntries(rows.map((r) => [r.type, { status: r.status, recordedAt: r.recorded_at }]));
  return {
    treatment: by.treatment ?? null,
    clinical_photography: by.clinical_photography ?? null,
    marketing_photography: by.marketing_photography ?? null,
    data_processing: by.data_processing ?? null,
  };
}

function recentActivity(patientId: number) {
  const events = all<Row>(
    `SELECT e.created_at AS at, e.kind, e.to_status, s.name_en AS service_en, s.name_ar AS service_ar, a.start_at, u.name AS by_name
       FROM appointment_events e JOIN appointments a ON a.id = e.appointment_id JOIN services s ON s.id = a.service_id
       LEFT JOIN users u ON u.id = e.created_by
      WHERE a.patient_id = ? ORDER BY e.id DESC LIMIT 12`,
    [patientId],
  ).map((r) => ({ at: r.at, type: r.kind === 'status' ? `appointment.${r.to_status}` : `appointment.${r.kind}`, serviceEn: r.service_en, serviceAr: r.service_ar, startAt: r.start_at, by: r.by_name }));
  const payments = all<Row>(
    `SELECT p.received_at AS at, p.amount, p.number, u.name AS by_name FROM payments p LEFT JOIN users u ON u.id = p.received_by WHERE p.patient_id = ? ORDER BY p.id DESC LIMIT 6`,
    [patientId],
  ).map((r) => ({ at: r.at, type: 'payment', amount: r.amount, number: r.number, by: r.by_name }));
  const packages = all<Row>(
    `SELECT pp.created_at AS at, pp.name_en, pp.name_ar, u.name AS by_name FROM purchased_packages pp LEFT JOIN users u ON u.id = pp.created_by WHERE pp.patient_id = ? ORDER BY pp.id DESC LIMIT 4`,
    [patientId],
  ).map((r) => ({ at: r.at, type: 'package', nameEn: r.name_en, nameAr: r.name_ar, by: r.by_name }));
  return [...events, ...payments, ...packages].sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 12);
}

export function patientAlerts(patientId: number) {
  const m = get<{ data: string }>('SELECT data FROM patient_medical WHERE patient_id = ?', [patientId]);
  if (!m) return { alerts: [], allergies: null, precautions: null, pregnant: 'unknown' };
  const d = parseJson<Row>(m.data, {});
  return {
    alerts: (d.alerts as unknown[]) ?? [],
    allergies: (d.allergies as string) ?? null,
    precautions: (d.precautions as string) ?? null,
    pregnant: (d.pregnant as string) ?? 'unknown',
  };
}

patientsRouter.get('/:id', (req, res) => {
  const id = intParam(req.params.id);
  assertPatientAccess(req, id);
  const p = get<Row>('SELECT * FROM patients WHERE id = ?', [id])!;
  const today = clinicToday();
  const next = get<Row>(
    `SELECT a.id, a.start_at, a.status, s.name_en, s.name_ar, pr.display_name, pr.display_name_ar
       FROM appointments a JOIN services s ON s.id = a.service_id JOIN practitioners pr ON pr.id = a.practitioner_id
      WHERE a.patient_id = ? AND a.start_at >= ? AND a.status IN ('booked','confirmed','arrived','in_treatment') ORDER BY a.start_at LIMIT 1`,
    [id, nowIso()],
  );
  const packages = can(req, 'packages.view') ? patientPackages(id, today) : null;
  const clinical = can(req, 'medical.view');
  if (clinical) audit(req.user, 'patient.alerts_view', { entityType: 'patient', entityId: id, patientId: id, summary: 'Clinical alerts viewed on overview', sensitive: true });
  res.json({
    patient: mapPatient(p),
    nextAppointment: next ? camel(next) : null,
    packages: packages
      ? packages.map((x) => ({ id: x.id, nameEn: x.nameEn, nameAr: x.nameAr, state: x.state, remainingSessions: x.remainingSessions, totalSessions: x.totalSessions, expiryDate: x.expiryDate, balance: x.balance }))
      : null,
    outstanding: can(req, 'billing.view') ? patientOutstanding(id) : null,
    clinical: clinical ? patientAlerts(id) : null,
    consents: can(req, 'consents.view') ? consentSummary(id) : null,
    activity: recentActivity(id),
    stats: {
      completedVisits: scalar<number>("SELECT COUNT(*) FROM appointments WHERE patient_id = ? AND status = 'completed'", [id]),
      noShows: scalar<number>("SELECT COUNT(*) FROM appointments WHERE patient_id = ? AND status = 'no_show'", [id]),
      cancellations: scalar<number>("SELECT COUNT(*) FROM appointments WHERE patient_id = ? AND status = 'cancelled'", [id]),
    },
  });
});

patientsRouter.get('/:id/medical', requirePerm('medical.view'), (req, res) => {
  const id = intParam(req.params.id);
  const user = assertPatientAccess(req, id);
  const m = get<Row>('SELECT m.*, u.name AS updated_by_name FROM patient_medical m LEFT JOIN users u ON u.id = m.updated_by WHERE m.patient_id = ?', [id]);
  audit(user, 'medical.view', { entityType: 'patient', entityId: id, patientId: id, summary: 'Medical history viewed', sensitive: true });
  res.json({
    data: m ? parseJson(m.data, {}) : null,
    version: m ? m.version : 0,
    updatedAt: m?.updated_at ?? null,
    updatedBy: m?.updated_by_name ?? null,
  });
});

patientsRouter.put('/:id/medical', requirePerm('medical.edit'), (req, res) => {
  const id = intParam(req.params.id);
  const user = assertPatientAccess(req, id);
  const data = validate(medicalSchema, req.body?.data);
  const expectedVersion = Number(req.body?.version ?? 0);
  tx(() => {
    const cur = get<{ data: string; version: number; updated_by: number; updated_at: string }>('SELECT * FROM patient_medical WHERE patient_id = ?', [id]);
    if ((cur?.version ?? 0) !== expectedVersion) {
      throw conflict('STALE_RECORD', 'Someone else updated this medical record while you were editing. Reload to see their changes.');
    }
    const now = nowIso();
    const alerts = data.alerts.map((a, i) => ({ id: i + 1, ...a }));
    if (cur) {
      run('INSERT INTO patient_medical_versions(patient_id, version, data, author_id, created_at) VALUES (?,?,?,?,?)', [id, cur.version, cur.data, cur.updated_by, cur.updated_at]);
      run('UPDATE patient_medical SET data = ?, version = version + 1, updated_at = ?, updated_by = ? WHERE patient_id = ?', [JSON.stringify({ ...data, alerts }), now, user.id, id]);
    } else {
      run('INSERT INTO patient_medical(patient_id, data, version, updated_at, updated_by) VALUES (?,?,1,?,?)', [id, JSON.stringify({ ...data, alerts }), now, user.id]);
    }
    audit(user, 'medical.update', { entityType: 'patient', entityId: id, patientId: id, summary: 'Medical history updated', sensitive: true });
  });
  res.json({ ok: true });
});

patientsRouter.get('/:id/medical/versions', requirePerm('medical.view'), (req, res) => {
  const id = intParam(req.params.id);
  assertPatientAccess(req, id);
  const rows = all<Row>(
    'SELECT v.version, v.data, v.created_at, u.name AS author FROM patient_medical_versions v LEFT JOIN users u ON u.id = v.author_id WHERE v.patient_id = ? ORDER BY v.version DESC',
    [id],
  );
  res.json({ items: rows.map((r) => ({ version: r.version, data: parseJson(r.data, {}), createdAt: r.created_at, author: r.author })) });
});

patientsRouter.get('/:id/appointments', requirePerm('appointments.view'), (req, res) => {
  const id = intParam(req.params.id);
  assertPatientAccess(req, id);
  const rows = all<Row>(
    `SELECT a.*, s.deposit_amount FROM appointments a JOIN services s ON s.id = a.service_id WHERE a.patient_id = ? ORDER BY a.start_at DESC`,
    [id],
  );
  const showMoney = can(req, 'billing.view');
  res.json({
    items: rows.map((r) => ({
      ...camel(r),
      payment: showMoney ? appointmentPaymentState({ id: r.id as number, purchased_package_id: r.purchased_package_id as number | null, deposit_amount: r.deposit_amount as number, status: r.status as string }) : null,
    })),
  });
});

function sessionRows(req: Request, where: string, params: unknown[]) {
  const clinical = can(req, 'clinical_notes.view');
  const rows = all<Row>(
    `SELECT t.*, a.start_at, u.name AS completed_by_name, pp.name_en AS package_en, pp.name_ar AS package_ar
       FROM treatment_sessions t JOIN appointments a ON a.id = t.appointment_id
       LEFT JOIN users u ON u.id = t.completed_by LEFT JOIN purchased_packages pp ON pp.id = t.purchased_package_id
      WHERE ${where} ORDER BY a.start_at DESC`,
    params,
  );
  return rows.map((r) => {
    const base = {
      id: r.id,
      appointmentId: r.appointment_id,
      patientId: r.patient_id,
      practitionerId: r.practitioner_id,
      serviceId: r.service_id,
      status: r.status,
      startAt: r.start_at,
      completedAt: r.completed_at,
      completedBy: r.completed_by_name,
      packageEn: r.package_en,
      packageAr: r.package_ar,
      reversedAt: r.reversed_at,
      reversalReason: r.reversal_reason,
    };
    if (!clinical) return { ...base, restricted: true };
    return {
      ...base,
      restricted: false,
      bodyAreas: parseJson(r.body_areas, []),
      assessment: r.assessment,
      treatmentNotes: r.treatment_notes,
      deviceId: r.device_id,
      deviceSettings: parseJson(r.device_settings, []),
      aftercare: r.aftercare,
      followUpPlan: r.follow_up_plan,
      followUpDate: r.follow_up_date,
      treatmentPlanId: r.treatment_plan_id,
      consumables: all<Row>(
        'SELECT c.quantity, i.name, i.unit, b.batch_number FROM session_consumables c JOIN inventory_items i ON i.id = c.item_id JOIN inventory_batches b ON b.id = c.batch_id WHERE c.session_id = ?',
        [r.id],
      ).map((c) => camel(c)),
      amendments: sessionAmendments(r.id as number),
    };
  });
}

patientsRouter.get('/:id/sessions', (req, res) => {
  const id = intParam(req.params.id);
  const user = assertPatientAccess(req, id);
  assertPerm(req, 'appointments.view');
  const items = sessionRows(req, 't.patient_id = ?', [id]);
  if (can(req, 'clinical_notes.view')) audit(user, 'clinical_notes.view', { entityType: 'patient', entityId: id, patientId: id, summary: 'Treatment records viewed', sensitive: true });
  const plans = can(req, 'clinical_notes.view')
    ? all<Row>('SELECT tp.*, u.name AS created_by_name FROM treatment_plans tp LEFT JOIN users u ON u.id = tp.created_by WHERE tp.patient_id = ? ORDER BY tp.created_at DESC', [id]).map((r) => ({
        ...camel(r),
        bodyAreas: parseJson(r.body_areas, []),
        completedSessions: scalar<number>("SELECT COUNT(*) FROM treatment_sessions WHERE treatment_plan_id = ? AND status = 'completed'", [r.id]),
      }))
    : null;
  res.json({ items, plans });
});

patientsRouter.post('/:id/plans', requirePerm('clinical_notes.edit'), (req, res) => {
  const id = intParam(req.params.id);
  const user = assertPatientAccess(req, id);
  const d = validate(treatmentPlanSchema, req.body);
  const now = nowIso();
  const r = run(
    `INSERT INTO treatment_plans(patient_id, title, service_id, body_areas, planned_sessions, interval_weeks, goals, notes, status, created_by, created_at, updated_by, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, d.title, d.serviceId, JSON.stringify(d.bodyAreas), d.plannedSessions, d.intervalWeeks, d.goals, d.notes, d.status, user.id, now, user.id, now],
  );
  audit(user, 'plan.create', { entityType: 'treatment_plan', entityId: r.id, patientId: id, summary: 'Treatment plan created', sensitive: true });
  res.status(201).json({ id: r.id });
});

patientsRouter.put('/:id/plans/:planId', requirePerm('clinical_notes.edit'), (req, res) => {
  const id = intParam(req.params.id);
  const planId = intParam(req.params.planId);
  const user = assertPatientAccess(req, id);
  const d = validate(treatmentPlanSchema, req.body);
  const r = run(
    `UPDATE treatment_plans SET title=?, service_id=?, body_areas=?, planned_sessions=?, interval_weeks=?, goals=?, notes=?, status=?, updated_by=?, updated_at=?
      WHERE id = ? AND patient_id = ?`,
    [d.title, d.serviceId, JSON.stringify(d.bodyAreas), d.plannedSessions, d.intervalWeeks, d.goals, d.notes, d.status, user.id, nowIso(), planId, id],
  );
  if (!r.changes) throw conflict('NOT_FOUND', 'Treatment plan not found.');
  audit(user, 'plan.update', { entityType: 'treatment_plan', entityId: planId, patientId: id, summary: 'Treatment plan updated', sensitive: true });
  res.json({ ok: true });
});

patientsRouter.get('/:id/packages', requirePerm('packages.view'), (req, res) => {
  const id = intParam(req.params.id);
  assertPatientAccess(req, id);
  const items = patientPackages(id, clinicToday()).map((p) => ({
    ...p,
    ledger: all<Row>(
      `SELECT u.id, u.service_id, u.delta, u.kind, u.session_id, u.appointment_id, u.reason, u.created_at, us.name AS by_name, a.start_at
         FROM package_usage u LEFT JOIN users us ON us.id = u.created_by LEFT JOIN appointments a ON a.id = u.appointment_id
        WHERE u.purchased_package_id = ? ORDER BY u.id DESC`,
      [p.id],
    ).map((r) => camel(r)),
  }));
  res.json({ items });
});

patientsRouter.get('/:id/billing', requirePerm('billing.view'), (req, res) => {
  const id = intParam(req.params.id);
  assertPatientAccess(req, id);
  const invoices = all<Row>(
    `SELECT i.*, (${INVOICE_BALANCE_SQL}) AS balance,
            COALESCE((SELECT SUM(amount) FROM payments WHERE invoice_id = i.id), 0) - COALESCE((SELECT SUM(amount) FROM refunds WHERE invoice_id = i.id), 0) AS net_paid
       FROM invoices i WHERE i.patient_id = ? ORDER BY i.id DESC`,
    [id],
  ).map((r) => ({ ...camel(r), balance: r.status === 'void' ? 0 : r.balance }));
  const payments = all<Row>(
    `SELECT p.*, i.number AS invoice_number, u.name AS received_by_name,
            COALESCE((SELECT SUM(amount) FROM refunds WHERE payment_id = p.id), 0) AS refunded
       FROM payments p JOIN invoices i ON i.id = p.invoice_id LEFT JOIN users u ON u.id = p.received_by
      WHERE p.patient_id = ? ORDER BY p.id DESC`,
    [id],
  ).map((r) => camel(r));
  const refunds = all<Row>(
    `SELECT r.*, p.number AS payment_number, u.name AS created_by_name FROM refunds r JOIN payments p ON p.id = r.payment_id LEFT JOIN users u ON u.id = r.created_by
      WHERE r.patient_id = ? ORDER BY r.id DESC`,
    [id],
  ).map((r) => camel(r));
  res.json({ invoices, payments, refunds, outstanding: patientOutstanding(id) });
});

patientsRouter.get('/:id/communications', requirePerm('followup.view'), (req, res) => {
  const id = intParam(req.params.id);
  assertPatientAccess(req, id);
  const rows = all<Row>(
    'SELECT c.*, u.name AS created_by_name FROM communications c LEFT JOIN users u ON u.id = c.created_by WHERE c.patient_id = ? ORDER BY c.id DESC LIMIT 50',
    [id],
  );
  res.json({ items: rows.map((r) => camel(r)) });
});

export function localDateOf(iso: string): string {
  return zonedParts(iso, clinicTz()).date;
}
