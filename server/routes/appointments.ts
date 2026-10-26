import { Router, type Request } from 'express';
import { all, camel, get, nowIso, run, scalar, tx } from '../db/db.js';
import { assertPatientAccess, assertPerm, can, requirePerm, type AuthUser } from '../auth.js';
import { audit } from '../audit.js';
import { ApiError, badRequest, conflict, intParam, notFound, optInt, optStr, pageParams, validate } from '../http.js';
import { clinicToday, getSettings } from '../settings.js';
import { appointmentSchema, availabilityCheckSchema, statusChangeSchema } from '../../shared/schemas.js';
import { STATUS_TRANSITIONS, type AppointmentStatus } from '../../shared/domain.js';
import { rangeBoundsUtc, zonedParts } from '../../shared/time.js';
import { evaluateSlot, findAlternatives, freeSlots, type SlotRequest } from '../services/scheduling.js';
import { checkEligibility, eligiblePackages } from '../services/packages.js';
import { addAdjustment, appointmentPaymentState, ensureAppointmentInvoice, invoiceBalance, issueRefund, refundable, voidInvoice } from '../services/finance.js';
import { startSession } from '../services/sessions.js';
import { getService } from '../services/reference.js';

export const appointmentsRouter = Router();
type Row = Record<string, unknown>;

export const SELECT = `
  SELECT a.*, p.first_name, p.last_name, p.phone, p.code AS patient_code, p.primary_practitioner_id,
         s.deposit_amount, pp.name_en AS package_en, pp.name_ar AS package_ar,
         (SELECT t.id FROM treatment_sessions t WHERE t.appointment_id = a.id AND t.status <> 'reversed') AS session_id,
         (SELECT t.status FROM treatment_sessions t WHERE t.appointment_id = a.id ORDER BY t.id DESC LIMIT 1) AS session_status
    FROM appointments a
    JOIN patients p ON p.id = a.patient_id
    JOIN services s ON s.id = a.service_id
    LEFT JOIN purchased_packages pp ON pp.id = a.purchased_package_id`;

/** Users without whole-clinic patient access see other practitioners' bookings as "busy" only. */
function canSeePatient(user: AuthUser, r: Row): boolean {
  if (user.permissions.has('patients.view_all')) return true;
  if (!user.practitionerId) return false;
  return r.practitioner_id === user.practitionerId || r.primary_practitioner_id === user.practitionerId;
}

export function mapAppointment(req: Request, r: Row) {
  const user = req.user!;
  const visible = canSeePatient(user, r);
  return {
    id: r.id as number,
    patientId: visible ? (r.patient_id as number) : null,
    patientName: visible ? `${r.first_name} ${r.last_name}` : null,
    patientPhone: visible ? (r.phone as string) : null,
    patientCode: visible ? (r.patient_code as string) : null,
    masked: !visible,
    serviceId: r.service_id as number,
    practitionerId: r.practitioner_id as number,
    roomId: r.room_id as number,
    deviceId: (r.device_id as number) ?? null,
    startAt: r.start_at as string,
    endAt: r.end_at as string,
    blockStart: r.block_start as string,
    blockEnd: r.block_end as string,
    bufferBeforeMin: r.buffer_before_min as number,
    bufferAfterMin: r.buffer_after_min as number,
    status: r.status as AppointmentStatus,
    notes: visible ? ((r.notes as string) ?? null) : null,
    arrivedAt: (r.arrived_at as string) ?? null,
    startedAt: (r.started_at as string) ?? null,
    completedAt: (r.completed_at as string) ?? null,
    cancelledAt: (r.cancelled_at as string) ?? null,
    cancelReason: visible ? ((r.cancel_reason as string) ?? null) : null,
    purchasedPackageId: (r.purchased_package_id as number) ?? null,
    packageEn: (r.package_en as string) ?? null,
    packageAr: (r.package_ar as string) ?? null,
    sessionId: (r.session_id as number) ?? null,
    sessionStatus: (r.session_status as string) ?? null,
    payment:
      visible && can(req, 'billing.view')
        ? appointmentPaymentState({ id: r.id as number, purchased_package_id: r.purchased_package_id as number | null, deposit_amount: r.deposit_amount as number, status: r.status as string })
        : null,
    depositAmount: r.deposit_amount as number,
  };
}

