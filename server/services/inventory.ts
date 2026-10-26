import { all, scalar } from '../db/db.js';
import { addDays } from '../../shared/time.js';

export function batchOnHand(batchId: number): number {
  return round(scalar<number>('SELECT COALESCE(SUM(quantity), 0) FROM stock_movements WHERE batch_id = ?', [batchId]));
}

export function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export interface BatchStock {
  id: number;
  itemId: number;
  batchNumber: string;
  expiryDate: string | null;
  onHand: number;
  expired: boolean;
  expiringSoon: boolean;
}

export function batchesForItems(today: string, warnDays: number, itemIds?: number[]): BatchStock[] {
  const filter = itemIds?.length ? `WHERE b.item_id IN (${itemIds.map(() => '?').join(',')})` : '';
  const limit = addDays(today, warnDays);
  return all<{ id: number; item_id: number; batch_number: string; expiry_date: string | null; on_hand: number }>(
    `SELECT b.id, b.item_id, b.batch_number, b.expiry_date, COALESCE(SUM(m.quantity), 0) AS on_hand
       FROM inventory_batches b LEFT JOIN stock_movements m ON m.batch_id = b.id
       ${filter}
      GROUP BY b.id
      ORDER BY b.item_id, CASE WHEN b.expiry_date IS NULL THEN 1 ELSE 0 END, b.expiry_date, b.id`,
    itemIds ?? [],
  ).map((b) => ({
    id: b.id,
    itemId: b.item_id,
    batchNumber: b.batch_number,
    expiryDate: b.expiry_date,
    onHand: round(b.on_hand),
    expired: !!b.expiry_date && b.expiry_date < today,
    expiringSoon: !!b.expiry_date && b.expiry_date >= today && b.expiry_date <= limit,
  }));
}

export interface ItemStock {
  id: number;
  sku: string;
  name: string;
  category: string;
  unit: string;
  supplier: string | null;
  reorderThreshold: number;
  unitCost: number;
  active: boolean;
  onHand: number;
  usableOnHand: number;
  lowStock: boolean;
  expiringBatches: number;
  expiredBatchesWithStock: number;
  nextExpiry: string | null;
}

export function itemsWithStock(today: string, warnDays: number): ItemStock[] {
  const items = all<Record<string, unknown>>('SELECT * FROM inventory_items ORDER BY name');
  const batches = batchesForItems(today, warnDays);
  return items.map((i) => {
    const bs = batches.filter((b) => b.itemId === i.id);
    const onHand = round(bs.reduce((s, b) => s + b.onHand, 0));
    const usableOnHand = round(bs.filter((b) => !b.expired).reduce((s, b) => s + b.onHand, 0));
    const withStock = bs.filter((b) => b.onHand > 0);
    const nextExpiry = withStock.filter((b) => b.expiryDate && !b.expired).map((b) => b.expiryDate!).sort()[0] ?? null;
    return {
      id: i.id as number,
      sku: i.sku as string,
      name: i.name as string,
      category: i.category as string,
      unit: i.unit as string,
      supplier: (i.supplier as string) ?? null,
      reorderThreshold: i.reorder_threshold as number,
      unitCost: i.unit_cost as number,
      active: !!i.active,
      onHand,
      usableOnHand,
      lowStock: !!i.active && usableOnHand <= (i.reorder_threshold as number),
      expiringBatches: withStock.filter((b) => b.expiringSoon).length,
      expiredBatchesWithStock: withStock.filter((b) => b.expired).length,
      nextExpiry,
    };
  });
}

export function inventoryAlerts(today: string, warnDays: number) {
  const items = itemsWithStock(today, warnDays);
  const batches = batchesForItems(today, warnDays).filter((b) => b.onHand > 0 && (b.expired || b.expiringSoon));
  const names = new Map(items.map((i) => [i.id, i]));
  return {
    lowStock: items.filter((i) => i.lowStock),
    expiringBatches: batches.map((b) => ({ ...b, itemName: names.get(b.itemId)?.name ?? '', unit: names.get(b.itemId)?.unit ?? '' })),
  };
}
