import { Router } from 'express';
import { all, get, nowIso, run } from '../db/db.js';
import { assertPatientAccess, patientScopeSql, requirePerm, type AuthUser } from '../auth.js';
import { audit } from '../audit.js';
import { badRequest, conflict, intParam, notFound, optStr, validate } from '../http.js';
import { clinicToday, getSettings } from '../settings.js';
import { waitlistRemoveSchema, waitlistSchema } from '../../shared/schemas.js';
import { timeOfDayAccepts } from '../../shared/domain.js';
import { addDays, zonedParts } from '../../shared/time.js';
import { findFirstSlot, slotFits } from '../services/scheduling.js';
import { getPractitioner, getService } from '../services/reference.js';

export const waitlistRouter = Router();
type Row = Record<string, unknown>;

/** How far ahead the waitlist looks for the earliest free slot. */
const SEARCH_DAYS = 21;

const SELECT = `
  SELECT w.*, p.first_name, p.last_name, p.code, p.phone, u.name AS created_by_name, cu.name AS closed_by_name, a.start_at AS appointment_start
    FROM waitlist w
    JOIN patients p ON p.id = w.patient_id
    LEFT JOIN users u ON u.id = w.created_by
    LEFT JOIN users cu ON cu.id = w.closed_by
    LEFT JOIN appointments a ON a.id = w.appointment_id`;

function mapEntry(r: Row) {
  return {
    id: r.id as number,
    patientId: r.patient_id as number,
    patientName: `${r.first_name} ${r.last_name}`,
    patientCode: r.code as string,
    patientPhone: r.phone as string,
    serviceId: r.service_id as number,
    practitionerId: (r.practitioner_id as number) ?? null,
    earliestDate: r.earliest_date as string,
    latestDate: r.latest_date as string,
    timeOfDay: r.time_of_day as string,
    notes: (r.notes as string) ?? null,
    status: r.status as 'waiting' | 'booked' | 'removed',
    appointmentId: (r.appointment_id as number) ?? null,
    appointmentStart: (r.appointment_start as string) ?? null,
    createdAt: r.created_at as string,
    createdByName: (r.created_by_name as string) ?? null,
    closedAt: (r.closed_at as string) ?? null,
    closedByName: (r.closed_by_name as string) ?? null,
    closeReason: (r.close_reason as string) ?? null,
  };
}

waitlistRouter.get('/', requirePerm('appointments.view'), (req, res) => {
  const closed = optStr(req.query.status) === 'closed';
  const scope = patientScopeSql(req.user!);
  const today = clinicToday();
  const horizon = addDays(today, SEARCH_DAYS);
  const rows = all<Row>(
    `${SELECT} WHERE ${scope.sql} AND ${closed ? "w.status <> 'waiting'" : "w.status = 'waiting'"}
      ORDER BY ${closed ? 'w.closed_at DESC' : 'w.earliest_date, w.id'} LIMIT 200`,
    scope.params,
  );
  const items = rows.map((r) => {
    const e = mapEntry(r);
    if (e.status !== 'waiting') return { ...e, expired: false, slot: null };
    const expired = e.latestDate < today;
    const from = e.earliestDate > today ? e.earliestDate : today;
    const to = e.latestDate < horizon ? e.latestDate : horizon;
    const slot =
      !expired && from <= to
        ? findFirstSlot({ serviceId: e.serviceId, practitionerId: e.practitionerId, fromDate: from, toDate: to, patientId: e.patientId, accept: (time) => timeOfDayAccepts(e.timeOfDay, time) })
        : null;
    return { ...e, expired, slot };
  });
  res.json({ items, searchDays: SEARCH_DAYS });
});