appointmentsRouter.get('/', requirePerm('appointments.view'), (req, res) => {
  const tz = getSettings().timezone;
  const where: string[] = ['1=1'];
  const params: unknown[] = [];
  const from = optStr(req.query.from);
  const to = optStr(req.query.to) ?? from;
  if (from && to) {
    const b = rangeBoundsUtc(from, to, tz);
    where.push('a.start_at >= ? AND a.start_at < ?');
    params.push(b.start, b.end);
  }
  for (const [key, col] of [
    ['practitionerId', 'a.practitioner_id'],
    ['serviceId', 'a.service_id'],
    ['deviceId', 'a.device_id'],
    ['roomId', 'a.room_id'],
    ['patientId', 'a.patient_id'],
  ] as const) {
    const v = optInt(req.query[key]);
    if (v) {
      where.push(`${col} = ?`);
      params.push(v);
    }
  }
  const statuses = optStr(req.query.status)?.split(',').filter(Boolean) ?? [];
  if (statuses.length) {
    where.push(`a.status IN (${statuses.map(() => '?').join(',')})`);
    params.push(...statuses);
  }
  const q = optStr(req.query.q);
  if (q) {
    where.push("(p.first_name || ' ' || p.last_name LIKE ? OR p.phone_normalized LIKE ? OR p.code LIKE ?)");
    params.push(`%${q}%`, `%${q.replace(/\D/g, '') || q}%`, `%${q}%`);
    if (!can(req, 'patients.view_all')) {
      where.push('(a.practitioner_id = ? OR p.primary_practitioner_id = ?)');
      params.push(req.user!.practitionerId ?? 0, req.user!.practitionerId ?? 0);
    }
  }
  const category = optInt(req.query.categoryId);
  if (category) {
    where.push('s.category_id = ?');
    params.push(category);
  }
  const whereSql = where.join(' AND ');
  const sort = req.query.sort === 'desc' ? 'DESC' : 'ASC';
  if (req.query.paged === '1') {
    const { page, pageSize, offset } = pageParams(req.query, 25);
    const total = scalar<number>(`SELECT COUNT(*) FROM appointments a JOIN patients p ON p.id = a.patient_id JOIN services s ON s.id = a.service_id WHERE ${whereSql}`, params);
    const rows = all<Row>(`${SELECT} WHERE ${whereSql} ORDER BY a.start_at ${sort} LIMIT ? OFFSET ?`, [...params, pageSize, offset]);
    return void res.json({ items: rows.map((r) => mapAppointment(req, r)), total, page, pageSize });
  }
  const rows = all<Row>(`${SELECT} WHERE ${whereSql} ORDER BY a.start_at ${sort} LIMIT 2000`, params);
  res.json({ items: rows.map((r) => mapAppointment(req, r)), total: rows.length, page: 1, pageSize: rows.length });
});

appointmentsRouter.get('/queue', requirePerm('appointments.view'), (req, res) => {
  const tz = getSettings().timezone;
  const today = clinicToday();
  const b = rangeBoundsUtc(today, today, tz);
  const rows = all<Row>(
    `${SELECT} WHERE a.start_at >= ? AND a.start_at < ? AND a.status IN ('booked','confirmed','arrived','in_treatment')
      ORDER BY CASE a.status WHEN 'in_treatment' THEN 0 WHEN 'arrived' THEN 1 ELSE 2 END, COALESCE(a.arrived_at, a.start_at)`,
    [b.start, b.end],
  );
  const items = rows.map((r) => mapAppointment(req, r));
  res.json({
    waiting: items.filter((a) => a.status === 'arrived').sort((x, y) => String(x.arrivedAt).localeCompare(String(y.arrivedAt))),
    inTreatment: items.filter((a) => a.status === 'in_treatment'),
    expected: items.filter((a) => a.status === 'booked' || a.status === 'confirmed'),
  });
});

function toSlotRequest(d: { serviceId: number; practitionerId: number; roomId: number; deviceId: number | null; date: string; time: string }, extra: Partial<SlotRequest> = {}): SlotRequest {
  return { serviceId: d.serviceId, practitionerId: d.practitionerId, roomId: d.roomId, deviceId: d.deviceId, date: d.date, time: d.time, ...extra };
}

appointmentsRouter.post('/check', requirePerm('appointments.view'), (req, res) => {
  const d = validate(availabilityCheckSchema, req.body);
  const slot = toSlotRequest(d, { patientId: d.patientId, excludeAppointmentId: d.excludeAppointmentId });
  const { issues, times } = evaluateSlot(slot);
  const service = getService(d.serviceId);
  res.json({
    ok: issues.length === 0,
    issues,
    times,
    buffers: service ? { before: service.bufferBeforeMin, after: service.bufferAfterMin, duration: service.durationMin } : null,
    alternatives: issues.length ? findAlternatives(slot) : [],
  });
});

