import express, { Router } from 'express';
import { all, camel, get, nowIso, parseJson, run, scalar } from '../db/db.js';
import { assertPatientAccess, assertPerm, can, patientScopeSql, requirePerm } from '../auth.js';
import { audit } from '../audit.js';
import { conflict, forbidden, intParam, notFound, validate } from '../http.js';
import { clinicToday, getSettings } from '../settings.js';
import {
  amendSessionSchema,
  completeSessionSchema,
  documentMetaSchema,
  photoMetaSchema,
  recordConsentSchema,
  reverseSessionSchema,
  sessionDraftSchema,
  voidSchema,
} from '../../shared/schemas.js';
import { CLINICAL_DOCUMENT_CATEGORIES } from '../../shared/domain.js';
import { activeConsentId, amendSession, completeSession, hasActiveConsent, reverseSession, saveDraft, sessionAmendments } from '../services/sessions.js';
import { eligiblePackages, packageSummary } from '../services/packages.js';
import { batchesForItems } from '../services/inventory.js';
import { getService } from '../services/reference.js';
import { sendPrivateFile, storePrivateFile } from '../files.js';
import { mapAppointment } from './appointments.js';
import { patientAlerts } from './patients.js';

export const clinicalRouter = Router();
type Row = Record<string, unknown>;

function mapSession(r: Row) {
  return {
    id: r.id as number,
    appointmentId: r.appointment_id as number,
    patientId: r.patient_id as number,
    practitionerId: r.practitioner_id as number,
    serviceId: r.service_id as number,
    status: r.status as string,
    bodyAreas: parseJson<string[]>(r.body_areas, []),
    assessment: (r.assessment as string) ?? null,
    treatmentNotes: (r.treatment_notes as string) ?? null,
    deviceId: (r.device_id as number) ?? null,
    deviceSettings: parseJson<{ label: string; value: string }[]>(r.device_settings, []),
    aftercare: (r.aftercare as string) ?? null,
    followUpPlan: (r.follow_up_plan as string) ?? null,
    followUpDate: (r.follow_up_date as string) ?? null,
    purchasedPackageId: (r.purchased_package_id as number) ?? null,
    treatmentPlanId: (r.treatment_plan_id as number) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
    updatedBy: (r.updated_by_name as string) ?? null,
    completedAt: (r.completed_at as string) ?? null,
    completedBy: (r.completed_by_name as string) ?? null,
    reversedAt: (r.reversed_at as string) ?? null,
    reversalReason: (r.reversal_reason as string) ?? null,
    consumables: all<Row>(
      `SELECT c.id, c.item_id, c.batch_id, c.quantity, i.name, i.unit, b.batch_number, b.expiry_date,
              (SELECT COUNT(*) FROM stock_movements m WHERE m.session_consumable_id = c.id AND m.type = 'usage') AS deducted
         FROM session_consumables c JOIN inventory_items i ON i.id = c.item_id JOIN inventory_batches b ON b.id = c.batch_id WHERE c.session_id = ?`,
      [r.id],
    ).map((c) => ({ ...camel(c), deducted: !!c.deducted })),
    amendments: sessionAmendments(r.id as number),
  };
}

const SESSION_SELECT = `SELECT t.*, uu.name AS updated_by_name, uc.name AS completed_by_name FROM treatment_sessions t
  LEFT JOIN users uu ON uu.id = t.updated_by LEFT JOIN users uc ON uc.id = t.completed_by`;

function consentState(patientId: number) {
  return {
    treatment: hasActiveConsent(patientId, 'treatment'),
    clinicalPhotography: hasActiveConsent(patientId, 'clinical_photography'),
    marketingPhotography: hasActiveConsent(patientId, 'marketing_photography'),
  };
}

