// End-to-end acceptance test against the real API and a throwaway SQLite database.
// Run with `npm test`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'luma-test-'));
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
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, body: json, headers: res.headers };
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

before(async () => {
  db = await import('../server/db/db.js');
  const { seedDemo } = await import('../server/db/seed.js');
  const { createApp } = await import('../server/app.js');
  const settings = await import('../server/settings.js');
  db.openDb();
  seedDemo();
  // Run the clinic in a time zone where it is currently mid-morning, open all week, so the
  // same-day scenario (book → check in → treat) works whatever time the test is run.
  const s = settings.getSettings();
  const zones = ['Pacific/Kiritimati', 'Pacific/Auckland', 'Australia/Sydney', 'Asia/Tokyo', 'Asia/Shanghai', 'Asia/Kolkata', 'Asia/Dubai', 'Africa/Cairo', 'Europe/London', 'Atlantic/Azores', 'America/Sao_Paulo', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'Pacific/Honolulu', 'Pacific/Pago_Pago'];
  const hourIn = (tz: string) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
  const timezone = zones.find((tz) => hourIn(tz) >= 7 && hourIn(tz) <= 12) ?? 'Africa/Cairo';
  const allDay = Array.from({ length: 7 }, () => ({ open: true, start: '00:00', end: '23:59' }));
  db.run('UPDATE settings SET data = ? WHERE id = 1', [JSON.stringify({ ...s, timezone, openingHours: allDay })]);
  db.run('UPDATE practitioners SET hours = ?', [JSON.stringify(allDay)]);
  settings.invalidateSettings();
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await login('reception', 'reception@luma.demo');
  await login('reception2', 'reception2@luma.demo');
  await login('nour', 'dr.nour@luma.demo');
  await login('owner', 'owner@luma.demo');
  await login('accounts', 'accounts@luma.demo');
});

