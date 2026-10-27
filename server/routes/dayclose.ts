import { Router, type Request } from 'express';
import { all, camel, get, nowIso, run, scalar, tx } from '../db/db.js';
import { assertPerm, can, requirePerm } from '../auth.js';
import { audit } from '../audit.js';
import { badRequest, validate } from '../http.js';
import { clinicToday, getSettings } from '../settings.js';
import { dayCloseSchema } from '../../shared/schemas.js';
import { PAYMENT_METHODS, type PaymentMethod } from '../../shared/domain.js';
import { addDays, diffDays, isValidDateString, rangeBoundsUtc, zonedParts } from '../../shared/time.js';

export const dayCloseRouter = Router();
type Row = Record<string, unknown>;

function assertView(req: Request) {
  if (!can(req, 'payments.record') && !can(req, 'reports.financial')) assertPerm(req, 'payments.record');
}

function dateParam(value: unknown, fallback: string): string {
  if (value === undefined || value === '') return fallback;
  if (typeof value !== 'string' || !isValidDateString(value)) throw badRequest('INVALID_PARAM', 'Invalid date.');
  return value;
}

/** Money taken and paid out for one clinic-local day, by method. */
export function daySummary(date: string) {
  const b = rangeBoundsUtc(date, date, getSettings().timezone);
  const pay = all<{ method: PaymentMethod; total: number; n: number }>(
    'SELECT method, COALESCE(SUM(amount), 0) AS total, COUNT(*) AS n FROM payments WHERE received_at >= ? AND received_at < ? GROUP BY method',
    [b.start, b.end],
  );
  const ref = all<{ method: PaymentMethod; total: number; n: number }>(
    'SELECT method, COALESCE(SUM(amount), 0) AS total, COUNT(*) AS n FROM refunds WHERE created_at >= ? AND created_at < ? GROUP BY method',
    [b.start, b.end],
  );
  const methods = Object.fromEntries(
    PAYMENT_METHODS.map((m) => {
      const p = pay.find((x) => x.method === m);
      const r = ref.find((x) => x.method === m);
      return [m, { received: p?.total ?? 0, receivedCount: p?.n ?? 0, refunded: r?.total ?? 0, refundedCount: r?.n ?? 0, net: (p?.total ?? 0) - (r?.total ?? 0) }];
    }),
  ) as Record<PaymentMethod, { received: number; receivedCount: number; refunded: number; refundedCount: number; net: number }>;
  const cashExpenses = scalar<number>("SELECT COALESCE(SUM(amount), 0) FROM expenses WHERE voided_at IS NULL AND method = 'cash' AND date = ?", [date]);
  return { date, methods, cashExpenses };
}

const CLOSING_SELECT = 'SELECT c.*, u.name AS closed_by_name FROM day_closings c LEFT JOIN users u ON u.id = c.closed_by';

dayCloseRouter.get('/', (req, res) => {
  assertView(req);
  const today = clinicToday();
  const date = dateParam(req.query.date, today);
  if (date > today) throw badRequest('FUTURE_DATE', 'A day can only be closed once it has started.');
  const closings = all<Row>(`${CLOSING_SELECT} WHERE c.date = ? ORDER BY c.id DESC`, [date]).map((r) => camel(r));
  const lastFloat = scalar<number | null>('SELECT opening_float FROM day_closings WHERE superseded_by IS NULL ORDER BY date DESC, id DESC LIMIT 1');
  res.json({
    ...daySummary(date),
    today,
    current: closings.find((c) => !c.supersededBy) ?? null,
    previous: closings.filter((c) => c.supersededBy),
    suggestedFloat: lastFloat ?? 0,
  });
});

dayCloseRouter.get('/history', (req, res) => {
  assertView(req);
  const today = clinicToday();
  const to = dateParam(req.query.to, today);
  const from = dateParam(req.query.from, addDays(to, -30));
  if (to < from || diffDays(from, to) > 366) throw badRequest('INVALID_RANGE', 'Choose a range of up to one year.');
  const items = all<Row>(`${CLOSING_SELECT} WHERE c.superseded_by IS NULL AND c.date >= ? AND c.date <= ? ORDER BY c.date DESC`, [from, to]).map((r) => camel(r));
  // Days that took payments but were never counted (today is still open, so it is not listed).
  const b = rangeBoundsUtc(from, to, getSettings().timezone);
  const tz = getSettings().timezone;
  const paidDays = new Set(all<{ received_at: string }>('SELECT received_at FROM payments WHERE received_at >= ? AND received_at < ?', [b.start, b.end]).map((p) => zonedParts(p.received_at, tz).date));
  const closed = new Set(items.map((c) => c.date as string));
  const unclosed = [...paidDays].filter((d) => d < today && !closed.has(d)).sort().reverse();
  res.json({ items, unclosed, from, to });
});

dayCloseRouter.post('/', requirePerm('payments.record'), (req, res) => {
  const d = validate(dayCloseSchema, req.body);
  const user = req.user!;
  if (d.date > clinicToday()) throw badRequest('FUTURE_DATE', 'A day can only be closed once it has started.');
  const result = tx(() => {
    const repeat = get<{ id: number }>('SELECT id FROM day_closings WHERE idempotency_key = ?', [d.idempotencyKey]);
    if (repeat) return { id: repeat.id, repeated: true };
    const s = daySummary(d.date);
    const expected = d.openingFloat + s.methods.cash.received - s.methods.cash.refunded - s.cashExpenses;
    const variance = d.countedCash - expected;
    const prev = get<{ id: number }>('SELECT id FROM day_closings WHERE date = ? AND superseded_by IS NULL', [d.date]);
    if (prev && !d.notes) throw badRequest('RECOUNT_REASON_REQUIRED', 'This day is already closed. Give a reason for the re-count.');
    if (variance !== 0 && !d.notes) throw badRequest('VARIANCE_NOTE_REQUIRED', 'The counted cash does not match the expected amount. Add a note explaining the difference.');
    const r = run(
      `INSERT INTO day_closings(date, opening_float, cash_in, cash_refunds, cash_expenses, expected_cash, counted_cash, variance, card_total, transfer_total,
         notes, closed_by, closed_at, idempotency_key) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        d.date,
        d.openingFloat,
        s.methods.cash.received,
        s.methods.cash.refunded,
        s.cashExpenses,
        expected,
        d.countedCash,
        variance,
        s.methods.card.net,
        s.methods.bank_transfer.net,
        d.notes,
        user.id,
        nowIso(),
        d.idempotencyKey,
      ],
    );
    if (prev) run('UPDATE day_closings SET superseded_by = ? WHERE id = ?', [r.id, prev.id]);
    audit(user, prev ? 'day.recount' : 'day.close', {
      entityType: 'day_closing',
      entityId: r.id,
      summary: `Day ${d.date} ${prev ? 're-counted' : 'closed'} (variance ${variance / 100})`,
      meta: { expected, counted: d.countedCash, variance },
    });
    return { id: r.id, repeated: false };
  });
  res.status(201).json(result);
});
