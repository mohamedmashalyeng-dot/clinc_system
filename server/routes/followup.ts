import { Router } from 'express';
import { all, camel, get, nowIso, run } from '../db/db.js';
import { assertPatientAccess, can, patientScopeSql, requirePerm } from '../auth.js';
import { audit } from '../audit.js';
import { forbidden, intParam, notFound, optStr, validate } from '../http.js';
import { clinicToday, getSettings } from '../settings.js';
import { communicationLogSchema, followUpUpdateSchema, messageTemplateSchema } from '../../shared/schemas.js';
import { addDays, rangeBoundsUtc } from '../../shared/time.js';

export const followupRouter = Router();
type Row = Record<string, unknown>;

const lastContact = (column: 'follow_up_id' | 'appointment_id', id: number) =>
  get<Row>(`SELECT channel, outcome, created_at FROM communications WHERE ${column} = ? ORDER BY id DESC LIMIT 1`, [id]);

followupRouter.get('/due', requirePerm('followup.view'), (req, res) => {
  const today = clinicToday();
  const scope = patientScopeSql(req.user!);
  const status = optStr(req.query.status) ?? 'open';
  const until = optStr(req.query.until) ?? addDays(today, 14);
  const rows = all<Row>(
    `SELECT f.*, p.first_name, p.last_name, p.phone, p.code, p.contact_channel, p.allow_reminders, p.preferred_language,
            t.practitioner_id, u.name AS closed_by_name,
            (SELECT MIN(a.start_at) FROM appointments a WHERE a.patient_id = f.patient_id AND a.start_at >= ? AND a.status IN ('booked','confirmed')) AS next_visit
       FROM follow_ups f JOIN patients p ON p.id = f.patient_id LEFT JOIN treatment_sessions t ON t.id = f.session_id LEFT JOIN users u ON u.id = f.closed_by
      WHERE ${scope.sql} AND f.status = ? AND (? <> 'open' OR f.due_date <= ?)
      ORDER BY f.due_date ${status === 'open' ? 'ASC' : 'DESC'} LIMIT 200`,
    [nowIso(), ...scope.params, status, status, until],
  );
  res.json({
    items: rows.map((r) => ({
      ...camel(r),
      patientName: `${r.first_name} ${r.last_name}`,
      overdue: (r.due_date as string) < today,
      lastContact: lastContact('follow_up_id', r.id as number) ?? null,
    })),
  });
});

followupRouter.post('/due/:id', requirePerm('followup.manage'), (req, res) => {
  const id = intParam(req.params.id);
  const f = get<{ patient_id: number }>('SELECT patient_id FROM follow_ups WHERE id = ?', [id]);
  if (!f) throw notFound('Follow-up');
  const user = assertPatientAccess(req, f.patient_id);
  const d = validate(followUpUpdateSchema, req.body);
  run('UPDATE follow_ups SET status = ?, closed_by = ?, closed_at = ?, close_note = ? WHERE id = ?', [d.status, user.id, nowIso(), d.note, id]);
  audit(user, `followup.${d.status}`, { entityType: 'follow_up', entityId: id, patientId: f.patient_id });
  res.json({ ok: true });
});

followupRouter.get('/reminders', requirePerm('followup.view'), (req, res) => {
  const today = clinicToday();
  const from = optStr(req.query.from) ?? addDays(today, 1);
  const to = optStr(req.query.to) ?? addDays(from, 2);
  const b = rangeBoundsUtc(from, to, getSettings().timezone);
  const scope = patientScopeSql(req.user!);
  const rows = all<Row>(
    `SELECT a.id, a.start_at, a.status, a.service_id, a.practitioner_id, a.patient_id, p.first_name, p.last_name, p.phone, p.contact_channel, p.allow_reminders, p.preferred_language
       FROM appointments a JOIN patients p ON p.id = a.patient_id
      WHERE ${scope.sql} AND a.start_at >= ? AND a.start_at < ? AND a.status IN ('booked','confirmed') ORDER BY a.start_at`,
    [...scope.params, b.start, b.end],
  );
  res.json({ items: rows.map((r) => ({ ...camel(r), patientName: `${r.first_name} ${r.last_name}`, lastContact: lastContact('appointment_id', r.id as number) ?? null })) });
});