after(() => {
  server?.close();
  db?.closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('core patient journey, safeguards and permissions', async () => {
  const ref = (await api('reception', 'GET', '/api/reference')).body;
  const svc = (en: string) => ref.services.find((s: any) => s.nameEn === en);
  const legs = svc('Laser – Full Legs');
  const consult = svc('Dermatology Consultation');
  const nour = ref.practitioners.find((p: any) => p.displayName === 'Dr. Nour El-Sayed');
  const karim = ref.practitioners.find((p: any) => p.displayName === 'Dr. Karim Fathy');
  const tpl = ref.packageTemplates.find((t: any) => t.nameEn === 'Laser Full Legs – 6 Sessions');
  const consentTpl = (type: string) => ref.consentTemplates.find((c: any) => c.type === type);
  const me = (await api('reception', 'GET', '/api/auth/me')).body;
  const today: string = new Intl.DateTimeFormat('en-CA', { timeZone: me.settings.timezone }).format(new Date());

  // 1. Create a patient (and see duplicate detection without merging)
  const phone = '0100555' + String(Date.now()).slice(-4);
  const created = await api('reception', 'POST', '/api/patients', { firstName: 'Test', lastName: 'Journey', phone, gender: 'female', dob: '1994-05-12' });
  assert.equal(created.status, 201);
  const patientId = created.body.id;
  const dup = await api('reception', 'POST', '/api/patients', { firstName: 'Tess', lastName: 'Journey', phone: `+20 ${phone.slice(1)}` });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, 'POSSIBLE_DUPLICATE');
  assert.equal(dup.body.error.details.matches[0].id, patientId);

  for (const type of ['treatment', 'clinical_photography']) {
    const c = await api('reception', 'POST', `/api/patients/${patientId}/consents`, { templateId: consentTpl(type).id, method: 'paper_signed' });
    assert.equal(c.status, 201);
  }

  // 2. Sell a six-session laser package — reception cannot discount
  const discounted = await api('reception', 'POST', '/api/packages', { patientId, templateId: tpl.id, startDate: today, discount: 50000, discountReason: 'x', idempotencyKey: key() });
  assert.equal(discounted.status, 403);
  const saleKey = key();
  const sale = await api('reception', 'POST', '/api/packages', { patientId, templateId: tpl.id, startDate: today, idempotencyKey: saleKey });
  assert.equal(sale.status, 201);
  const saleRetry = await api('reception', 'POST', '/api/packages', { patientId, templateId: tpl.id, startDate: today, idempotencyKey: saleKey });
  assert.equal(saleRetry.body.id, sale.body.id, 'retried sale returns the same package');
  const packageId = sale.body.id;
  const invoiceId = sale.body.invoiceId;

  // 3. Record a partial payment (retry-safe, no overpayment)
  const payKey = key();
  const pay = await api('reception', 'POST', `/api/invoices/${invoiceId}/payments`, { amount: 400000, method: 'cash', idempotencyKey: payKey });
  assert.equal(pay.status, 201);
  const payAgain = await api('reception', 'POST', `/api/invoices/${invoiceId}/payments`, { amount: 400000, method: 'cash', idempotencyKey: payKey });
  assert.equal(payAgain.body.duplicate, true);
  assert.equal(payAgain.body.paymentId, pay.body.paymentId);
  const over = await api('reception', 'POST', `/api/invoices/${invoiceId}/payments`, { amount: 900000, method: 'cash', idempotencyKey: key() });
  assert.equal(over.status, 409);
  assert.equal(over.body.error.code, 'OVERPAYMENT');

  // 4. Book an available practitioner, room and device
  const nowLocal = new Intl.DateTimeFormat('en-GB', { timeZone: me.settings.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
  const slots = (await api('reception', 'GET', `/api/appointments/slots?serviceId=${legs.id}&practitionerId=${nour.id}&date=${today}`)).body.items.filter((s: any) => s.time > nowLocal);
  assert.ok(slots.length, 'a free slot later today');
  const slot = slots[0];
  const booking = { patientId, serviceId: legs.id, practitionerId: nour.id, roomId: slot.roomId, deviceId: slot.deviceId, date: today, time: slot.time, purchasedPackageId: packageId };
  const check = await api('reception', 'POST', '/api/appointments/check', booking);
  assert.equal(check.body.ok, true, JSON.stringify(check.body.issues));
  const appt = await api('reception', 'POST', '/api/appointments', booking);
  assert.equal(appt.status, 201, JSON.stringify(appt.body));
  const apptId = appt.body.id;

  // Conflicts are blocked with an explanation and alternatives
  const other = { id: (await api('reception', 'POST', '/api/patients', { firstName: 'Other', lastName: 'Patient', phone: '0120555' + String(Date.now()).slice(-4) })).body.id };
  const clash = await api('reception', 'POST', '/api/appointments', { ...booking, patientId: other.id, purchasedPackageId: null });
  assert.equal(clash.status, 409);
  assert.equal(clash.body.error.code, 'SCHEDULING_CONFLICT');
  const codes = clash.body.error.details.issues.map((i: any) => i.code);
  assert.ok(codes.includes('CONFLICT_PRACTITIONER') && codes.includes('CONFLICT_ROOM') && codes.includes('CONFLICT_DEVICE'), codes.join(','));
  assert.ok(clash.body.error.details.alternatives.length > 0, 'alternatives offered');
  const roomClash = await api('reception', 'POST', '/api/appointments', { ...booking, patientId: other.id, practitionerId: karim.id, deviceId: null, purchasedPackageId: null });
  assert.equal(roomClash.status, 409);

  // Concurrent bookings for the same free slot: exactly one wins
  const free = slots.find((s: any) => s.time > slot.time && s.time >= addMinutes(slot.time, 90));
  if (free) {
    const body = { patientId: other.id, serviceId: legs.id, practitionerId: nour.id, roomId: free.roomId, deviceId: free.deviceId, date: today, time: free.time };
    const results = await Promise.all([api('reception', 'POST', '/api/appointments', body), api('reception2', 'POST', '/api/appointments', body)]);
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
  }

  // Cancellation does not consume a package session
  const freeOn = async (date: string) => (await api('reception', 'GET', `/api/appointments/slots?serviceId=${legs.id}&practitionerId=${nour.id}&date=${date}`)).body.items[0];
  let futureDate = addDays(today, 10);
  let fSlot = await freeOn(futureDate);
  while (!fSlot) fSlot = await freeOn((futureDate = addDays(futureDate, 1)));
  const future = await api('reception', 'POST', '/api/appointments', { ...booking, date: futureDate, time: fSlot.time, roomId: fSlot.roomId, deviceId: fSlot.deviceId });
  assert.equal(future.status, 201, JSON.stringify(future.body));
  const cancel = await api('reception', 'POST', `/api/appointments/${future.body.id}/status`, { status: 'cancelled', reason: 'Patient travelling' });
  assert.equal(cancel.status, 200);
  assert.equal((await api('reception', 'GET', `/api/packages/${packageId}`)).body.package.remainingSessions, 6);

  // 5. Check the patient in
  const arrive = await api('reception', 'POST', `/api/appointments/${apptId}/status`, { status: 'arrived' });
  assert.equal(arrive.status, 200);
  const queue = (await api('reception', 'GET', '/api/appointments/queue')).body;
  assert.ok(queue.waiting.some((a: any) => a.id === apptId));

  // Reception cannot reach restricted clinical records or photos
  assert.equal((await api('reception', 'GET', `/api/patients/${patientId}/medical`)).status, 403);
  assert.equal((await api('reception', 'GET', `/api/patients/${patientId}/photos`)).status, 403);
  assert.equal((await api('reception', 'GET', `/api/workspace/${apptId}`)).status, 403);
  assert.equal((await api('reception', 'POST', `/api/appointments/${apptId}/session`)).status, 403);
  assert.equal((await api('reception', 'GET', '/api/photos/1/file')).status, 403);
  // …and neither can the owner: administrative access is not clinical access
  assert.equal((await api('owner', 'GET', `/api/patients/${patientId}/medical`)).status, 403);
  assert.equal((await api('owner', 'GET', `/api/workspace/${apptId}`)).status, 403);

  // 6. Open the treatment workspace
  const start = await api('nour', 'POST', `/api/appointments/${apptId}/session`);
  assert.equal(start.status, 200);
  const sessionId = start.body.sessionId;
  const ws = (await api('nour', 'GET', `/api/workspace/${apptId}`)).body;
  assert.equal(ws.appointment.status, 'in_treatment');
  assert.ok(ws.packages.some((p: any) => p.id === packageId));
  const batchFor = (sku: string) => {
    const item = ws.inventory.find((i: any) => i.sku === sku);
    return { itemId: item.id, batch: item.batches.find((b: any) => !b.expired && b.onHand > 5) };
  };
  const gel = batchFor('CG-500');
  const tip = batchFor('LZ-TIP');
  const expiredSpf = ws.inventory.find((i: any) => i.sku === 'SPF-S');
  const expiredBatch = expiredSpf.batches.find((b: any) => b.expired && b.onHand > 0);
  assert.ok(expiredBatch, 'seed has an expired batch with stock');

  // 7. Save treatment details and consumables (draft)
  const draft = {
    bodyAreas: ['full_legs'],
    assessment: 'Fitzpatrick III, no tan.',
    treatmentNotes: 'Even single pass.',
    deviceId: booking.deviceId,
    deviceSettings: [{ label: 'Fluence', value: '18 J/cm²' }],
    consumables: [
      { itemId: gel.itemId, batchId: gel.batch.id, quantity: 60 },
      { itemId: tip.itemId, batchId: tip.batch.id, quantity: 1 },
      { itemId: expiredSpf.id, batchId: expiredBatch.id, quantity: 1 },
    ],
    aftercare: 'Avoid sun 2 weeks.',
    followUpPlan: null,
    followUpDate: null,
    purchasedPackageId: packageId,
    treatmentPlanId: null,
  };
  assert.equal((await api('nour', 'PUT', `/api/sessions/${sessionId}`, draft)).status, 200);

  // Expired batch blocks completion; the practitioner cannot override
  const blocked = await api('nour', 'POST', `/api/sessions/${sessionId}/complete`, { idempotencyKey: key() });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error.code, 'STOCK_BLOCKED');
  assert.equal(blocked.body.error.details.problems[0].type, 'expired');
  const forced = await api('nour', 'POST', `/api/sessions/${sessionId}/complete`, { idempotencyKey: key(), overrideReason: 'Please' });
  assert.equal(forced.status, 403);
  assert.equal((await api('nour', 'GET', `/api/packages/${packageId}`)).body.package.remainingSessions, 6, 'blocked completion consumed nothing');

  draft.consumables = draft.consumables.slice(0, 2);
  assert.equal((await api('nour', 'PUT', `/api/sessions/${sessionId}`, draft)).status, 200);
  const onHand = async (itemId: number, batchId: number) =>
    (await api('nour', 'GET', `/api/inventory/items/${itemId}`)).body.batches.find((b: any) => b.id === batchId).onHand;
  const gelBefore = await onHand(gel.itemId, gel.batch.id);

  // 8. Complete the session — repeated clicks and retries are harmless
  const k1 = key();
  const [c1, c2] = await Promise.all([
    api('nour', 'POST', `/api/sessions/${sessionId}/complete`, { idempotencyKey: k1 }),
    api('nour', 'POST', `/api/sessions/${sessionId}/complete`, { idempotencyKey: k1 }),
  ]);
  assert.deepEqual([c1.status, c2.status], [200, 200]);
  assert.deepEqual([c1.body.alreadyCompleted, c2.body.alreadyCompleted].sort(), [false, true]);
  const c3 = await api('nour', 'POST', `/api/sessions/${sessionId}/complete`, { idempotencyKey: key() });
  assert.equal(c3.body.alreadyCompleted, true);

  // 9. Five sessions remain
  const pkg = (await api('reception', 'GET', `/api/packages/${packageId}`)).body;
  assert.equal(pkg.package.remainingSessions, 5);
  assert.equal(pkg.ledger.filter((l: any) => l.kind === 'consume').length, 1);

  // 10. Stock deducted exactly once
  assert.equal(await onHand(gel.itemId, gel.batch.id), gelBefore - 60);
  const usage = (await api('nour', 'GET', `/api/inventory/movements?type=usage&itemId=${gel.itemId}&pageSize=100`)).body.items.filter((m: any) => m.sessionId === sessionId);
  assert.equal(usage.length, 1);

  // 11. Outstanding balance: 12,000 package − 4,000 paid = 8,000 (the package session adds no charge)
  const billing = (await api('reception', 'GET', `/api/patients/${patientId}/billing`)).body;
  assert.equal(billing.outstanding, 800000);
  assert.equal(billing.invoices.length, 1);

  // 12. Book the next appointment
  let nextDate = addDays(today, 42);
  let nSlot = await freeOn(nextDate);
  while (!nSlot) nSlot = await freeOn((nextDate = addDays(nextDate, 1)));
  const next = await api('reception', 'POST', '/api/appointments', { ...booking, date: nextDate, time: nSlot.time, roomId: nSlot.roomId, deviceId: nSlot.deviceId });
  assert.equal(next.status, 201, JSON.stringify(next.body));

  // Reversal needs permission and a reason, and is traceable + retry-safe
  assert.equal((await api('nour', 'POST', `/api/sessions/${sessionId}/reverse`, { reason: 'x', idempotencyKey: key() })).status, 403);
  assert.equal((await api('owner', 'POST', `/api/sessions/${sessionId}/reverse`, { reason: '', idempotencyKey: key() })).status, 422);
  const rev = await api('owner', 'POST', `/api/sessions/${sessionId}/reverse`, { reason: 'Recorded against wrong appointment', restock: true, idempotencyKey: key() });
  assert.equal(rev.status, 200);
  const rev2 = await api('owner', 'POST', `/api/sessions/${sessionId}/reverse`, { reason: 'again', restock: true, idempotencyKey: key() });
  assert.equal(rev2.body.alreadyReversed, true);
  const afterRev = (await api('reception', 'GET', `/api/packages/${packageId}`)).body;
  assert.equal(afterRev.package.remainingSessions, 6);
  assert.equal(afterRev.ledger.filter((l: any) => l.kind === 'reversal').length, 1);
  assert.equal(await onHand(gel.itemId, gel.batch.id), gelBefore);

  // Refunds are linked to the original payment and capped by it
  const refund = await api('accounts', 'POST', `/api/payments/${pay.body.paymentId}/refunds`, { amount: 100000, method: 'cash', reason: 'Goodwill', idempotencyKey: key() });
  assert.equal(refund.status, 201);
  const tooMuch = await api('accounts', 'POST', `/api/payments/${pay.body.paymentId}/refunds`, { amount: 400000, method: 'cash', reason: 'x', idempotencyKey: key() });
  assert.equal(tooMuch.body.error.code, 'REFUND_EXCEEDS_PAYMENT');
  assert.equal((await api('reception', 'POST', `/api/payments/${pay.body.paymentId}/refunds`, { amount: 1, method: 'cash', reason: 'x', idempotencyKey: key() })).status, 403);

  const billingAfterRefund = (await api('reception', 'GET', `/api/patients/${patientId}/billing`)).body;
  assert.equal(billingAfterRefund.outstanding, 800000 + 100000, 'a refund re-opens the refunded amount');

  // A non-package visit needs treatment consent, then is invoiced exactly once at completion
  const third = (await api('reception', 'POST', '/api/patients', { firstName: 'Third', lastName: 'Visitor', phone: '0150555' + String(Date.now()).slice(-4) })).body.id;
  const cSlot = (await api('reception', 'GET', `/api/appointments/slots?serviceId=${consult.id}&practitionerId=${karim.id}&date=${today}`)).body.items.find((s: any) => s.time > nowLocal);
  if (cSlot) {
    const ca = await api('reception', 'POST', '/api/appointments', { patientId: third, serviceId: consult.id, practitionerId: karim.id, roomId: cSlot.roomId, deviceId: null, date: today, time: cSlot.time });
    assert.equal(ca.status, 201, JSON.stringify(ca.body));
    await api('reception', 'POST', `/api/appointments/${ca.body.id}/status`, { status: 'arrived' });
    await login('karim', 'dr.karim@luma.demo');
    const s2 = (await api('karim', 'POST', `/api/appointments/${ca.body.id}/session`)).body.sessionId;
    const noConsent = await api('karim', 'POST', `/api/sessions/${s2}/complete`, { idempotencyKey: key() });
    assert.equal(noConsent.body.error.code, 'TREATMENT_CONSENT_MISSING');
    await api('reception', 'POST', `/api/patients/${third}/consents`, { templateId: consentTpl('treatment').id, method: 'in_clinic_acknowledgement' });
    const done = await api('karim', 'POST', `/api/sessions/${s2}/complete`, { idempotencyKey: key() });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    await api('karim', 'POST', `/api/sessions/${s2}/complete`, { idempotencyKey: key() });
    const b2 = (await api('reception', 'GET', `/api/patients/${third}/billing`)).body;
    assert.equal(b2.invoices.filter((i: any) => i.appointmentId === ca.body.id).length, 1);
    assert.equal(b2.outstanding, consult.price);
  }

  // Audit trail recorded the sensitive access without clinical content
  const auditLog = (await api('owner', 'GET', `/api/audit?patientId=${patientId}&pageSize=100`)).body.items;
  assert.ok(auditLog.some((e: any) => e.action === 'workspace.open' && e.sensitive));
  assert.ok(!JSON.stringify(auditLog).includes('Even single pass'), 'clinical notes never appear in audit');
});

test('practitioner time off blocks bookings and is managed by schedulers', async () => {
  const ref = (await api('reception', 'GET', '/api/reference')).body;
  assert.ok(ref.rooms.every((r: any) => r.nameAr) && ref.devices.every((d: any) => d.nameAr), 'rooms and devices carry Arabic names');
  const consult = ref.services.find((s: any) => s.nameEn === 'Dermatology Consultation');
  const karim = ref.practitioners.find((p: any) => p.displayName === 'Dr. Karim Fathy');
  const me = (await api('reception', 'GET', '/api/auth/me')).body;
  const today: string = new Intl.DateTimeFormat('en-CA', { timeZone: me.settings.timezone }).format(new Date());
  const patient = (await api('reception', 'POST', '/api/patients', { firstName: 'Leave', lastName: 'Check', phone: '0110555' + String(Date.now()).slice(-4) })).body.id;
  const slotsOn = async (date: string) => (await api('reception', 'GET', `/api/appointments/slots?serviceId=${consult.id}&practitionerId=${karim.id}&date=${date}`)).body.items;

  // A booking already in the diary for the day the leave will cover
  const date = addDays(today, 20);
  const before = await slotsOn(date);
  const s1 = before[0];
  const s3 = before.find((s: any) => s.time >= addMinutes(s1.time, 60));
  const booking = { patientId: patient, serviceId: consult.id, practitionerId: karim.id, roomId: s1.roomId, deviceId: null, date, time: s1.time };
  const appt = await api('reception', 'POST', '/api/appointments', booking);
  assert.equal(appt.status, 201, JSON.stringify(appt.body));

  const leave = { practitionerId: karim.id, kind: 'leave', startDate: date, endDate: addDays(date, 1), allDay: true, note: 'Family event' };
  assert.equal((await api('nour', 'POST', '/api/time-off', leave)).status, 403, 'practitioners cannot record time off');
  assert.equal((await api('reception', 'POST', '/api/time-off', { ...leave, allDay: false, startTime: '10:00', endTime: '12:00' })).status, 422, 'part-day time off covers one day');

  // Existing bookings are listed and must be acknowledged; they are not cancelled
  const unconfirmed = await api('reception', 'POST', '/api/time-off', leave);
  assert.equal(unconfirmed.status, 409);
  assert.equal(unconfirmed.body.error.code, 'TIME_OFF_AFFECTS_BOOKINGS');
  assert.deepEqual(unconfirmed.body.error.details.affected.map((a: any) => a.id), [appt.body.id]);
  const created = await api('reception', 'POST', '/api/time-off', { ...leave, confirmAffected: true });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal((await api('reception', 'GET', `/api/appointments/${appt.body.id}`)).body.appointment.status, 'booked');
  assert.equal((await api('reception', 'POST', '/api/time-off', { ...leave, confirmAffected: true })).body.error.code, 'TIME_OFF_OVERLAP');

  // New bookings in the period are refused with an explanation; free times disappear
  const refused = await api('reception', 'POST', '/api/appointments', { ...booking, time: s3.time });
  assert.equal(refused.status, 409);
  assert.ok(refused.body.error.details.issues.some((i: any) => i.code === 'PRACTITIONER_TIME_OFF' && i.params.practitionerId === karim.id));
  assert.ok(refused.body.error.details.alternatives.every((a: any) => a.date !== date || a.practitionerId !== karim.id));
  assert.equal((await slotsOn(date)).length, 0);
  assert.equal((await slotsOn(addDays(date, 1))).length, 0);

  // The reason is shown to schedulers, not to other clinicians
  const listed = (await api('reception', 'GET', `/api/time-off?practitionerId=${karim.id}`)).body.items.find((o: any) => o.id === created.body.id);
  assert.equal(listed.kind, 'leave');
  assert.equal(listed.affectedCount, 1);
  assert.equal(listed.startDate, date);
  assert.equal(listed.endDate, addDays(date, 1));
  const seenByNour = (await api('nour', 'GET', `/api/time-off?from=${date}&to=${date}`)).body.items.find((o: any) => o.id === created.body.id);
  assert.equal(seenByNour.kind, null);
  assert.equal(seenByNour.note, null);

  // Cancelling needs a reason, is retry-safe, and frees the diary again
  assert.equal((await api('reception', 'POST', `/api/time-off/${created.body.id}/cancel`, { reason: '' })).status, 422);
  assert.equal((await api('reception', 'POST', `/api/time-off/${created.body.id}/cancel`, { reason: 'Plans changed' })).status, 200);
  assert.equal((await api('reception', 'POST', `/api/time-off/${created.body.id}/cancel`, { reason: 'Plans changed' })).status, 200);
  assert.ok((await slotsOn(date)).length > 0);
  assert.equal((await api('reception', 'POST', '/api/appointments', { ...booking, time: s3.time })).status, 201);

  const auditLog = (await api('owner', 'GET', '/api/audit?action=time_off&pageSize=50')).body.items;
  assert.deepEqual(auditLog.map((e: any) => e.action).sort(), ['time_off.cancel', 'time_off.create']);
  assert.ok(!JSON.stringify(auditLog).includes('Family event'), 'the absence note stays out of the audit log');
});

function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}
function addMinutes(time: string, mins: number): string {
  const [h, m] = time.split(':').map(Number);
  const t = Math.min(h * 60 + m + mins, 23 * 60 + 59);
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}