clinicalRouter.get('/workspace/:appointmentId', requirePerm('treatment.perform', 'clinical_notes.view', 'medical.view'), (req, res) => {
  const appointmentId = intParam(req.params.appointmentId);
  const r = get<Row>(
    `SELECT a.*, p.first_name, p.last_name, p.phone, p.code AS patient_code, p.primary_practitioner_id, s.deposit_amount, pp.name_en AS package_en, pp.name_ar AS package_ar,
            (SELECT t.id FROM treatment_sessions t WHERE t.appointment_id = a.id AND t.status <> 'reversed') AS session_id,
            (SELECT t.status FROM treatment_sessions t WHERE t.appointment_id = a.id ORDER BY t.id DESC LIMIT 1) AS session_status
       FROM appointments a JOIN patients p ON p.id = a.patient_id JOIN services s ON s.id = a.service_id
       LEFT JOIN purchased_packages pp ON pp.id = a.purchased_package_id WHERE a.id = ?`,
    [appointmentId],
  );
  if (!r) throw notFound('Appointment');
  const user = assertPatientAccess(req, r.patient_id as number);
  const patientId = r.patient_id as number;
  const today = clinicToday();
  const settings = getSettings();
  const patient = get<Row>('SELECT id, code, first_name, last_name, dob, gender, phone FROM patients WHERE id = ?', [patientId])!;
  const medical = get<{ data: string }>('SELECT data FROM patient_medical WHERE patient_id = ?', [patientId]);
  const sessionRow = get<Row>(`${SESSION_SELECT} WHERE t.appointment_id = ? ORDER BY CASE WHEN t.status = 'reversed' THEN 1 ELSE 0 END, t.id DESC LIMIT 1`, [appointmentId]);
  const history = all<Row>(
    `${SESSION_SELECT} JOIN appointments a ON a.id = t.appointment_id WHERE t.patient_id = ? AND t.status = 'completed' AND t.appointment_id <> ?
      ORDER BY a.start_at DESC LIMIT 8`,
    [patientId, appointmentId],
  ).map((h) => ({ ...mapSession(h), startAt: get<{ start_at: string }>('SELECT start_at FROM appointments WHERE id = ?', [h.appointment_id])?.start_at }));
  const service = getService(r.service_id as number)!;
  const eligible = eligiblePackages(patientId, service.id, today).map((p) => ({
    id: p.id,
    nameEn: p.nameEn,
    nameAr: p.nameAr,
    expiryDate: p.expiryDate,
    remaining: p.items.find((i) => i.serviceId === service.id)?.remaining ?? 0,
  }));
  const linked = (sessionRow?.purchased_package_id ?? r.purchased_package_id) as number | null;
  if (linked && !eligible.some((p) => p.id === linked)) {
    const s = packageSummary(linked, today);
    if (s) eligible.push({ id: s.id, nameEn: s.nameEn, nameAr: s.nameAr, expiryDate: s.expiryDate, remaining: s.items.find((i) => i.serviceId === service.id)?.remaining ?? 0 });
  }
  const items = all<Row>('SELECT id, sku, name, unit, category FROM inventory_items WHERE active = 1 ORDER BY name');
  const batches = batchesForItems(today, settings.expiryWarningDays);
  audit(user, 'workspace.open', { entityType: 'appointment', entityId: appointmentId, patientId, summary: 'Treatment workspace opened', sensitive: true });
  res.json({
    appointment: mapAppointment(req, r),
    patient: camel(patient),
    medical: medical ? parseJson(medical.data, {}) : null,
    alerts: patientAlerts(patientId),
    consents: consentState(patientId),
    session: sessionRow ? mapSession(sessionRow) : null,
    history,
    packages: eligible,
    plans: all<Row>("SELECT id, title, planned_sessions, status FROM treatment_plans WHERE patient_id = ? AND status = 'active'", [patientId]).map((p) => camel(p)),
    inventory: items.map((i) => ({ ...camel(i), batches: batches.filter((b) => b.itemId === i.id && (b.onHand > 0 || b.expired)) })),
    photos: sessionRow
      ? all<Row>('SELECT id, body_area, kind, taken_on, notes, mime FROM photos WHERE session_id = ? ORDER BY id', [sessionRow.id]).map((p) => camel(p))
      : [],
    aftercareTemplates: all<Row>("SELECT id, name, body_en, body_ar FROM message_templates WHERE kind = 'aftercare' AND active = 1 AND approved_by IS NOT NULL ORDER BY name").map((t) =>
      camel(t),
    ),
    canOverrideStock: can(req, 'inventory.override'),
  });
});

