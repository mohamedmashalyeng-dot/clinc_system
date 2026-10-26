import { Router, type Request } from 'express';
import { all, get, nowIso, run, tx } from '../db/db.js';
import { can, requirePerm } from '../auth.js';
import { audit } from '../audit.js';
import { conflict, intParam, notFound, optInt, optStr, validate } from '../http.js';
import { getSettings } from '../settings.js';
import { timeOffCancelSchema, timeOffSchema } from '../../shared/schemas.js';
import { addDays, rangeBoundsUtc, zonedToUtc } from '../../shared/time.js';
import { getPractitioner } from '../services/reference.js';
import { timeOffLocal } from '../services/scheduling.js';
import { SELECT as APPOINTMENT_SELECT, mapAppointment } from './appointments.js';

export const timeOffRouter = Router();
type Row = Record<string, unknown>;

/** Bookings still to happen inside a period; time off never cancels them, staff reschedule them. */
function affectedAppointments(req: Request, practitionerId: number, startAt: string, endAt: string) {
  return all<Row>(`${APPOINTMENT_SELECT} WHERE a.practitioner_id = ? AND a.status IN ('booked','confirmed') AND a.start_at < ? AND a.end_at > ? ORDER BY a.start_at`, [
    practitionerId,
    endAt,
    startAt,
  ]).map((r) => mapAppointment(req, r));
}

const affectedCount = (r: Row) =>
  r.cancelled_at || (r.end_at as string) <= nowIso()
    ? 0
    : (get<{ n: number }>("SELECT COUNT(*) AS n FROM appointments WHERE practitioner_id = ? AND status IN ('booked','confirmed') AND start_at < ? AND end_at > ?", [r.practitioner_id, r.end_at, r.start_at])?.n ?? 0);

/** The reason for an absence is staff information: shown to schedulers and to the practitioner concerned only. */
function mapTimeOff(req: Request, r: Row) {
  const user = req.user!;
  const details = can(req, 'appointments.manage') || (!!user.practitionerId && r.practitioner_id === user.practitionerId);
  const local = timeOffLocal(r as { start_at: string; end_at: string; all_day: number }, getSettings().timezone);
  return {
    id: r.id as number,
    practitionerId: r.practitioner_id as number,
    kind: details ? (r.kind as string) : null,
    note: details ? ((r.note as string) ?? null) : null,
    allDay: !!r.all_day,
    startAt: r.start_at as string,
    endAt: r.end_at as string,
    ...local,
    status: r.cancelled_at ? ('cancelled' as const) : ('active' as const),
    createdByName: (r.created_by_name as string) ?? null,
    createdAt: r.created_at as string,
    cancelledAt: (r.cancelled_at as string) ?? null,
    cancelledByName: (r.cancelled_by_name as string) ?? null,
    cancelReason: details ? ((r.cancel_reason as string) ?? null) : null,
    affectedCount: affectedCount(r),
  };
}

const SELECT = `SELECT o.*, cu.name AS created_by_name, xu.name AS cancelled_by_name
  FROM practitioner_time_off o LEFT JOIN users cu ON cu.id = o.created_by LEFT JOIN users xu ON xu.id = o.cancelled_by`;

