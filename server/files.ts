import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Response } from 'express';
import { UPLOAD_DIR } from './db/db.js';
import { badRequest, notFound } from './http.js';

const SIGNATURES: { mime: string; test: (b: Buffer) => boolean }[] = [
  { mime: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/png', test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: 'image/webp', test: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
  { mime: 'application/pdf', test: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
];

/** Identify a file by its content, not by the name or header the client sent. */
export function sniffMime(buf: Buffer): string | null {
  return SIGNATURES.find((s) => s.test(buf))?.mime ?? null;
}

const EXT: Record<string, string> = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'application/pdf': '.pdf', 'image/svg+xml': '.svg' };

export function storePrivateFile(buf: Buffer, allowed: string[], subdir: string, trustedMime?: string): { fileName: string; mime: string; size: number; sha256: string } {
  if (!buf?.length) throw badRequest('EMPTY_FILE', 'No file was received.');
  const mime = trustedMime ?? sniffMime(buf);
  if (!mime || !allowed.includes(mime)) {
    throw badRequest('UNSUPPORTED_FILE', `Unsupported file type. Allowed: ${allowed.map((m) => m.split('/')[1].toUpperCase()).join(', ')}.`);
  }
  const dir = path.join(UPLOAD_DIR, subdir);
  fs.mkdirSync(dir, { recursive: true });
  const fileName = `${subdir}/${crypto.randomBytes(16).toString('hex')}${EXT[mime] ?? ''}`;
  // Written once and never modified: originals are kept exactly as uploaded.
  fs.writeFileSync(path.join(UPLOAD_DIR, fileName), buf, { flag: 'wx' });
  return { fileName, mime, size: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') };
}

export function sendPrivateFile(res: Response, fileName: string, mime: string, downloadName?: string): void {
  const full = path.resolve(UPLOAD_DIR, fileName);
  if (!full.startsWith(path.resolve(UPLOAD_DIR)) || !fs.existsSync(full)) throw notFound('File');
  res.setHeader('Content-Type', mime);
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:");
  res.setHeader('Content-Disposition', `${downloadName ? 'attachment' : 'inline'}; filename="${(downloadName ?? path.basename(fileName)).replace(/"/g, '')}"`);
  fs.createReadStream(full).pipe(res);
}
