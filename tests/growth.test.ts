// Growth features against the real API and a throwaway database: growth centre, patient insights,
// no-show risk, smart waitlist, end-of-day cash count and marketing attribution.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'luma-growth-'));
process.env.LUMA_DATA_DIR = dataDir;
process.env.LUMA_DEMO_MODE = 'true';

let server: Server;
let base = '';
const cookies: Record<string, string> = {};
let db: typeof import('../server/db/db.js');

async function api(who: string, method: string, url: string, body?: unknown) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'LumaClinic', ...(cookies[who] ? { Cookie: cookies[who] } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function login(who: string, email: string) {
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'LumaClinic' },
    body: JSON.stringify({ email, password: 'demo1234' }),
  });
  assert.equal(res.status, 200, `login ${email}`);
  cookies[who] = res.headers.get('set-cookie')!.split(';')[0];
}

const key = () => crypto.randomUUID();
let today = '';

before(async () => {
  db = await import('../server/db/db.js');
  const { seedDemo } = await import('../server/db/seed.js');
  const { createApp } = await import('../server/app.js');
  const settings = await import('../server/settings.js');
  db.openDb();
  seedDemo();
  // Open around the clock so bookings in the near future always fit, whatever time the test runs.
  const s = settings.getSettings();
  const allDay = Array.from({ length: 7 }, () => ({ open: true, start: '00:00', end: '23:59' }));
  db.run('UPDATE settings SET data = ? WHERE id = 1', [JSON.stringify({ ...s, openingHours: allDay })]);
  db.run('UPDATE practitioners SET hours = ?', [JSON.stringify(allDay)]);
  settings.invalidateSettings();
  today = settings.clinicToday();
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await login('reception', 'reception@luma.demo');
  await login('nour', 'dr.nour@luma.demo');
  await login('owner', 'owner@luma.demo');
  await login('accounts', 'accounts@luma.demo');
  await login('assistant', 'assistant@luma.demo');
  await login('calls', 'callcenter@luma.demo');
});