followupRouter.get('/integrations', requirePerm('followup.view'), (_req, res) => {
  res.json({ integrations: getSettings().integrations });
});

followupRouter.post('/communications', requirePerm('followup.manage'), (req, res) => {
  const d = validate(communicationLogSchema, req.body);
  const user = assertPatientAccess(req, d.patientId);
  const r = run(
    'INSERT INTO communications(patient_id, channel, template_id, follow_up_id, appointment_id, body, outcome, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    [d.patientId, d.channel, d.templateId, d.followUpId, d.appointmentId, d.body, d.outcome, user.id, nowIso()],
  );
  audit(user, 'communication.log', { entityType: 'communication', entityId: r.id, patientId: d.patientId, summary: `Contact logged (${d.channel}, ${d.outcome})` });
  res.status(201).json({ id: r.id });
});

// ---- Message templates ----------------------------------------------------

followupRouter.get('/templates', requirePerm('followup.view'), (_req, res) => {
  const rows = all<Row>(
    'SELECT t.*, u.name AS approved_by_name FROM message_templates t LEFT JOIN users u ON u.id = t.approved_by ORDER BY t.kind, t.name',
  );
  res.json({ items: rows.map((r) => ({ ...camel(r), active: !!r.active })) });
});

function saveTemplate(req: Parameters<typeof assertPatientAccess>[0], id: number | null) {
  const d = validate(messageTemplateSchema, req.body);
  const user = req.user!;
  // Aftercare wording is clinical advice: only a practitioner with approval rights may write or edit it.
  if (d.kind === 'aftercare' && !can(req, 'aftercare.approve')) {
    throw forbidden('Aftercare templates are clinical content and must be written or edited by a practitioner with approval permission.');
  }
  if (d.kind !== 'aftercare' && !can(req, 'templates.manage')) throw forbidden('Managing message templates requires the "templates.manage" permission.');
  const now = nowIso();
  const approvedBy = d.kind === 'aftercare' ? user.id : null;
  if (id) {
    const r = run('UPDATE message_templates SET kind=?, name=?, body_en=?, body_ar=?, active=?, approved_by=?, approved_at=?, updated_at=? WHERE id = ?', [
      d.kind,
      d.name,
      d.bodyEn,
      d.bodyAr,
      d.active,
      approvedBy,
      approvedBy ? now : null,
      now,
      id,
    ]);
    if (!r.changes) throw notFound('Template');
    audit(user, 'template.update', { entityType: 'message_template', entityId: id, summary: `Template "${d.name}" updated` });
    return id;
  }
  const r = run(
    'INSERT INTO message_templates(kind, name, body_en, body_ar, active, approved_by, approved_at, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    [d.kind, d.name, d.bodyEn, d.bodyAr, d.active, approvedBy, approvedBy ? now : null, user.id, now, now],
  );
  audit(user, 'template.create', { entityType: 'message_template', entityId: r.id, summary: `Template "${d.name}" created` });
  return r.id;
}

followupRouter.post('/templates', (req, res) => {
  res.status(201).json({ id: saveTemplate(req, null) });
});

followupRouter.put('/templates/:id', (req, res) => {
  const id = intParam(req.params.id);
  const cur = get<{ kind: string }>('SELECT kind FROM message_templates WHERE id = ?', [id]);
  if (!cur) throw notFound('Template');
  if (cur.kind === 'aftercare' && !can(req, 'aftercare.approve')) throw forbidden('Only a practitioner with approval permission can change aftercare templates.');
  res.json({ id: saveTemplate(req, id) });
});