clinicalRouter.get('/sessions/:id', requirePerm('clinical_notes.view'), (req, res) => {
  const id = intParam(req.params.id);
  const r = get<Row>(`${SESSION_SELECT} WHERE t.id = ?`, [id]);
  if (!r) throw notFound('Session');
  const user = assertPatientAccess(req, r.patient_id as number);
  audit(user, 'clinical_notes.view', { entityType: 'session', entityId: id, patientId: r.patient_id as number, summary: `Session #${id} viewed`, sensitive: true });
  res.json({ session: mapSession(r) });
});

function sessionPatient(id: number): number {
  const pid = scalar<number | null>('SELECT patient_id FROM treatment_sessions WHERE id = ?', [id]);
  if (!pid) throw notFound('Session');
  return pid;
}

clinicalRouter.put('/sessions/:id', requirePerm('treatment.perform', 'clinical_notes.edit'), (req, res) => {
  const id = intParam(req.params.id);
  const user = assertPatientAccess(req, sessionPatient(id));
  saveDraft(user, id, validate(sessionDraftSchema, req.body));
  res.json({ ok: true });
});

clinicalRouter.post('/sessions/:id/complete', requirePerm('treatment.perform'), (req, res) => {
  const id = intParam(req.params.id);
  const user = assertPatientAccess(req, sessionPatient(id));
  const d = validate(completeSessionSchema, req.body);
  res.json(completeSession(user, id, { idempotencyKey: d.idempotencyKey, overrideReason: d.overrideReason }));
});

clinicalRouter.post('/sessions/:id/amend', requirePerm('clinical_notes.edit'), (req, res) => {
  const id = intParam(req.params.id);
  const user = assertPatientAccess(req, sessionPatient(id));
  const d = validate(amendSessionSchema, req.body);
  amendSession(user, id, d.reason, d.changes);
  res.json({ ok: true });
});

clinicalRouter.post('/sessions/:id/reverse', requirePerm('sessions.reverse'), (req, res) => {
  const id = intParam(req.params.id);
  const user = assertPatientAccess(req, sessionPatient(id));
  const d = validate(reverseSessionSchema, req.body);
  res.json(reverseSession(user, id, d.reason, d.restock));
});

// ---- Photos ---------------------------------------------------------------

clinicalRouter.get('/patients/:id/photos', requirePerm('photos.view'), (req, res) => {
  const id = intParam(req.params.id);
  const user = assertPatientAccess(req, id);
  const rows = all<Row>(
    `SELECT ph.id, ph.session_id, ph.body_area, ph.kind, ph.taken_on, ph.notes, ph.mime, ph.size, ph.sha256, ph.uploaded_at, u.name AS uploaded_by_name,
            t.service_id
       FROM photos ph LEFT JOIN users u ON u.id = ph.uploaded_by LEFT JOIN treatment_sessions t ON t.id = ph.session_id
      WHERE ph.patient_id = ? ORDER BY ph.taken_on DESC, ph.id`,
    [id],
  );
  audit(user, 'photos.view', { entityType: 'patient', entityId: id, patientId: id, summary: `Clinical photo gallery viewed (${rows.length} images)`, sensitive: true });
  res.json({ items: rows.map((r) => camel(r)), consents: consentState(id) });
});

