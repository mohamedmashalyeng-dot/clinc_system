import { Router } from 'express';
import { all, camel, get, nowIso, run, scalar, tx } from '../db/db.js';
import { requirePerm } from '../auth.js';
import { audit } from '../audit.js';
import { badRequest, conflict, forbidden, intParam, notFound, optInt, optStr, pageParams, validate } from '../http.js';
import { clinicToday, getSettings } from '../settings.js';
import { inventoryItemSchema, receiveStockSchema, stockMovementSchema } from '../../shared/schemas.js';
import { rangeBoundsUtc } from '../../shared/time.js';
import { batchOnHand, batchesForItems, inventoryAlerts, itemsWithStock } from '../services/inventory.js';

export const inventoryRouter = Router();
type Row = Record<string, unknown>;

inventoryRouter.get('/items', requirePerm('inventory.view'), (req, res) => {
  const today = clinicToday();
  const warn = getSettings().expiryWarningDays;
  const q = optStr(req.query.q)?.toLowerCase();
  const filter = optStr(req.query.filter);
  let items = itemsWithStock(today, warn);
  if (q) items = items.filter((i) => [i.name, i.sku, i.category, i.supplier ?? ''].some((v) => v.toLowerCase().includes(q)));
  if (filter === 'low') items = items.filter((i) => i.lowStock);
  else if (filter === 'expiring') items = items.filter((i) => i.expiringBatches > 0 || i.expiredBatchesWithStock > 0);
  else if (filter === 'inactive') items = items.filter((i) => !i.active);
  else if (filter !== 'all') items = items.filter((i) => i.active);
  const { page, pageSize, offset } = pageParams(req.query, 25);
  res.json({ items: items.slice(offset, offset + pageSize), total: items.length, page, pageSize });
});

inventoryRouter.get('/items/:id', requirePerm('inventory.view'), (req, res) => {
  const id = intParam(req.params.id);
  const item = itemsWithStock(clinicToday(), getSettings().expiryWarningDays).find((i) => i.id === id);
  if (!item) throw notFound('Item');
  const movements = all<Row>(
    `SELECT m.*, b.batch_number, u.name AS created_by_name FROM stock_movements m JOIN inventory_batches b ON b.id = m.batch_id LEFT JOIN users u ON u.id = m.created_by
      WHERE m.item_id = ? ORDER BY m.id DESC LIMIT 100`,
    [id],
  ).map((r) => camel(r));
  res.json({ item, batches: batchesForItems(clinicToday(), getSettings().expiryWarningDays, [id]), movements });
});

function itemParams(d: ReturnType<typeof inventoryItemSchema.parse>) {
  return [d.sku, d.name, d.category, d.unit, d.supplier, d.reorderThreshold, d.unitCost, d.active];
}

inventoryRouter.post('/items', requirePerm('inventory.manage'), (req, res) => {
  const d = validate(inventoryItemSchema, req.body);
  if (scalar<number>('SELECT COUNT(*) FROM inventory_items WHERE sku = ?', [d.sku])) throw conflict('DUPLICATE_SKU', 'Another item already uses this SKU.');
  const r = run('INSERT INTO inventory_items(sku, name, category, unit, supplier, reorder_threshold, unit_cost, active, created_at) VALUES (?,?,?,?,?,?,?,?,?)', [
    ...itemParams(d),
    nowIso(),
  ]);
  audit(req.user, 'inventory.item_create', { entityType: 'inventory_item', entityId: r.id, summary: `Item ${d.sku} created` });
  res.status(201).json({ id: r.id });
});

inventoryRouter.put('/items/:id', requirePerm('inventory.manage'), (req, res) => {
  const id = intParam(req.params.id);
  const d = validate(inventoryItemSchema, req.body);
  if (scalar<number>('SELECT COUNT(*) FROM inventory_items WHERE sku = ? AND id <> ?', [d.sku, id])) throw conflict('DUPLICATE_SKU', 'Another item already uses this SKU.');
  const r = run('UPDATE inventory_items SET sku=?, name=?, category=?, unit=?, supplier=?, reorder_threshold=?, unit_cost=?, active=? WHERE id = ?', [...itemParams(d), id]);
  if (!r.changes) throw notFound('Item');
  audit(req.user, 'inventory.item_update', { entityType: 'inventory_item', entityId: id, summary: `Item ${d.sku} updated` });
  res.json({ ok: true });
});