/** Waiting patients who could take the time freed by a cancelled booking. */
waitlistRouter.get('/matches', requirePerm('appointments.view'), (req, res) => {
  const appointmentId = intParam(req.query.appointmentId, 'appointmentId');
  const a = get<Row>('SELECT * FROM appointments WHERE id = ?', [appointmentId]);
  if (!a) throw notFound('Appointment');
  if (a.status !== 'cancelled' || new Date(a.start_at as string).getTime() < Date.now()) return void res.json({ items: [] });
  const { date, time } = zonedParts(a.start_at as string, getSettings().timezone);
  const scope = patientScopeSql(req.user!);
  const rows = all<Row>(
    `${SELECT} WHERE ${scope.sql} AND w.status = 'waiting' AND w.earliest_date <= ? AND w.latest_date >= ?
        AND (w.practitioner_id IS NULL OR w.practitioner_id = ?) AND w.patient_id <> ?
      ORDER BY w.created_at LIMIT 40`,
    [...scope.params, date, date, a.practitioner_id, a.patient_id],
  );
  const items = rows
    .map(mapEntry)
    .filter((e) => timeOfDayAccepts(e.timeOfDay, time))
    .map((e) => ({
      ...e,
      slot: slotFits({ serviceId: e.serviceId, practitionerId: a.practitioner_id as number, date, time, patientId: e.patientId, preferRoom: a.room_id as number, preferDevice: (a.device_id as number) ?? null }),
    }))
    .filter((e) => e.slot)
    .slice(0, 5);
  res.json({ items });
});

waitlistRouter.post('/', requirePerm('appointments.manage'), (req, res) => {
  const d = validate(waitlistSchema, req.body);
  const user = assertPatientAccess(req, d.patientId);
  const service = getService(d.serviceId);
  if (!service || !service.active) throw badRequest('SERVICE_INACTIVE', 'Choose an active service.');
  if (d.practitionerId) {
    const p = getPractitioner(d.practitionerId);
    if (!p || !p.active) throw badRequest('PRACTITIONER_INACTIVE', 'Choose an active practitioner.');
    if (service.qualification && !p.qualifications.includes(service.qualification)) {
      throw badRequest('PRACTITIONER_UNQUALIFIED', `${p.displayName} does not hold the qualification required for ${service.nameEn}.`);
    }
  }
  if (d.latestDate < clinicToday()) throw badRequest('WINDOW_IN_PAST', 'The latest acceptable date has already passed.');
  const dup = get<{ id: number }>("SELECT id FROM waitlist WHERE patient_id = ? AND service_id = ? AND status = 'waiting'", [d.patientId, d.serviceId]);
  if (dup) throw conflict('ALREADY_WAITLISTED', 'This patient is already on the waitlist for this service.', { id: dup.id });
  const r = run(
    'INSERT INTO waitlist(patient_id, service_id, practitioner_id, earliest_date, latest_date, time_of_day, notes, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    [d.patientId, d.serviceId, d.practitionerId, d.earliestDate, d.latestDate, d.timeOfDay, d.notes, user.id, nowIso()],
  );
  audit(user, 'waitlist.add', { entityType: 'waitlist', entityId: r.id, patientId: d.patientId, summary: `Added to waitlist (${d.earliestDate} – ${d.latestDate})` });
  res.status(201).json({ id: r.id });
});

waitlistRouter.post('/:id/remove', requirePerm('appointments.manage'), (req, res) => {
  const id = intParam(req.params.id);
  const w = get<{ patient_id: number; status: string }>('SELECT patient_id, status FROM waitlist WHERE id = ?', [id]);
  if (!w) throw notFound('Waitlist entry');
  const user = assertPatientAccess(req, w.patient_id);
  const d = validate(waitlistRemoveSchema, req.body);
  if (w.status !== 'waiting') return void res.json({ ok: true, unchanged: true });
  run("UPDATE waitlist SET status = 'removed', closed_by = ?, closed_at = ?, close_reason = ? WHERE id = ?", [user.id, nowIso(), d.reason, id]);
  audit(user, 'waitlist.remove', { entityType: 'waitlist', entityId: id, patientId: w.patient_id, summary: 'Removed from waitlist' });
  res.json({ ok: true });
});

/** Booking the patient for the service they were waiting for closes their waitlist entry. */
export function fulfilWaitlist(user: AuthUser, patientId: number, serviceId: number, appointmentId: number): number {
  const rows = all<{ id: number }>("SELECT id FROM waitlist WHERE patient_id = ? AND service_id = ? AND status = 'waiting'", [patientId, serviceId]);
  const now = nowIso();
  for (const w of rows) {
    run("UPDATE waitlist SET status = 'booked', appointment_id = ?, closed_by = ?, closed_at = ? WHERE id = ?", [appointmentId, user.id, now, w.id]);
    audit(user, 'waitlist.booked', { entityType: 'waitlist', entityId: w.id, patientId, summary: `Waitlist entry booked as appointment #${appointmentId}` });
  }
  return rows.length;
}