clinicalRouter.post(
  '/patients/:id/photos',
  requirePerm('photos.upload'),
  express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: '12mb' }),
  (req, res) => {
    const id = intParam(req.params.id);
    const user = assertPatientAccess(req, id);
    const meta = validate(photoMetaSchema, {
      bodyArea: req.query.bodyArea,
      kind: req.query.kind,
      takenOn: req.query.takenOn,
      sessionId: req.query.sessionId ? Number(req.query.sessionId) : null,
      notes: typeof req.query.notes === 'string' ? req.query.notes : null,
    });
    const consentId = activeConsentId(id, 'clinical_photography');
    if (!consentId) throw conflict('PHOTO_CONSENT_MISSING', 'Record the patient’s clinical photography consent before taking or uploading photos.');
    if (meta.sessionId && scalar<number>('SELECT patient_id FROM treatment_sessions WHERE id = ?', [meta.sessionId]) !== id) {
      throw conflict('SESSION_MISMATCH', 'That session belongs to another patient.');
    }
    const f = storePrivateFile(req.body as Buffer, ['image/jpeg', 'image/png', 'image/webp'], 'photos');
    const r = run(
      `INSERT INTO photos(patient_id, session_id, body_area, kind, taken_on, file_name, mime, size, sha256, notes, consent_id, uploaded_by, uploaded_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, meta.sessionId, meta.bodyArea, meta.kind, meta.takenOn, f.fileName, f.mime, f.size, f.sha256, meta.notes, consentId, user.id, nowIso()],
    );
    audit(user, 'photo.upload', { entityType: 'photo', entityId: r.id, patientId: id, summary: 'Clinical photo uploaded', sensitive: true });
    res.status(201).json({ id: r.id });
  },
);

clinicalRouter.get('/photos/patients', requirePerm('photos.view'), (req, res) => {
  const scope = patientScopeSql(req.user!);
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const rows = all<Row>(
    `SELECT p.id, p.code, p.first_name, p.last_name, COUNT(ph.id) AS photos, MAX(ph.taken_on) AS last_taken, GROUP_CONCAT(DISTINCT ph.body_area) AS areas
       FROM photos ph JOIN patients p ON p.id = ph.patient_id
      WHERE ${scope.sql} ${q ? "AND (p.first_name || ' ' || p.last_name LIKE ? OR p.code LIKE ?)" : ''}
      GROUP BY p.id ORDER BY last_taken DESC LIMIT 200`,
    [...scope.params, ...(q ? [`%${q}%`, `%${q}%`] : [])],
  );
  res.json({
    items: rows.map((r) => ({ id: r.id, code: r.code, fullName: `${r.first_name} ${r.last_name}`, photos: r.photos, lastTaken: r.last_taken, areas: String(r.areas ?? '').split(',').filter(Boolean) })),
  });
});

clinicalRouter.get('/photos/:id/file', requirePerm('photos.view'), (req, res) => {
  const id = intParam(req.params.id);
  const p = get<{ patient_id: number; file_name: string; mime: string }>('SELECT patient_id, file_name, mime FROM photos WHERE id = ?', [id]);
  if (!p) throw notFound('Photo');
  assertPatientAccess(req, p.patient_id);
  sendPrivateFile(res, p.file_name, p.mime);
});

// ---- Documents --------------------------------------------------------------

clinicalRouter.get('/patients/:id/documents', requirePerm('patients.view'), (req, res) => {
  const id = intParam(req.params.id);
  assertPatientAccess(req, id);
  const clinical = can(req, 'clinical_documents.view');
  const rows = all<Row>(
    'SELECT d.id, d.title, d.category, d.clinical, d.mime, d.size, d.uploaded_at, u.name AS uploaded_by_name FROM documents d LEFT JOIN users u ON u.id = d.uploaded_by WHERE d.patient_id = ? ORDER BY d.id DESC',
    [id],
  );
  res.json({
    items: rows.filter((r) => clinical || !r.clinical).map((r) => ({ ...camel(r), clinical: !!r.clinical })),
    restrictedCount: clinical ? 0 : rows.filter((r) => r.clinical).length,
  });
});

clinicalRouter.post('/patients/:id/documents', express.raw({ type: ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'], limit: '12mb' }), (req, res) => {
  const id = intParam(req.params.id);
  const meta = validate(documentMetaSchema, { title: req.query.title, category: req.query.category });
  const clinical = CLINICAL_DOCUMENT_CATEGORIES.includes(meta.category);
  const user = clinical ? assertPerm(req, 'clinical_documents.view', 'medical.edit') : assertPerm(req, 'patients.edit');
  assertPatientAccess(req, id);
  const f = storePrivateFile(req.body as Buffer, ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'], 'documents');
  const r = run(
    'INSERT INTO documents(patient_id, title, category, clinical, file_name, original_name, mime, size, sha256, uploaded_by, uploaded_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    [id, meta.title, meta.category, clinical, f.fileName, typeof req.query.fileName === 'string' ? req.query.fileName.slice(0, 150) : null, f.mime, f.size, f.sha256, user.id, nowIso()],
  );
  audit(user, 'document.upload', { entityType: 'document', entityId: r.id, patientId: id, summary: `Document uploaded (${meta.category})`, sensitive: clinical });
  res.status(201).json({ id: r.id });
});

clinicalRouter.get('/documents/:id/file', requirePerm('patients.view'), (req, res) => {
  const id = intParam(req.params.id);
  const d = get<{ patient_id: number; file_name: string; mime: string; clinical: number; title: string }>('SELECT patient_id, file_name, mime, clinical, title FROM documents WHERE id = ?', [id]);
  if (!d) throw notFound('Document');
  const user = assertPatientAccess(req, d.patient_id);
  if (d.clinical && !can(req, 'clinical_documents.view')) throw forbidden('This document is clinical and requires clinical document permission.');
  if (d.clinical) audit(user, 'document.view', { entityType: 'document', entityId: id, patientId: d.patient_id, summary: 'Clinical document opened', sensitive: true });
  sendPrivateFile(res, d.file_name, d.mime);
});

// ---- Consents ---------------------------------------------------------------

clinicalRouter.get('/patients/:id/consents', requirePerm('consents.view'), (req, res) => {
  const id = intParam(req.params.id);
  assertPatientAccess(req, id);
  const rows = all<Row>(
    `SELECT c.*, ur.name AS recorded_by_name, uw.name AS withdrawn_by_name FROM consents c
       LEFT JOIN users ur ON ur.id = c.recorded_by LEFT JOIN users uw ON uw.id = c.withdrawn_by
      WHERE c.patient_id = ? ORDER BY c.id DESC`,
    [id],
  );
  res.json({ items: rows.map((r) => camel(r)), state: consentState(id) });
});

clinicalRouter.post('/patients/:id/consents', requirePerm('consents.manage'), (req, res) => {
  const id = intParam(req.params.id);
  const user = assertPatientAccess(req, id);
  const d = validate(recordConsentSchema, req.body);
  const t = get<Row>('SELECT * FROM consent_templates WHERE id = ? AND active = 1', [d.templateId]);
  if (!t) throw notFound('Consent template');
  const r = run(
    `INSERT INTO consents(patient_id, template_id, type, template_version, title_en, title_ar, status, method, notes, recorded_by, recorded_at)
     VALUES (?,?,?,?,?,?, 'granted', ?,?,?,?)`,
    [id, t.id, t.type, t.version, t.title_en, t.title_ar, d.method, d.notes, user.id, nowIso()],
  );
  audit(user, 'consent.record', { entityType: 'consent', entityId: r.id, patientId: id, summary: `Consent recorded: ${t.type}` });
  res.status(201).json({ id: r.id });
});

clinicalRouter.post('/consents/:id/withdraw', requirePerm('consents.manage'), (req, res) => {
  const id = intParam(req.params.id);
  const c = get<{ patient_id: number; status: string; type: string }>('SELECT patient_id, status, type FROM consents WHERE id = ?', [id]);
  if (!c) throw notFound('Consent');
  const user = assertPatientAccess(req, c.patient_id);
  if (c.status === 'withdrawn') return void res.json({ ok: true });
  const d = validate(voidSchema, req.body);
  run("UPDATE consents SET status = 'withdrawn', withdrawn_by = ?, withdrawn_at = ?, withdraw_reason = ? WHERE id = ?", [user.id, nowIso(), d.reason, id]);
  audit(user, 'consent.withdraw', { entityType: 'consent', entityId: id, patientId: c.patient_id, summary: `Consent withdrawn: ${c.type}` });
  res.json({ ok: true });
});
