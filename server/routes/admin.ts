import express, { Router, type Request } from 'express';
import type { ZodTypeAny, z } from 'zod';
import { all, camel, get, nowIso, parseJson, run, scalar, tx } from '../db/db.js';
import { hashPassword, requireAuth, requirePerm } from '../auth.js';
import { audit } from '../audit.js';
import { badRequest, conflict, forbidden, intParam, notFound, optInt, optStr, pageParams, validate } from '../http.js';
import { DEMO_MODE, getSettings, invalidateSettings } from '../settings.js';
import {
  categorySchema,
  consentTemplateSchema,
  deviceSchema,
  packageTemplateSchema,
  practitionerSchema,
  qualificationSchema,
  rolePermissionsSchema,
  roomSchema,
  serviceSchema,
  settingsSchema,
  staffSchema,
} from '../../shared/schemas.js';
import { CLINICAL_PERMISSIONS, PERMISSIONS, ROLES, isPermission, type Permission } from '../../shared/permissions.js';
import { listDevices, listPractitioners, listRooms, listServices } from '../services/reference.js';
import { sendPrivateFile, storePrivateFile } from '../files.js';

export const adminRouter = Router();
type Row = Record<string, unknown>;

// ---- Reference data used across the UI -------------------------------------

adminRouter.get('/reference', requireAuth, (_req, res) => {
  res.json({
    services: listServices(),
    categories: all<Row>('SELECT * FROM service_categories ORDER BY id').map((r) => ({ ...camel(r), active: !!r.active })),
    practitioners: listPractitioners(),
    rooms: listRooms(),
    devices: listDevices(),
    qualifications: all<Row>('SELECT * FROM qualifications ORDER BY code').map((r) => camel(r)),
    packageTemplates: all<Row>('SELECT * FROM package_templates ORDER BY name_en').map((t) => ({
      ...camel(t),
      active: !!t.active,
      items: all<Row>('SELECT service_id, quantity FROM package_template_items WHERE template_id = ?', [t.id]).map((i) => camel(i)),
    })),
    consentTemplates: all<Row>('SELECT * FROM consent_templates ORDER BY type, id').map((r) => ({ ...camel(r), active: !!r.active })),
    users: all<Row>('SELECT id, name, role, active FROM users ORDER BY name').map((r) => ({ ...camel(r), active: !!r.active })),
  });
});

// ---- Clinic settings ----------------------------------------------------------

adminRouter.put('/settings', requirePerm('settings.manage'), (req, res) => {
  const d = validate(settingsSchema, req.body);
  const current = getSettings();
  run('UPDATE settings SET data = ?, updated_at = ?, updated_by = ? WHERE id = 1', [JSON.stringify({ ...current, ...d, integrations: current.integrations }), nowIso(), req.user!.id]);
  invalidateSettings();
  audit(req.user, 'settings.update', { entityType: 'settings', summary: 'Clinic settings updated' });
  res.json({ ok: true });
});

adminRouter.post('/settings/logo', requirePerm('settings.manage'), express.raw({ type: ['image/png', 'image/jpeg', 'image/webp'], limit: '2mb' }), (req, res) => {
  const f = storePrivateFile(req.body as Buffer, ['image/png', 'image/jpeg', 'image/webp'], 'branding');
  run('UPDATE settings SET logo_file = ?, data = json_set(data, \'$.logoMime\', ?) WHERE id = 1', [f.fileName, f.mime]);
  invalidateSettings();
  audit(req.user, 'settings.logo', { entityType: 'settings', summary: 'Clinic logo updated' });
  res.json({ ok: true });
});

adminRouter.delete('/settings/logo', requirePerm('settings.manage'), (req, res) => {
  run('UPDATE settings SET logo_file = NULL WHERE id = 1');
  audit(req.user, 'settings.logo_remove', { entityType: 'settings', summary: 'Clinic logo removed' });
  res.json({ ok: true });
});

adminRouter.get('/settings/logo', (_req, res) => {
  const row = get<{ logo_file: string | null; mime: string | null }>("SELECT logo_file, json_extract(data, '$.logoMime') AS mime FROM settings WHERE id = 1");
  if (!row?.logo_file) throw notFound('Logo');
  sendPrivateFile(res, row.logo_file, row.mime ?? 'image/png');
});

// ---- Configuration entities (deactivated, never deleted, so history stays intact) ----

