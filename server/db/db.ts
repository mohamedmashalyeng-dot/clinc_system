import { DatabaseSync, type StatementSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DATA_DIR = path.resolve(process.env.LUMA_DATA_DIR ?? 'data');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');

type Scalar = string | number | bigint | null | Uint8Array;
type Params = unknown[] | Record<string, unknown>;

let db: DatabaseSync | null = null;
const cache = new Map<string, StatementSync>();
let txDepth = 0;

export function openDb(file = path.join(DATA_DIR, 'clinic.db')): DatabaseSync {
  if (db) return db;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');
  const schema = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'schema.sql'), 'utf8');
  db.exec(schema);
  migrate(db);
  return db;
}

/** Additive changes for databases created by an earlier build (CREATE TABLE IF NOT EXISTS leaves existing tables as they were). */
function migrate(d: DatabaseSync): void {
  const hasColumn = (table: string, column: string) => (d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column);
  for (const table of ['rooms', 'devices']) if (!hasColumn(table, 'name_ar')) d.exec(`ALTER TABLE ${table} ADD COLUMN name_ar TEXT`);
}

export function closeDb(): void {
  cache.clear();
  db?.close();
  db = null;
}

function conn(): DatabaseSync {
  if (!db) throw new Error('Database not opened');
  return db;
}

function stmt(sql: string): StatementSync {
  let s = cache.get(sql);
  if (!s) {
    s = conn().prepare(sql);
    cache.set(sql, s);
  }
  return s;
}

function bind(v: unknown): Scalar {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number' || typeof v === 'string' || typeof v === 'bigint' || v instanceof Uint8Array) return v;
  return JSON.stringify(v);
}

function exec<T>(sql: string, params: Params | undefined, mode: 'all' | 'get' | 'run'): T {
  const s = stmt(sql);
  if (params === undefined) return s[mode]() as T;
  if (Array.isArray(params)) return s[mode](...params.map(bind)) as T;
  const named: Record<string, Scalar> = {};
  for (const [k, v] of Object.entries(params)) named[k] = bind(v);
  return s[mode](named) as T;
}

export function all<T = Record<string, unknown>>(sql: string, params?: Params): T[] {
  return exec<T[]>(sql, params, 'all');
}

export function get<T = Record<string, unknown>>(sql: string, params?: Params): T | undefined {
  return exec<T | undefined>(sql, params, 'get');
}

export function run(sql: string, params?: Params): { changes: number; id: number } {
  const r = exec<{ changes: number | bigint; lastInsertRowid: number | bigint }>(sql, params, 'run');
  return { changes: Number(r.changes), id: Number(r.lastInsertRowid) };
}

export function scalar<T = number>(sql: string, params?: Params): T {
  const row = get<Record<string, unknown>>(sql, params);
  return (row ? Object.values(row)[0] : null) as T;
}

/**
 * Run `fn` atomically. The outer call takes the write lock up front (BEGIN IMMEDIATE),
 * so a check-then-write sequence (availability, balances, stock) cannot interleave with
 * another writer. Nested calls use savepoints.
 */
export function tx<T>(fn: () => T): T {
  const c = conn();
  const depth = txDepth;
  c.exec(depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT sp${depth}`);
  txDepth++;
  try {
    const result = fn();
    txDepth--;
    c.exec(depth === 0 ? 'COMMIT' : `RELEASE sp${depth}`);
    return result;
  } catch (err) {
    txDepth--;
    c.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO sp${depth}; RELEASE sp${depth}`);
    throw err;
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function nextNumber(name: string, prefix: string, year = new Date().getFullYear()): string {
  const key = `${name}:${year}`;
  run('INSERT INTO counters(name, value) VALUES (?, 1) ON CONFLICT(name) DO UPDATE SET value = value + 1', [key]);
  const value = scalar<number>('SELECT value FROM counters WHERE name = ?', [key]);
  return `${prefix}-${year}-${String(value).padStart(5, '0')}`;
}

export function parseJson<T>(text: unknown, fallback: T): T {
  if (typeof text !== 'string' || !text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/** snake_case row → camelCase object (shallow). */
export function camel<T = Record<string, unknown>>(row: Record<string, unknown> | undefined): T {
  if (!row) return row as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[k.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase())] = v;
  return out as T;
}

export function camelAll<T = Record<string, unknown>>(rows: Record<string, unknown>[]): T[] {
  return rows.map((r) => camel<T>(r));
}