inventoryRouter.post('/receive', requirePerm('inventory.manage'), (req, res) => {
  const d = validate(receiveStockSchema, req.body);
  const user = req.user!;
  const result = tx(() => {
    const existing = scalar<number | null>('SELECT id FROM stock_movements WHERE idempotency_key = ?', [d.idempotencyKey]);
    if (existing) return { movementId: existing, duplicate: true };
    if (!get('SELECT id FROM inventory_items WHERE id = ?', [d.itemId])) throw notFound('Item');
    let batch = get<{ id: number; expiry_date: string | null }>('SELECT id, expiry_date FROM inventory_batches WHERE item_id = ? AND batch_number = ?', [d.itemId, d.batchNumber]);
    if (batch && (batch.expiry_date ?? null) !== (d.expiryDate ?? null)) {
      throw conflict('BATCH_EXPIRY_MISMATCH', `Batch ${d.batchNumber} is already recorded with expiry ${batch.expiry_date ?? '—'}. Check the batch number or expiry.`);
    }
    if (d.expiryDate && d.expiryDate < clinicToday()) throw badRequest('ALREADY_EXPIRED', 'This batch has already expired and cannot be received into stock.');
    if (!batch) {
      const b = run('INSERT INTO inventory_batches(item_id, batch_number, expiry_date, unit_cost, received_at) VALUES (?,?,?,?,?)', [d.itemId, d.batchNumber, d.expiryDate, d.unitCost, nowIso()]);
      batch = { id: b.id, expiry_date: d.expiryDate };
    }
    const m = run(
      "INSERT INTO stock_movements(item_id, batch_id, type, quantity, reason, reference, created_by, created_at, idempotency_key) VALUES (?,?, 'purchase', ?, 'Stock received', ?, ?, ?, ?)",
      [d.itemId, batch.id, d.quantity, d.reference, user.id, nowIso(), d.idempotencyKey],
    );
    audit(user, 'inventory.receive', { entityType: 'inventory_batch', entityId: batch.id, summary: `Received ${d.quantity} into batch ${d.batchNumber}` });
    return { movementId: m.id, duplicate: false };
  });
  res.status(result.duplicate ? 200 : 201).json(result);
});

inventoryRouter.post('/movements', requirePerm('inventory.manage'), (req, res) => {
  const d = validate(stockMovementSchema, req.body);
  const user = req.user!;
  const result = tx(() => {
    const existing = scalar<number | null>('SELECT id FROM stock_movements WHERE idempotency_key = ?', [d.idempotencyKey]);
    if (existing) return { movementId: existing, duplicate: true };
    const batch = get<{ id: number; item_id: number; batch_number: string }>('SELECT id, item_id, batch_number FROM inventory_batches WHERE id = ?', [d.batchId]);
    if (!batch) throw notFound('Batch');
    const qty = d.type === 'waste' ? -Math.abs(d.quantity) : d.quantity;
    const onHand = batchOnHand(batch.id);
    let override: string | null = null;
    if (onHand + qty < 0) {
      if (!user.permissions.has('inventory.override')) {
        throw forbidden(`Only ${onHand} on hand in batch ${batch.batch_number}. Reducing below zero needs inventory override permission.`, 'INSUFFICIENT_STOCK', { onHand });
      }
      override = optStr(req.body.overrideReason);
      if (!override) throw badRequest('OVERRIDE_REASON_REQUIRED', 'Give a reason for taking this batch below zero.');
    }
    const m = run(
      'INSERT INTO stock_movements(item_id, batch_id, type, quantity, reason, override_reason, created_by, created_at, idempotency_key) VALUES (?,?,?,?,?,?,?,?,?)',
      [batch.item_id, batch.id, d.type, qty, d.reason, override, user.id, nowIso(), d.idempotencyKey],
    );
    audit(user, `inventory.${d.type}`, { entityType: 'inventory_batch', entityId: batch.id, summary: `${d.type} ${qty} on batch ${batch.batch_number}`, meta: { reason: d.reason, override } });
    return { movementId: m.id, duplicate: false };
  });
  res.status(result.duplicate ? 200 : 201).json(result);
});

inventoryRouter.get('/movements', requirePerm('inventory.view'), (req, res) => {
  const { page, pageSize, offset } = pageParams(req.query, 25);
  const where = ['1=1'];
  const params: unknown[] = [];
  const from = optStr(req.query.from);
  const to = optStr(req.query.to) ?? from;
  if (from && to) {
    const b = rangeBoundsUtc(from, to, getSettings().timezone);
    where.push('m.created_at >= ? AND m.created_at < ?');
    params.push(b.start, b.end);
  }
  const type = optStr(req.query.type);
  if (type) {
    where.push('m.type = ?');
    params.push(type);
  }
  const itemId = optInt(req.query.itemId);
  if (itemId) {
    where.push('m.item_id = ?');
    params.push(itemId);
  }
  const whereSql = where.join(' AND ');
  const total = scalar<number>(`SELECT COUNT(*) FROM stock_movements m WHERE ${whereSql}`, params);
  const rows = all<Row>(
    `SELECT m.*, i.name AS item_name, i.unit, i.sku, b.batch_number, u.name AS created_by_name FROM stock_movements m
       JOIN inventory_items i ON i.id = m.item_id JOIN inventory_batches b ON b.id = m.batch_id LEFT JOIN users u ON u.id = m.created_by
      WHERE ${whereSql} ORDER BY m.id DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, offset],
  );
  res.json({ items: rows.map((r) => camel(r)), total, page, pageSize });
});

inventoryRouter.get('/alerts', requirePerm('inventory.view'), (_req, res) => {
  res.json(inventoryAlerts(clinicToday(), getSettings().expiryWarningDays));
});