timeOffRouter.get('/', requirePerm('appointments.view'), (req, res) => {
  const where: string[] = ['1=1'];
  const params: unknown[] = [];
  const from = optStr(req.query.from);
  const to = optStr(req.query.to) ?? from;
  if (from && to) {
    const b = rangeBoundsUtc(from, to, getSettings().timezone);
    where.push('o.start_at < ? AND o.end_at > ?');
    params.push(b.end, b.start);
  } else if (req.query.past !== '1') {
    where.push('o.end_at > ?');
    params.push(nowIso());
  }
  if (req.query.includeCancelled !== '1') where.push('o.cancelled_at IS NULL');
  const practitionerId = optInt(req.query.practitionerId);
  if (practitionerId) {
    where.push('o.practitioner_id = ?');
    params.push(practitionerId);
  }
  const order = req.query.past === '1' && !from ? 'DESC' : 'ASC';
  const rows = all<Row>(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY o.start_at ${order} LIMIT 300`, params);
  res.json({ items: rows.map((r) => mapTimeOff(req, r)) });
});

timeOffRouter.get('/:id', requirePerm('appointments.view'), (req, res) => {
  const r = get<Row>(`${SELECT} WHERE o.id = ?`, [intParam(req.params.id)]);
  if (!r) throw notFound('Time off');
  const affected = r.cancelled_at ? [] : affectedAppointments(req, r.practitioner_id as number, r.start_at as string, r.end_at as string);
  res.json({ item: mapTimeOff(req, r), affected });
});

timeOffRouter.post('/', requirePerm('appointments.manage'), (req, res) => {
  const d = validate(timeOffSchema, req.body);
  const tz = getSettings().timezone;
  const practitioner = getPractitioner(d.practitionerId);
  if (!practitioner) throw notFound('Practitioner');
  const startAt = zonedToUtc(d.startDate, d.allDay ? '00:00' : d.startTime!, tz).toISOString();
  const endAt = (d.allDay ? zonedToUtc(addDays(d.endDate, 1), '00:00', tz) : zonedToUtc(d.startDate, d.endTime!, tz)).toISOString();
  const result = tx(() => {
    const overlap = get<{ id: number }>('SELECT id FROM practitioner_time_off WHERE practitioner_id = ? AND cancelled_at IS NULL AND start_at < ? AND end_at > ?', [
      d.practitionerId,
      endAt,
      startAt,
    ]);
    if (overlap) throw conflict('TIME_OFF_OVERLAP', `${practitioner.displayName} already has time off recorded in this period.`, { timeOffId: overlap.id });
    const affected = affectedAppointments(req, d.practitionerId, startAt, endAt);
    if (affected.length && !d.confirmAffected) {
      throw conflict('TIME_OFF_AFFECTS_BOOKINGS', `${affected.length} booked appointment(s) fall in this period. Confirm to record the time off, then reschedule them.`, { affected });
    }
    const r = run('INSERT INTO practitioner_time_off(practitioner_id, kind, start_at, end_at, all_day, note, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)', [
      d.practitionerId,
      d.kind,
      startAt,
      endAt,
      d.allDay,
      d.note,
      req.user!.id,
      nowIso(),
    ]);
    const period = `${d.startDate}${d.endDate !== d.startDate ? ` to ${d.endDate}` : ''}${d.allDay ? '' : ` ${d.startTime}–${d.endTime}`}`;
    audit(req.user, 'time_off.create', {
      entityType: 'practitioner_time_off',
      entityId: r.id,
      summary: `Time off recorded for ${practitioner.displayName} (${period})`,
      meta: { affectedAppointments: affected.map((a) => a.id) },
    });
    return { id: r.id, affected };
  });
  res.status(201).json(result);
});

timeOffRouter.post('/:id/cancel', requirePerm('appointments.manage'), (req, res) => {
  const id = intParam(req.params.id);
  const d = validate(timeOffCancelSchema, req.body);
  tx(() => {
    const cur = get<Row>('SELECT cancelled_at FROM practitioner_time_off WHERE id = ?', [id]);
    if (!cur) throw notFound('Time off');
    if (cur.cancelled_at) return; // already cancelled: a retry changes nothing
    run('UPDATE practitioner_time_off SET cancelled_at = ?, cancelled_by = ?, cancel_reason = ? WHERE id = ?', [nowIso(), req.user!.id, d.reason, id]);
    audit(req.user, 'time_off.cancel', { entityType: 'practitioner_time_off', entityId: id, summary: `Time off #${id} cancelled` });
  });
  res.json({ ok: true });
});
