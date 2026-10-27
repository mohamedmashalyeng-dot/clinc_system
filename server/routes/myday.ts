// "My day": the jobs waiting for the signed-in person, chosen by what their permissions let them do
// (so a customised role gets the matching list). Each task has a count, a few example rows and a
// link to the screen where the work is done.
import { Router } from 'express';
import { all, scalar } from '../db/db.js';
import { can, patientScopeSql } from '../auth.js';
import { clinicToday, getSettings } from '../settings.js';
import { addDays, rangeBoundsUtc, zonedParts } from '../../shared/time.js';
import { INVOICE_BALANCE_SQL, appointmentPaymentState } from '../services/finance.js';
import { inventoryAlerts } from '../services/inventory.js';
import { attachNoShowRisk } from '../services/insights.js';
import { mapAppointment, SELECT } from './appointments.js';

export const myDayRouter = Router();
type Row = Record<string, unknown>;

type Tone = 'danger' | 'warning' | 'info' | 'success' | 'neutral';
interface TaskItem {
  label: string;
  sub?: string | null;
  at?: string | null;
  /** Calendar date (YYYY-MM-DD). */
  date?: string | null;
  /** Minor units. */
  amount?: number | null;
  late?: boolean;
  patientId?: number | null;
  appointmentId?: number | null;
  link?: string | null;
}
interface Task {
  key: string;
  tone: Tone;
  count: number;
  items: TaskItem[];
  link: string;
  params?: Record<string, string | number>;
}

const FIRST = 5;
const UPCOMING = "('booked','confirmed')";