appointmentsRouter.get('/slots', requirePerm('appointments.view'), (req, res) => {
  const serviceId = intParam(req.query.serviceId, 'serviceId');
  const practitionerId = intParam(req.query.practitionerId, 'practitionerId');
  const date = optStr(req.query.date) ?? clinicToday();
  res.json({ items: freeSlots(serviceId, practitionerId, date) });
});

appointmentsRouter.get('/eligible-packages', requirePerm('packages.view'), (req, res) => {
  const patientId = intParam(req.query.patientId, 'patientId');
  const serviceId = intParam(req.query.serviceId, 'serviceId');
  assertPatientAccess(req, patientId);
  const date = optStr(req.query.date) ?? clinicToday();
  res.json({
    items: eligiblePackages(patientId, serviceId, date).map((p) => ({
      id: p.id,
      nameEn: p.nameEn,
      nameAr: p.nameAr,
      expiryDate: p.expiryDate,
      remaining: p.items.find((i) => i.serviceId === serviceId)?.remaining ?? 0,
      balance: p.balance,
    })),
  });
});

function schedulingConflict(slot: SlotRequest, issues: ReturnType<typeof evaluateSlot>['issues']): ApiError {
  return conflict('SCHEDULING_CONFLICT', issues.map((i) => i.message).join(' '), { issues, alternatives: findAlternatives(slot) });
}

function validatePackage(packageId: number | null, patientId: number, serviceId: number, date: string) {
  if (!packageId) return;
  const e = checkEligibility(packageId, patientId, serviceId, date);
  if (!e.ok) throw badRequest('PACKAGE_NOT_ELIGIBLE', e.message, { problem: e.problem });
}