function crud<S extends ZodTypeAny>(path: string, table: string, schema: S, columns: (d: z.output<S>) => Record<string, unknown>) {
  adminRouter.post(`/${path}`, requirePerm('settings.manage'), (req, res) => {
    const d = validate(schema, req.body);
    const id = tx(() => {
      const cols = columns(d);
      const keys = Object.keys(cols);
      const r = run(`INSERT INTO ${table}(${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, Object.values(cols));
      audit(req.user, `${path}.create`, { entityType: table, entityId: r.id, summary: `${table} #${r.id} created` });
      return r.id;
    });
    res.status(201).json({ id });
  });
  adminRouter.put(`/${path}/:id`, requirePerm('settings.manage'), (req, res) => {
    const id = intParam(req.params.id);
    const d = validate(schema, req.body);
    tx(() => {
      const cols = columns(d);
      const r = run(`UPDATE ${table} SET ${Object.keys(cols).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, [...Object.values(cols), id]);
      if (!r.changes) throw notFound();
      audit(req.user, `${path}.update`, { entityType: table, entityId: id, summary: `${table} #${id} updated` });
    });
    res.json({ ok: true });
  });
}

crud('service-categories', 'service_categories', categorySchema, (d) => ({ name_en: d.nameEn, name_ar: d.nameAr, active: d.active }));
crud('rooms', 'rooms', roomSchema, (d) => ({ name: d.name, name_ar: d.nameAr, active: d.active }));
crud('devices', 'devices', deviceSchema, (d) => ({ name: d.name, name_ar: d.nameAr, model: d.model, room_id: d.roomId, active: d.active, maintenance_note: d.maintenanceNote }));
crud('services', 'services', serviceSchema, (d) => {
  if (d.qualification && !scalar<number>('SELECT COUNT(*) FROM qualifications WHERE code = ?', [d.qualification])) {
    throw badRequest('UNKNOWN_QUALIFICATION', 'Choose a qualification from the list.');
  }
  return {
    name_en: d.nameEn,
    name_ar: d.nameAr,
    category_id: d.categoryId,
    duration_min: d.durationMin,
    price: d.price,
    deposit_amount: d.depositAmount,
    qualification: d.qualification,
    room_ids: JSON.stringify(d.roomIds),
    device_ids: JSON.stringify(d.deviceIds),
    buffer_before_min: d.bufferBeforeMin,
    buffer_after_min: d.bufferAfterMin,
    active: d.active,
  };
});
crud('practitioners', 'practitioners', practitionerSchema, (d) => ({
  display_name: d.displayName,
  display_name_ar: d.displayNameAr,
  user_id: d.userId,
  qualifications: JSON.stringify(d.qualifications),
  color: d.color,
  hours: JSON.stringify(d.hours),
  active: d.active,
}));
function savePackageTemplate(req: Request, id: number | null): number {
  const d = validate(packageTemplateSchema, req.body);
  if (new Set(d.items.map((i) => i.serviceId)).size !== d.items.length) throw badRequest('DUPLICATE_SERVICE', 'Each service can appear only once in a package.');
  return tx(() => {
    const vals = [d.nameEn, d.nameAr, d.price, d.validityDays, d.termsEn, d.termsAr, d.active];
    if (id) {
      const r = run('UPDATE package_templates SET name_en=?, name_ar=?, price=?, validity_days=?, terms_en=?, terms_ar=?, active=? WHERE id = ?', [...vals, id]);
      if (!r.changes) throw notFound('Package template');
    } else {
      id = run('INSERT INTO package_templates(name_en, name_ar, price, validity_days, terms_en, terms_ar, active, created_at) VALUES (?,?,?,?,?,?,?,?)', [...vals, nowIso()]).id;
    }
    // Purchased packages keep their own snapshot of items, so editing a template never changes past sales.
    run('DELETE FROM package_template_items WHERE template_id = ?', [id]);
    for (const it of d.items) run('INSERT INTO package_template_items(template_id, service_id, quantity) VALUES (?,?,?)', [id, it.serviceId, it.quantity]);
    audit(req.user, 'package_template.save', { entityType: 'package_template', entityId: id, summary: `Package template "${d.nameEn}" saved` });
    return id;
  });
}

adminRouter.post('/package-templates', requirePerm('settings.manage'), (req, res) => {
  res.status(201).json({ id: savePackageTemplate(req, null) });
});
adminRouter.put('/package-templates/:id', requirePerm('settings.manage'), (req, res) => {
  res.json({ id: savePackageTemplate(req, intParam(req.params.id)) });
});

adminRouter.post('/qualifications', requirePerm('settings.manage'), (req, res) => {
  const d = validate(qualificationSchema, req.body);
  if (scalar<number>('SELECT COUNT(*) FROM qualifications WHERE code = ?', [d.code])) throw conflict('DUPLICATE', 'That code already exists.');
  run('INSERT INTO qualifications(code, name_en, name_ar) VALUES (?,?,?)', [d.code, d.nameEn, d.nameAr]);
  audit(req.user, 'qualifications.create', { entityType: 'qualification', summary: `Qualification ${d.code} created` });
  res.status(201).json({ ok: true });
});

adminRouter.put('/qualifications/:code', requirePerm('settings.manage'), (req, res) => {
  const d = validate(qualificationSchema, { ...req.body, code: req.params.code });
  const r = run('UPDATE qualifications SET name_en = ?, name_ar = ? WHERE code = ?', [d.nameEn, d.nameAr, d.code]);
  if (!r.changes) throw notFound('Qualification');
  res.json({ ok: true });
});

adminRouter.post('/consent-templates', requirePerm('settings.manage'), (req, res) => {
  const d = validate(consentTemplateSchema, req.body);
  const now = nowIso();
  const r = run(
    'INSERT INTO consent_templates(type, title_en, title_ar, body_en, body_ar, version, active, created_at, updated_at) VALUES (?,?,?,?,?,1,?,?,?)',
    [d.type, d.titleEn, d.titleAr, d.bodyEn, d.bodyAr, d.active, now, now],
  );
  audit(req.user, 'consent_template.create', { entityType: 'consent_template', entityId: r.id, summary: `Consent template created (${d.type})` });
  res.status(201).json({ id: r.id });
});

adminRouter.put('/consent-templates/:id', requirePerm('settings.manage'), (req, res) => {
  const id = intParam(req.params.id);
  const d = validate(consentTemplateSchema, req.body);
  const cur = get<Row>('SELECT * FROM consent_templates WHERE id = ?', [id]);
  if (!cur) throw notFound('Consent template');
  if (cur.type !== d.type) throw badRequest('TYPE_LOCKED', 'The consent type cannot change. Create a new template instead.');
  // Wording changes create a new version; consents already given keep the version they agreed to.
  const textChanged = cur.body_en !== d.bodyEn || cur.body_ar !== d.bodyAr || cur.title_en !== d.titleEn || cur.title_ar !== d.titleAr;
  run('UPDATE consent_templates SET title_en=?, title_ar=?, body_en=?, body_ar=?, active=?, version = version + ?, updated_at=? WHERE id = ?', [
    d.titleEn,
    d.titleAr,
    d.bodyEn,
    d.bodyAr,
    d.active,
    textChanged ? 1 : 0,
    nowIso(),
    id,
  ]);
  audit(req.user, 'consent_template.update', { entityType: 'consent_template', entityId: id, summary: `Consent template updated${textChanged ? ' (new version)' : ''}` });
  res.json({ ok: true });
});

// ---- Staff and permissions -------------------------------------------------

adminRouter.get('/staff', requirePerm('staff.manage'), (_req, res) => {
  const rows = all<Row>('SELECT u.id, u.name, u.email, u.role, u.active, u.extra_permissions, u.last_login_at, p.id AS practitioner_id FROM users u LEFT JOIN practitioners p ON p.user_id = u.id ORDER BY u.name');
  res.json({ items: rows.map((r) => ({ ...camel(r), active: !!r.active, extraPermissions: parseJson<string[]>(r.extra_permissions, []) })) });
});

function cleanPermissions(list: string[]): Permission[] {
  const bad = list.filter((p) => !isPermission(p));
  if (bad.length) throw badRequest('UNKNOWN_PERMISSION', `Unknown permission: ${bad.join(', ')}`);
  return [...new Set(list)] as Permission[];
}

adminRouter.post('/staff', requirePerm('staff.manage'), (req, res) => {
  const d = validate(staffSchema, req.body);
  if (!d.password) throw badRequest('PASSWORD_REQUIRED', 'Set an initial password of at least 8 characters.');
  if (scalar<number>('SELECT COUNT(*) FROM users WHERE email = ?', [d.email])) throw conflict('DUPLICATE_EMAIL', 'A user with this email already exists.');
  const extra = cleanPermissions(d.extraPermissions);
  const r = run('INSERT INTO users(name, email, password_hash, role, extra_permissions, active, created_at) VALUES (?,?,?,?,?,?,?)', [
    d.name,
    d.email,
    hashPassword(d.password),
    d.role,
    JSON.stringify(extra),
    d.active,
    nowIso(),
  ]);
  audit(req.user, 'staff.create', { entityType: 'user', entityId: r.id, summary: `User created with role ${d.role}`, meta: { clinicalGrants: extra.filter((p) => CLINICAL_PERMISSIONS.includes(p)) } });
  res.status(201).json({ id: r.id });
});

adminRouter.put('/staff/:id', requirePerm('staff.manage'), (req, res) => {
  const id = intParam(req.params.id);
  const d = validate(staffSchema, req.body);
  const cur = get<Row>('SELECT * FROM users WHERE id = ?', [id]);
  if (!cur) throw notFound('User');
  if (id === req.user!.id && (!d.active || d.role !== cur.role)) throw forbidden('You cannot deactivate yourself or change your own role.');
  if (scalar<number>('SELECT COUNT(*) FROM users WHERE email = ? AND id <> ?', [d.email, id])) throw conflict('DUPLICATE_EMAIL', 'A user with this email already exists.');
  const extra = cleanPermissions(d.extraPermissions);
  const before = parseJson<string[]>(cur.extra_permissions, []);
  run(`UPDATE users SET name=?, email=?, role=?, extra_permissions=?, active=?${d.password ? ', password_hash = ?' : ''} WHERE id = ?`, [
    d.name,
    d.email,
    d.role,
    JSON.stringify(extra),
    d.active,
    ...(d.password ? [hashPassword(d.password)] : []),
    id,
  ]);
  if (!d.active) run('DELETE FROM auth_sessions WHERE user_id = ?', [id]);
  audit(req.user, 'staff.update', {
    entityType: 'user',
    entityId: id,
    summary: `User updated${d.password ? ' (password reset)' : ''}`,
    meta: { added: extra.filter((p) => !before.includes(p)), removed: before.filter((p) => !extra.includes(p as Permission)) },
  });
  res.json({ ok: true });
});

adminRouter.get('/permissions', requirePerm('permissions.manage'), (_req, res) => {
  const roles = Object.fromEntries(ROLES.map((r) => [r, all<{ permission: string }>('SELECT permission FROM role_permissions WHERE role = ?', [r]).map((x) => x.permission)]));
  res.json({ roles, catalogue: PERMISSIONS, clinical: CLINICAL_PERMISSIONS });
});

adminRouter.put('/permissions', requirePerm('permissions.manage'), (req, res) => {
  const d = validate(rolePermissionsSchema, req.body);
  const perms = cleanPermissions(d.permissions);
  if (d.role === 'owner' && (!perms.includes('permissions.manage') || !perms.includes('staff.manage'))) {
    throw forbidden('The owner role must keep staff and permission management, or nobody could undo this change.', 'LOCKOUT_PREVENTED');
  }
  const before = all<{ permission: string }>('SELECT permission FROM role_permissions WHERE role = ?', [d.role]).map((x) => x.permission);
  tx(() => {
    run('DELETE FROM role_permissions WHERE role = ?', [d.role]);
    for (const p of perms) run('INSERT INTO role_permissions(role, permission) VALUES (?,?)', [d.role, p]);
  });
  const added = perms.filter((p) => !before.includes(p));
  audit(req.user, 'permissions.update', {
    entityType: 'role',
    summary: `Permissions changed for role ${d.role}`,
    meta: { reason: d.reason, added, removed: before.filter((p) => !perms.includes(p as Permission)), clinicalGranted: added.filter((p) => CLINICAL_PERMISSIONS.includes(p)) },
  });
  res.json({ ok: true });
});

adminRouter.get('/audit', requirePerm('audit.view'), (req, res) => {
  const { page, pageSize, offset } = pageParams(req.query, 30);
  const where = ['1=1'];
  const params: unknown[] = [];
  if (req.query.sensitive === '1') where.push('e.sensitive = 1');
  const userId = optInt(req.query.userId);
  if (userId) {
    where.push('e.user_id = ?');
    params.push(userId);
  }
  const action = optStr(req.query.action);
  if (action) {
    where.push('e.action LIKE ?');
    params.push(`${action}%`);
  }
  const patientId = optInt(req.query.patientId);
  if (patientId) {
    where.push('e.patient_id = ?');
    params.push(patientId);
  }
  const whereSql = where.join(' AND ');
  const total = scalar<number>(`SELECT COUNT(*) FROM audit_events e WHERE ${whereSql}`, params);
  const rows = all<Row>(
    `SELECT e.*, u.name AS user_name, p.code AS patient_code FROM audit_events e LEFT JOIN users u ON u.id = e.user_id LEFT JOIN patients p ON p.id = e.patient_id
      WHERE ${whereSql} ORDER BY e.id DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, offset],
  );
  res.json({ items: rows.map((r) => ({ ...camel(r), sensitive: !!r.sensitive, meta: parseJson(r.meta, null) })), total, page, pageSize });
});

// ---- Demo reset ------------------------------------------------------------------

adminRouter.post('/demo/reset', requirePerm('settings.manage'), async (req, res) => {
  if (!DEMO_MODE) throw forbidden('Demo reset is only available in demo mode.');
  const { resetDemoData } = await import('../db/seed.js');
  audit(req.user, 'demo.reset', { summary: 'Demo data reset requested' });
  resetDemoData();
  res.json({ ok: true });
});