myDayRouter.get('/', (req, res) => {
  const user = req.user!;
  const settings = getSettings();
  const tz = settings.timezone;
  const today = clinicToday();
  const day = rangeBoundsUtc(today, today, tz);
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const scope = patientScopeSql(user);
  const tasks: Task[] = [];
  const push = (t: Task) => {
    if (t.count > 0) tasks.push({ ...t, items: t.items.slice(0, FIRST) });
  };
  const name = (r: Row) => `${r.first_name} ${r.last_name}`;
  const mine = user.practitionerId;

  // Today at a glance (own diary for practitioners).
  const todayRows = can(req, 'appointments.view')
    ? all<Row>(`${SELECT} WHERE a.start_at >= ? AND a.start_at < ? ${mine ? 'AND a.practitioner_id = ?' : ''} ORDER BY a.start_at`, [day.start, day.end, ...(mine ? [mine] : [])])
    : [];
  const live = todayRows.filter((r) => r.status !== 'cancelled' && r.status !== 'no_show');
  const summary = {
    appointments: live.length,
    completed: live.filter((r) => r.status === 'completed').length,
    waiting: live.filter((r) => r.status === 'arrived').length,
    next: null as null | { id: number; startAt: string; patientName: string | null; serviceId: number; practitionerId: number },
    mine: !!mine,
  };
  const nextRow = live.find((r) => ['booked', 'confirmed'].includes(r.status as string) && (r.end_at as string) > nowIso);
  if (nextRow) {
    const a = mapAppointment(req, nextRow);
    summary.next = { id: a.id, startAt: a.startAt, patientName: a.patientName, serviceId: a.serviceId, practitionerId: a.practitionerId };
  }

  // Practitioners: patients waiting for them, and treatment records left unfinished.
  if (can(req, 'treatment.perform') && mine) {
    const waiting = live.filter((r) => r.status === 'arrived');
    const longest = waiting.reduce((m, r) => Math.max(m, now - new Date((r.arrived_at as string) ?? nowIso).getTime()), 0);
    push({
      key: 'waiting_for_me',
      tone: longest > 15 * 60000 ? 'danger' : 'warning',
      count: waiting.length,
      link: '/appointments?view=queue',
      items: waiting.map((r) => ({ label: name(r), at: r.arrived_at as string, appointmentId: r.id as number, link: `/workspace/${r.id}` })),
    });
    const drafts = all<Row>(
      `SELECT t.appointment_id, a.start_at, p.first_name, p.last_name, t.service_id FROM treatment_sessions t
         JOIN appointments a ON a.id = t.appointment_id JOIN patients p ON p.id = t.patient_id
        WHERE t.status = 'draft' AND t.practitioner_id = ? AND a.start_at < ? ORDER BY a.start_at`,
      [mine, new Date(now - 2 * 3600_000).toISOString()],
    );
    push({
      key: 'unfinished_sessions',
      tone: 'danger',
      count: drafts.length,
      link: `/workspace/${drafts[0]?.appointment_id ?? ''}`,
      items: drafts.map((r) => ({ label: name(r), at: r.start_at as string, link: `/workspace/${r.appointment_id}` })),
    });
  }

  // Front desk: arrivals to check in (late ones first).
  if (can(req, 'appointments.checkin')) {
    const due = live
      .filter((r) => ['booked', 'confirmed'].includes(r.status as string) && new Date(r.start_at as string).getTime() < now + 60 * 60000)
      .map((r) => mapAppointment(req, r))
      .filter((a) => !a.masked);
    const late = due.filter((a) => new Date(a.startAt).getTime() < now);
    push({
      key: 'arrivals',
      tone: late.length ? 'warning' : 'info',
      count: due.length,
      params: { late: late.length },
      link: '/appointments?view=queue',
      items: due.map((a) => ({ label: a.patientName ?? '', at: a.startAt, appointmentId: a.id, late: new Date(a.startAt).getTime() < now })),
    });
  }

  // Confirmations for tomorrow, and risky bookings in the next three days.
  if (can(req, 'appointments.manage') || can(req, 'followup.manage')) {
    const tomorrow = addDays(today, 1);
    const tb = rangeBoundsUtc(tomorrow, tomorrow, tz);
    const unconfirmed = all<Row>(`${SELECT} WHERE a.start_at >= ? AND a.start_at < ? AND a.status = 'booked' AND ${scope.sql} ORDER BY a.start_at`, [tb.start, tb.end, ...scope.params]);
    push({
      key: 'confirm_tomorrow',
      tone: 'info',
      count: unconfirmed.length,
      link: '/follow-up?tab=reminders',
      items: unconfirmed.map((r) => ({ label: name(r), sub: r.phone as string, at: r.start_at as string, appointmentId: r.id as number })),
    });
    const soon = rangeBoundsUtc(today, addDays(today, 3), tz);
    const risky = attachNoShowRisk(all<Row>(`${SELECT} WHERE a.start_at >= ? AND a.start_at < ? AND a.status IN ${UPCOMING} AND ${scope.sql} ORDER BY a.start_at`, [nowIso, soon.end, ...scope.params]).map((r) => mapAppointment(req, r))).filter(
      (a) => a.noShowRisk,
    );
    push({
      key: 'risky_bookings',
      tone: risky.some((a) => a.noShowRisk?.level === 'high') ? 'danger' : 'warning',
      count: risky.length,
      link: '/appointments?view=list',
      items: risky.map((a) => ({ label: a.patientName ?? '', sub: a.patientPhone, at: a.startAt, appointmentId: a.id })),
    });
  }

  // Money at the desk: deposits to take, balances to collect from today's patients, the drawer count.
  if (can(req, 'payments.record')) {
    const week = rangeBoundsUtc(today, addDays(today, 3), tz);
    const deposits = all<Row>(`${SELECT} WHERE a.start_at >= ? AND a.start_at < ? AND a.status IN ${UPCOMING} AND s.deposit_amount > 0 AND a.purchased_package_id IS NULL AND ${scope.sql} ORDER BY a.start_at`, [nowIso, week.end, ...scope.params])
      .filter((r) => appointmentPaymentState({ id: r.id as number, purchased_package_id: null, deposit_amount: r.deposit_amount as number, status: r.status as string }).state === 'deposit_due');
    push({
      key: 'deposits_due',
      tone: 'warning',
      count: deposits.length,
      link: '/appointments?view=list',
      items: deposits.map((r) => ({ label: name(r), at: r.start_at as string, appointmentId: r.id as number })),
    });
    const collect = all<Row>(
      `SELECT p.id, p.first_name, p.last_name, (SELECT COALESCE(SUM(${INVOICE_BALANCE_SQL}), 0) FROM invoices i WHERE i.patient_id = p.id AND i.status = 'issued') AS outstanding
         FROM patients p WHERE ${scope.sql} AND EXISTS (SELECT 1 FROM appointments a WHERE a.patient_id = p.id AND a.start_at >= ? AND a.start_at < ? AND a.status NOT IN ('cancelled','no_show'))`,
      [...scope.params, day.start, day.end],
    ).filter((r) => Number(r.outstanding) > 0);
    push({
      key: 'collect_today',
      tone: 'warning',
      count: collect.length,
      link: '/growth?tab=collect',
      params: { total: collect.reduce((s, r) => s + Number(r.outstanding), 0) },
      items: collect.map((r) => ({ label: name(r), amount: Number(r.outstanding), patientId: r.id as number })),
    });
    const lastWeek = rangeBoundsUtc(addDays(today, -7), addDays(today, -1), tz);
    const paidDays = new Set(all<{ received_at: string }>('SELECT received_at FROM payments WHERE received_at >= ? AND received_at < ?', [lastWeek.start, lastWeek.end]).map((p) => zonedParts(p.received_at, tz).date));
    const closed = new Set(all<{ date: string }>('SELECT date FROM day_closings WHERE superseded_by IS NULL AND date >= ?', [addDays(today, -7)]).map((c) => c.date));
    const unclosed = [...paidDays].filter((d) => !closed.has(d)).sort();
    const paidToday = scalar<number>('SELECT COUNT(*) FROM payments WHERE received_at >= ? AND received_at < ?', [day.start, day.end]);
    const todayClosed = closed.has(today);
    push({
      key: 'day_close',
      tone: unclosed.length ? 'danger' : 'info',
      count: unclosed.length + (paidToday && !todayClosed ? 1 : 0),
      link: `/billing?tab=close${unclosed[0] ? `&date=${unclosed[0]}` : ''}`,
      items: [...unclosed.map((d) => ({ label: d, date: d, link: `/billing?tab=close&date=${d}` })), ...(paidToday && !todayClosed ? [{ label: today, date: today, link: '/billing?tab=close' }] : [])],
    });
  }

  // Accounts: overdue installments and deposits waiting for a decision.
  if (can(req, 'billing.view') && (can(req, 'invoices.adjust') || can(req, 'refunds.issue'))) {
    const overdue = all<Row>(
      `SELECT DISTINCT i.id, i.number, p.first_name, p.last_name, i.patient_id, (${INVOICE_BALANCE_SQL}) AS balance FROM invoice_installments ii
         JOIN invoices i ON i.id = ii.invoice_id JOIN patients p ON p.id = i.patient_id
        WHERE i.status = 'issued' AND ii.due_date < ? AND (${INVOICE_BALANCE_SQL}) > 0
          AND (SELECT COALESCE(SUM(x.amount), 0) FROM invoice_installments x WHERE x.invoice_id = ii.invoice_id AND x.seq <= ii.seq)
              > COALESCE((SELECT SUM(amount) FROM payments WHERE invoice_id = i.id), 0) - COALESCE((SELECT SUM(amount) FROM refunds WHERE invoice_id = i.id), 0)`,
      [today],
    );
    push({
      key: 'installments_overdue',
      tone: 'danger',
      count: overdue.length,
      link: '/billing?status=outstanding',
      items: overdue.map((r) => ({ label: name(r), sub: r.number as string, amount: Number(r.balance), patientId: r.patient_id as number })),
    });
    const pending = all<Row>(
      `SELECT a.id, a.start_at, p.first_name, p.last_name FROM invoices i JOIN appointments a ON a.id = i.appointment_id JOIN patients p ON p.id = a.patient_id
        WHERE i.status = 'issued' AND a.status IN ('cancelled','no_show') AND (${INVOICE_BALANCE_SQL}) > 0 ORDER BY a.start_at DESC`,
    );
    push({ key: 'deposit_decisions', tone: 'warning', count: pending.length, link: '/billing?status=outstanding', items: pending.map((r) => ({ label: name(r), at: r.start_at as string, appointmentId: r.id as number })) });
  }

  // Follow-up and growth work.
  if (can(req, 'followup.view')) {
    const fu = all<Row>(
      `SELECT f.id, f.due_date, p.first_name, p.last_name, p.id AS patient_id FROM follow_ups f JOIN patients p ON p.id = f.patient_id
        WHERE ${scope.sql} AND f.status = 'open' AND f.due_date <= ? ORDER BY f.due_date`,
      [...scope.params, today],
    );
    push({ key: 'followups', tone: fu.some((r) => (r.due_date as string) < today) ? 'warning' : 'info', count: fu.length, link: '/follow-up', items: fu.map((r) => ({ label: name(r), date: r.due_date as string, patientId: r.patient_id as number })) });
  }
  if (can(req, 'followup.manage') && can(req, 'packages.view')) {
    const unbooked = scalar<number>(
      `SELECT COUNT(*) FROM purchased_packages pp JOIN patients p ON p.id = pp.patient_id
        WHERE ${scope.sql} AND pp.status = 'active' AND pp.expiry_date >= ?
          AND (SELECT SUM(quantity) FROM purchased_package_items WHERE purchased_package_id = pp.id) + COALESCE((SELECT SUM(delta) FROM package_usage WHERE purchased_package_id = pp.id), 0) > 0
          AND NOT EXISTS (SELECT 1 FROM appointments x WHERE x.patient_id = p.id AND x.status IN ('booked','confirmed','arrived','in_treatment') AND x.start_at >= ?)`,
      [...scope.params, today, day.start],
    );
    push({ key: 'growth', tone: 'success', count: unbooked, link: '/growth', items: [] });
  }
  if (can(req, 'followup.manage')) {
    const md = today.slice(5);
    const birthdays = all<Row>(`SELECT p.id, p.first_name, p.last_name FROM patients p WHERE ${scope.sql} AND substr(p.dob, 6) = ?`, [...scope.params, md]);
    push({ key: 'birthdays', tone: 'success', count: birthdays.length, link: '/growth?tab=birthdays', items: birthdays.map((r) => ({ label: name(r), patientId: r.id as number })) });
  }
  if (can(req, 'appointments.manage')) {
    const waiting = scalar<number>(`SELECT COUNT(*) FROM waitlist w JOIN patients p ON p.id = w.patient_id WHERE ${scope.sql} AND w.status = 'waiting' AND w.latest_date >= ?`, [...scope.params, today]);
    push({ key: 'waitlist', tone: 'info', count: waiting, link: '/appointments?view=waitlist', items: [] });
  }

  // Stock and clinical approvals.
  if (can(req, 'inventory.manage')) {
    const alerts = inventoryAlerts(today, settings.expiryWarningDays);
    const expired = alerts.expiringBatches.filter((b) => b.expired);
    push({
      key: 'stock',
      tone: expired.length ? 'danger' : 'warning',
      count: alerts.lowStock.length + expired.length,
      link: alerts.lowStock.length ? '/inventory?filter=low' : '/inventory?filter=expiring',
      params: { low: alerts.lowStock.length, expired: expired.length },
      items: [],
    });
  }
  if (can(req, 'aftercare.approve')) {
    const n = scalar<number>("SELECT COUNT(*) FROM message_templates WHERE kind = 'aftercare' AND approved_by IS NULL AND active = 1");
    push({ key: 'aftercare', tone: 'info', count: n, link: '/follow-up?tab=templates', items: [] });
  }

  res.json({ today, summary, tasks });
});