after(() => {
  server?.close();
  db?.closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

test('growth centre lists real opportunities, scoped by permission', async () => {
  const r = await api('reception', 'GET', '/api/growth');
  assert.equal(r.status, 200);
  const g = r.body;
  assert.ok(g.unbooked.length > 0, 'prepaid sessions with nothing booked');
  assert.ok(g.lapsed.length >= 8, 'seeded lapsed patients appear');
  assert.ok(g.summary.prepaidOutstanding.value > 0);
  for (const x of g.unbooked) {
    assert.ok(x.remaining > 0);
    const booked = db.scalar<number>("SELECT COUNT(*) FROM appointments WHERE patient_id = ? AND status IN ('booked','confirmed') AND start_at >= ?", [x.patientId, new Date().toISOString()]);
    assert.equal(booked, 0, 'nothing booked for an unbooked-package patient');
  }
  const prepaid = new Set(g.unbooked.map((x: any) => x.patientId));
  assert.ok(g.due.every((x: any) => !prepaid.has(x.patientId)), 'a patient is not on both rebooking lists');
  assert.ok(g.lapsed.every((x: any) => x.daysSince > 90 && typeof x.lifetimeValue === 'number'));
  assert.ok(g.lapsed[0].lifetimeValue >= g.lapsed[g.lapsed.length - 1].lifetimeValue, 'most valuable first');

  // Accountant has no follow-up access; the practitioner sees only their patients and no money.
  assert.equal((await api('accounts', 'GET', '/api/growth')).status, 403);
  const p = await api('nour', 'GET', '/api/growth');
  assert.equal(p.status, 200);
  assert.ok(p.body.lapsed.every((x: any) => x.lifetimeValue === null));
  assert.equal(p.body.collect, null);
  const nourId = db.scalar<number>("SELECT id FROM practitioners WHERE display_name = 'Dr. Nour El-Sayed'");
  for (const x of [...p.body.lapsed, ...p.body.due]) {
    const visible = db.scalar<number>('SELECT COUNT(*) FROM patients p WHERE p.id = ? AND (p.primary_practitioner_id = ? OR EXISTS (SELECT 1 FROM appointments a WHERE a.patient_id = p.id AND a.practitioner_id = ?))', [x.patientId, nourId, nourId]);
    assert.equal(visible, 1, 'practitioner list stays within assigned patients');
  }
});

test('patient insights, referral attribution and no-show risk', async () => {
  const ref = (await api('reception', 'GET', '/api/reference')).body;
  const legs = ref.services.find((s: any) => s.nameEn === 'Laser – Full Legs');
  const karim = ref.practitioners.find((p: any) => p.displayName === 'Dr. Karim Fathy');
  const referrer = db.scalar<number>('SELECT id FROM patients ORDER BY id LIMIT 1');

  const created = await api('reception', 'POST', '/api/patients', { firstName: 'Risk', lastName: 'Test', phone: '01005559871', source: 'referral', referredByPatientId: referrer });
  assert.equal(created.status, 201);
  const id = created.body.id;
  const self = await api('reception', 'PUT', `/api/patients/${id}`, { firstName: 'Risk', lastName: 'Test', phone: '01005559871', source: 'referral', referredByPatientId: id });
  assert.equal(self.status, 400);
  assert.equal(self.body.error.code, 'INVALID_REFERRER');

  // Two past no-shows and no completed visit: high risk.
  const roomId = legs.roomIds[0];
  for (const daysAgo of [20, 40]) {
    const start = new Date(Date.now() - daysAgo * 86400000).toISOString();
    db.run(
      `INSERT INTO appointments(patient_id, service_id, practitioner_id, room_id, device_id, start_at, end_at, block_start, block_end, status, cancelled_at, cancel_reason, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?, 'no_show', ?, 'Did not attend', ?, ?)`,
      [id, legs.id, karim.id, roomId, legs.deviceIds[0], start, start, start, start, start, start, start],
    );
  }
  const profile = await api('reception', 'GET', `/api/patients/${id}`);
  assert.equal(profile.status, 200);
  assert.equal(profile.body.patient.source, 'referral');
  assert.equal(profile.body.patient.referredByPatientId, referrer);
  assert.ok(profile.body.patient.referredByName);
  assert.equal(profile.body.insights.noShows, 2);
  assert.equal(profile.body.insights.noShowRisk.level, 'high');
  assert.equal(profile.body.insights.lifetimeValue, 0);
  const referrerProfile = await api('reception', 'GET', `/api/patients/${referrer}`);
  assert.ok(referrerProfile.body.insights.referrals >= 1);

  // A new booking for them carries the risk flag on the schedule.
  const date = addDays(today, 3);
  const slots = await api('reception', 'GET', `/api/appointments/slots?serviceId=${legs.id}&practitionerId=${karim.id}&date=${date}`);
  const slot = slots.body.items.find((s: any) => s.time >= '10:00');
  const booked = await api('reception', 'POST', '/api/appointments', { patientId: id, serviceId: legs.id, practitionerId: karim.id, roomId: slot.roomId, deviceId: slot.deviceId, date, time: slot.time });
  assert.equal(booked.status, 201);
  const appt = await api('reception', 'GET', `/api/appointments/${booked.body.id}`);
  assert.equal(appt.body.appointment.noShowRisk.level, 'high');
  assert.deepEqual(
    appt.body.appointment.noShowRisk.reasons.map((x: any) => x.code),
    ['no_shows', 'first_visit'],
  );

  // Marketing report: the referral is attributed; referrer names only for whole-clinic access.
  const owner = await api('owner', 'GET', `/api/reports?from=${today}&to=${today}`);
  assert.equal(owner.status, 200);
  assert.ok(owner.body.marketing.bySource.some((x: any) => x.source === 'referral' && x.newPatients >= 1));
  assert.ok(owner.body.marketing.topReferrers.some((x: any) => x.patientId === referrer));
  assert.equal(typeof owner.body.marketing.marketingSpend, 'number');
  const prac = await api('nour', 'GET', `/api/reports?from=${today}&to=${today}`);
  assert.equal(prac.body.marketing.topReferrers, null);
  assert.ok(prac.body.marketing.bySource.every((x: any) => x.revenue === null));
});

test('waitlist finds slots, matches freed time and closes when booked', async () => {
  const ref = (await api('reception', 'GET', '/api/reference')).body;
  const hydra = ref.services.find((s: any) => s.nameEn === 'Hydrafacial Signature');
  const salma = ref.practitioners.find((p: any) => p.displayName === 'Salma Youssef');
  const [a, b] = db.all<{ id: number }>("SELECT id FROM patients WHERE id NOT IN (SELECT patient_id FROM waitlist) ORDER BY id DESC LIMIT 2").map((r) => r.id);

  // Seeded entries come back with a computed earliest slot.
  const list = await api('reception', 'GET', '/api/waitlist');
  assert.equal(list.status, 200);
  assert.ok(list.body.items.length >= 5);
  assert.ok(list.body.items.some((e: any) => e.slot && e.slot.date >= today));

  // Book patient A, add B to the waitlist, then cancel A's booking.
  const date = addDays(today, 4);
  const slot = (await api('reception', 'GET', `/api/appointments/slots?serviceId=${hydra.id}&practitionerId=${salma.id}&date=${date}`)).body.items.find((s: any) => s.time >= '14:00');
  const appt = await api('reception', 'POST', '/api/appointments', { patientId: a, serviceId: hydra.id, practitionerId: salma.id, roomId: slot.roomId, deviceId: slot.deviceId, date, time: slot.time });
  assert.equal(appt.status, 201);

  const entry = { patientId: b, serviceId: hydra.id, practitionerId: null, earliestDate: date, latestDate: addDays(date, 2), timeOfDay: 'afternoon' };
  assert.equal((await api('nour', 'POST', '/api/waitlist', entry)).status, 403, 'practitioner cannot manage the waitlist');
  const added = await api('reception', 'POST', '/api/waitlist', entry);
  assert.equal(added.status, 201);
  const again = await api('reception', 'POST', '/api/waitlist', entry);
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'ALREADY_WAITLISTED');
  const bad = await api('reception', 'POST', '/api/waitlist', { ...entry, latestDate: addDays(date, -1) });
  assert.equal(bad.status, 422);

  assert.deepEqual((await api('reception', 'GET', `/api/waitlist/matches?appointmentId=${appt.body.id}`)).body.items, [], 'no matches while still booked');
  const cancel = await api('reception', 'POST', `/api/appointments/${appt.body.id}/status`, { status: 'cancelled', reason: 'Travel' });
  assert.equal(cancel.status, 200);
  const matches = await api('reception', 'GET', `/api/waitlist/matches?appointmentId=${appt.body.id}`);
  const match = matches.body.items.find((m: any) => m.id === added.body.id);
  assert.ok(match, 'the waiting patient matches the freed slot');
  assert.equal(match.slot.time, slot.time);

  // Booking B into the freed slot closes their entry.
  const rebooked = await api('reception', 'POST', '/api/appointments', {
    patientId: b,
    serviceId: hydra.id,
    practitionerId: match.slot.practitionerId,
    roomId: match.slot.roomId,
    deviceId: match.slot.deviceId,
    date: match.slot.date,
    time: match.slot.time,
  });
  assert.equal(rebooked.status, 201);
  assert.equal(rebooked.body.waitlistFulfilled, 1);
  const row = db.get<{ status: string; appointment_id: number }>('SELECT status, appointment_id FROM waitlist WHERE id = ?', [added.body.id])!;
  assert.equal(row.status, 'booked');
  assert.equal(row.appointment_id, rebooked.body.id);

  // Removing needs a reason and keeps the record.
  const other = (await api('reception', 'GET', '/api/waitlist')).body.items[0];
  assert.equal((await api('reception', 'POST', `/api/waitlist/${other.id}/remove`, {})).status, 422);
  assert.equal((await api('reception', 'POST', `/api/waitlist/${other.id}/remove`, { reason: 'Found another time' })).status, 200);
  const closed = (await api('reception', 'GET', '/api/waitlist?status=closed')).body.items;
  assert.ok(closed.some((e: any) => e.id === other.id && e.status === 'removed' && e.closeReason === 'Found another time'));
});

test('end-of-day cash count is computed by the server and kept on re-count', async () => {
  const patientId = db.scalar<number>('SELECT id FROM patients ORDER BY id LIMIT 1');
  const inv = await api('reception', 'POST', '/api/invoices', { patientId, lines: [{ description: 'Day close test', quantity: 1, unitPrice: 50000 }], idempotencyKey: key() });
  assert.equal(inv.status, 201);
  const pay = await api('reception', 'POST', `/api/invoices/${inv.body.id}/payments`, { amount: 30000, method: 'cash', idempotencyKey: key() });
  assert.equal(pay.status, 201);

  const day = await api('reception', 'GET', `/api/day-close?date=${today}`);
  assert.equal(day.status, 200);
  assert.ok(day.body.methods.cash.received >= 30000);
  const expected = 100000 + day.body.methods.cash.net - day.body.cashExpenses;

  assert.equal((await api('nour', 'GET', '/api/day-close')).status, 403);
  assert.equal((await api('reception', 'POST', '/api/day-close', { date: addDays(today, 1), openingFloat: 100000, countedCash: 0, idempotencyKey: key() })).status, 400);

  const short = await api('reception', 'POST', '/api/day-close', { date: today, openingFloat: 100000, countedCash: expected - 2000, idempotencyKey: key() });
  assert.equal(short.status, 400);
  assert.equal(short.body.error.code, 'VARIANCE_NOTE_REQUIRED');

  const k = key();
  const closed = await api('reception', 'POST', '/api/day-close', { date: today, openingFloat: 100000, countedCash: expected, idempotencyKey: k });
  assert.equal(closed.status, 201);
  const retry = await api('reception', 'POST', '/api/day-close', { date: today, openingFloat: 100000, countedCash: expected, idempotencyKey: k });
  assert.equal(retry.body.id, closed.body.id);
  assert.equal(retry.body.repeated, true);

  const recountNoReason = await api('reception', 'POST', '/api/day-close', { date: today, openingFloat: 100000, countedCash: expected - 2000, notes: null, idempotencyKey: key() });
  assert.equal(recountNoReason.body.error.code, 'RECOUNT_REASON_REQUIRED');
  const recount = await api('reception', 'POST', '/api/day-close', { date: today, openingFloat: 100000, countedCash: expected - 2000, notes: 'Recounted: 20 short, change error', idempotencyKey: key() });
  assert.equal(recount.status, 201);

  const after = (await api('accounts', 'GET', `/api/day-close?date=${today}`)).body;
  assert.equal(after.current.id, recount.body.id);
  assert.equal(after.current.variance, -2000);
  assert.equal(after.current.expectedCash, expected);
  assert.equal(after.previous.length, 1);
  assert.equal(after.previous[0].supersededBy, recount.body.id);

  const history = (await api('owner', 'GET', '/api/day-close/history')).body;
  assert.ok(history.items.some((c: any) => c.date === today && c.variance === -2000));
  assert.ok(history.items.some((c: any) => c.variance !== 0 && c.notes), 'seeded closings include an explained variance');
});

test('personal preferences are saved per user and sanitised', async () => {
  const me = (await api('reception', 'GET', '/api/auth/me')).body;
  assert.deepEqual(me.preferences, { theme: 'system', accent: null, density: 'comfortable', textSize: 'normal', startPage: null });
  const saved = await api('reception', 'PUT', '/api/auth/preferences', { theme: 'dark', accent: '#2f7f80', density: 'compact' });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.preferences.theme, 'dark');
  // Partial updates keep earlier choices; invalid values fall back instead of being stored.
  const again = await api('reception', 'PUT', '/api/auth/preferences', { textSize: 'large', accent: 'red', startPage: 'javascript:alert(1)' });
  assert.deepEqual(again.body.preferences, { theme: 'dark', accent: null, density: 'compact', textSize: 'large', startPage: null });
  assert.equal((await api('reception', 'GET', '/api/auth/me')).body.preferences.density, 'compact');
  assert.equal((await api('owner', 'GET', '/api/auth/me')).body.preferences.theme, 'system', 'other users are unaffected');
  // The clinic colour is part of the settings the owner manages.
  const settings = (await api('owner', 'GET', '/api/auth/me')).body.settings;
  const put = await api('owner', 'PUT', '/api/settings', { ...settings, brandColor: '#a8466a' });
  assert.equal(put.status, 200);
  assert.equal((await api('reception', 'GET', '/api/auth/me')).body.settings.brandColor, '#a8466a');
  assert.equal((await api('owner', 'PUT', '/api/settings', { ...settings, brandColor: 'pink' })).status, 422);
});