appointmentsRouter.post('/', requirePerm('appointments.manage'), (req, res) => {
  const d = validate(appointmentSchema, req.body);
  const user = assertPatientAccess(req, d.patientId);
  const id = tx(() => {
    const slot = toSlotRequest(d, { patientId: d.patientId });
    const { issues, times } = evaluateSlot(slot);
    if (issues.length || !times) throw schedulingConflict(slot, issues);
    validatePackage(d.purchasedPackageId, d.patientId, d.serviceId, d.date);
    const service = getService(d.serviceId)!;
    const now = nowIso();
    const r = run(
      `INSERT INTO appointments(patient_id, service_id, practitioner_id, room_id, device_id, start_at, end_at, block_start, block_end,
         buffer_before_min, buffer_after_min, status, purchased_package_id, notes, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        d.patientId,
        d.serviceId,
        d.practitionerId,
        d.roomId,
        d.deviceId,
        times.start,
        times.end,
        times.blockStart,
        times.blockEnd,
        service.bufferBeforeMin,
        service.bufferAfterMin,
        d.status,
        d.purchasedPackageId,
        d.notes,
        user.id,
        now,
        now,
      ],
    );
    run("INSERT INTO appointment_events(appointment_id, kind, to_status, created_by, created_at) VALUES (?, 'created', ?, ?, ?)", [r.id, d.status, user.id, now]);
    audit(user, 'appointment.create', { entityType: 'appointment', entityId: r.id, patientId: d.patientId, summary: `Appointment booked for ${d.date} ${d.time}` });
    return r.id;
  });
  res.status(201).json({ id });
});

appointmentsRouter.put('/:id', requirePerm('appointments.manage'), (req, res) => {
  const id = intParam(req.params.id);
  const d = validate(appointmentSchema, req.body);
  const user = assertPatientAccess(req, d.patientId);
  tx(() => {
    const cur = get<Row>('SELECT * FROM appointments WHERE id = ?', [id]);
    if (!cur) throw notFound('Appointment');
    if (!['booked', 'confirmed'].includes(cur.status as string)) {
      throw conflict('NOT_EDITABLE', 'Only booked or confirmed appointments can be changed. Book a new appointment instead.');
    }
    if (cur.patient_id !== d.patientId) throw badRequest('PATIENT_CHANGE', 'The patient of an existing appointment cannot be changed.');
    const slot = toSlotRequest(d, { patientId: d.patientId, excludeAppointmentId: id });
    const { issues, times } = evaluateSlot(slot);
    if (issues.length || !times) throw schedulingConflict(slot, issues);
    validatePackage(d.purchasedPackageId, d.patientId, d.serviceId, d.date);
    const service = getService(d.serviceId)!;
    const now = nowIso();
    run(
      `UPDATE appointments SET service_id=?, practitioner_id=?, room_id=?, device_id=?, start_at=?, end_at=?, block_start=?, block_end=?,
         buffer_before_min=?, buffer_after_min=?, purchased_package_id=?, notes=?, updated_at=? WHERE id = ?`,
      [d.serviceId, d.practitionerId, d.roomId, d.deviceId, times.start, times.end, times.blockStart, times.blockEnd, service.bufferBeforeMin, service.bufferAfterMin, d.purchasedPackageId, d.notes, now, id],
    );
    // A service change re-prices an unpaid appointment invoice.
    if (cur.service_id !== d.serviceId) {
      const inv = get<{ id: number }>("SELECT id FROM invoices WHERE appointment_id = ? AND status <> 'void'", [id]);
      if (inv && invoiceBalance(inv.id).netPaid === 0) voidInvoice(user, inv.id, 'Service changed on reschedule');
      else if (inv) throw conflict('SERVICE_CHANGE_PAID', 'A payment is recorded for this appointment, so its service cannot change. Cancel and rebook instead.');
    }
    run("INSERT INTO appointment_events(appointment_id, kind, reason, details, created_by, created_at) VALUES (?, 'rescheduled', ?, ?, ?, ?)", [
      id,
      optStr(req.body.reason),
      JSON.stringify({ from: cur.start_at, to: times.start }),
      user.id,
      now,
    ]);
    audit(user, 'appointment.reschedule', { entityType: 'appointment', entityId: id, patientId: d.patientId, summary: `Moved to ${d.date} ${d.time}` });
  });
  res.json({ ok: true });
});

appointmentsRouter.get('/:id', requirePerm('appointments.view'), (req, res) => {
  const id = intParam(req.params.id);
  const r = get<Row>(`${SELECT} WHERE a.id = ?`, [id]);
  if (!r) throw notFound('Appointment');
  const appt = mapAppointment(req, r);
  const events = appt.masked
    ? []
    : all<Row>(
        'SELECT e.kind, e.from_status, e.to_status, e.reason, e.details, e.created_at, u.name AS by_name FROM appointment_events e LEFT JOIN users u ON u.id = e.created_by WHERE e.appointment_id = ? ORDER BY e.id',
        [id],
      ).map((e) => camel(e));
  const cancellation = getSettings().cancellation;
  const hoursUntil = (new Date(appt.startAt).getTime() - Date.now()) / 3600_000;
  res.json({ appointment: appt, events, lateCancellation: hoursUntil < cancellation.minNoticeHours, hoursUntil });
});

function permissionForTransition(to: AppointmentStatus): 'appointments.checkin' | 'appointments.manage' {
  return to === 'cancelled' || to === 'no_show' ? 'appointments.manage' : 'appointments.checkin';
}

appointmentsRouter.post('/:id/status', (req, res) => {
  const id = intParam(req.params.id);
  const d = validate(statusChangeSchema, req.body);
  const user = assertPerm(req, permissionForTransition(d.status));
  const result = tx(() => {
    const cur = get<Row>(`${SELECT} WHERE a.id = ?`, [id]);
    if (!cur) throw notFound('Appointment');
    assertPatientAccess(req, cur.patient_id as number);
    const from = cur.status as AppointmentStatus;
    if (from === d.status) return { unchanged: true };
    if (!STATUS_TRANSITIONS[from].includes(d.status)) {
      throw conflict('INVALID_TRANSITION', `An appointment that is ${from.replace('_', ' ')} cannot be changed to ${d.status.replace('_', ' ')}.`, { from, to: d.status });
    }
    if ((d.status === 'cancelled' || d.status === 'no_show') && !d.reason) {
      throw badRequest('REASON_REQUIRED', 'Give a reason for the cancellation or no-show.');
    }
    if (d.status === 'arrived' || d.status === 'no_show') {
      const localDate = zonedParts(cur.start_at as string, getSettings().timezone).date;
      if (d.status === 'arrived' && localDate !== clinicToday()) throw conflict('NOT_TODAY', 'Patients can only be checked in on the day of their appointment.');
      if (d.status === 'no_show' && new Date(cur.start_at as string).getTime() > Date.now()) throw conflict('NOT_STARTED', 'A no-show can only be recorded after the appointment time.');
    }
    const now = nowIso();
    const sets: string[] = ['status = ?', 'updated_at = ?'];
    const vals: unknown[] = [d.status, now];
    if (d.status === 'arrived') {
      sets.push('arrived_at = COALESCE(arrived_at, ?)');
      vals.push(now);
    }
    if (from === 'arrived' && (d.status === 'confirmed' || d.status === 'booked')) sets.push('arrived_at = NULL');
    if (d.status === 'in_treatment') {
      sets.push('started_at = COALESCE(started_at, ?)');
      vals.push(now);
    }
    if (d.status === 'cancelled' || d.status === 'no_show') {
      sets.push('cancelled_at = ?', 'cancel_reason = ?');
      vals.push(now, d.reason);
    }
    run(`UPDATE appointments SET ${sets.join(', ')} WHERE id = ?`, [...vals, id]);
    run('INSERT INTO appointment_events(appointment_id, kind, from_status, to_status, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
      id,
      'status',
      from,
      d.status,
      d.reason,
      user.id,
      now,
    ]);
    let depositOutcome: string | null = null;
    // Cancellation and no-show never touch the package ledger; only the appointment invoice is settled here.
    if (d.status === 'cancelled' || d.status === 'no_show') depositOutcome = settleCancelledInvoice(user, cur, d.status, d.depositAction ?? 'none');
    audit(user, `appointment.${d.status}`, { entityType: 'appointment', entityId: id, patientId: cur.patient_id as number, summary: `Status ${from} → ${d.status}`, meta: depositOutcome ? { deposit: depositOutcome } : undefined });
    return { unchanged: false, depositOutcome };
  });
  res.json({ ok: true, ...result });
});

function settleCancelledInvoice(user: AuthUser, appt: Row, status: 'cancelled' | 'no_show', action: 'none' | 'refund' | 'retain'): string | null {
  const inv = get<{ id: number; total: number }>("SELECT id, total FROM invoices WHERE appointment_id = ? AND status <> 'void'", [appt.id]);
  if (!inv) return null;
  const bal = invoiceBalance(inv.id);
  if (bal.netPaid === 0) {
    voidInvoice(user, inv.id, status === 'cancelled' ? 'Appointment cancelled' : 'No-show');
    return 'invoice_voided';
  }
  if (action === 'refund') {
    if (!user.permissions.has('refunds.issue')) {
      throw new ApiError(403, 'FORBIDDEN', 'Refunding the deposit requires the "refunds.issue" permission. Choose “Decide later” and ask the accountant.');
    }
    for (const p of all<{ id: number; method: 'cash' | 'card' | 'bank_transfer' }>('SELECT id, method FROM payments WHERE invoice_id = ?', [inv.id])) {
      const amount = refundable(p.id);
      if (amount > 0) issueRefund(user, p.id, { amount, method: p.method, reason: `Deposit refunded: appointment ${status.replace('_', '-')}`, idempotencyKey: `cancel-${appt.id}-${p.id}` });
    }
    voidInvoice(user, inv.id, `Appointment ${status.replace('_', '-')} — deposit refunded`);
    return 'refunded';
  }
  if (action === 'retain') {
    const c = getSettings().cancellation;
    const hoursUntil = (new Date(appt.start_at as string).getTime() - Date.now()) / 3600_000;
    const policyRetains = status === 'no_show' ? c.noShowDeposit === 'retain' : hoursUntil < c.minNoticeHours && c.lateCancelDeposit === 'retain';
    if (!policyRetains && !user.permissions.has('invoices.adjust')) {
      throw new ApiError(403, 'FORBIDDEN', 'The cancellation policy does not retain the deposit here; retaining it needs the "invoices.adjust" permission.');
    }
    const reduce = bal.total - bal.netPaid;
    if (reduce > 0) addAdjustment(user, inv.id, -reduce, `Deposit retained as ${status === 'no_show' ? 'no-show' : 'cancellation'} fee (policy)`);
    return 'retained';
  }
  return 'pending_decision';
}

appointmentsRouter.post('/:id/invoice', requirePerm('payments.record'), (req, res) => {
  const id = intParam(req.params.id);
  const appt = get<{ patient_id: number; status: string }>('SELECT patient_id, status FROM appointments WHERE id = ?', [id]);
  if (!appt) throw notFound('Appointment');
  assertPatientAccess(req, appt.patient_id);
  if (appt.status === 'cancelled' || appt.status === 'no_show') throw conflict('APPOINTMENT_CLOSED', 'This appointment was cancelled; it cannot be invoiced.');
  res.json({ invoiceId: ensureAppointmentInvoice(req.user!, id) });
});

appointmentsRouter.post('/:id/session', requirePerm('treatment.perform'), (req, res) => {
  const id = intParam(req.params.id);
  const appt = get<{ patient_id: number }>('SELECT patient_id FROM appointments WHERE id = ?', [id]);
  if (!appt) throw notFound('Appointment');
  assertPatientAccess(req, appt.patient_id);
  res.json({ sessionId: startSession(req.user!, id) });
});