test('new roles get their own defaults and a task list that fits the job', async () => {
  // Nurse / assistant: check-in and stock, no money or bookings management.
  const assistant = (await api('assistant', 'GET', '/api/auth/me')).body;
  assert.equal(assistant.user.role, 'assistant');
  assert.ok(assistant.permissions.includes('appointments.checkin'));
  assert.ok(!assistant.permissions.includes('billing.view'));
  assert.equal((await api('assistant', 'GET', '/api/day-close')).status, 403);
  assert.equal((await api('assistant', 'POST', '/api/waitlist', {})).status, 403);
  // Call centre: bookings and outreach, no money and no clinical records.
  const calls = (await api('calls', 'GET', '/api/auth/me')).body;
  assert.ok(calls.permissions.includes('appointments.manage') && calls.permissions.includes('followup.manage'));
  assert.ok(!calls.permissions.includes('medical.view') && !calls.permissions.includes('payments.record'));
  assert.equal((await api('calls', 'GET', '/api/growth')).status, 200);
  assert.equal((await api('calls', 'GET', '/api/growth')).body.collect, null);
  const someone = db.scalar<number>('SELECT id FROM patients ORDER BY id LIMIT 1');
  assert.equal((await api('calls', 'GET', `/api/patients/${someone}/medical`)).status, 403);

  // "My day" is built from permissions: every task shown is one the person can act on.
  const keys = async (who: string) => {
    const r = await api(who, 'GET', '/api/my-day');
    assert.equal(r.status, 200);
    return { body: r.body, keys: r.body.tasks.map((x: any) => x.key) as string[] };
  };
  const rec = await keys('reception');
  assert.ok(rec.keys.every((k) => !['unfinished_sessions', 'waiting_for_me', 'installments_overdue', 'aftercare'].includes(k)));
  const acc = await keys('accounts');
  assert.ok(acc.keys.every((k) => !['arrivals', 'confirm_tomorrow', 'waiting_for_me', 'followups'].includes(k)));
  const nour = await keys('nour');
  assert.equal(nour.body.summary.mine, true);
  assert.ok(nour.keys.every((k) => !['collect_today', 'day_close', 'deposits_due'].includes(k)));
  const asst = await keys('assistant');
  assert.ok(asst.keys.every((k) => !['collect_today', 'day_close', 'confirm_tomorrow', 'installments_overdue'].includes(k)));
  for (const r of [rec, acc, nour, asst]) for (const t of r.body.tasks) assert.ok(t.count > 0 && t.items.length <= 5 && typeof t.link === 'string');
});
