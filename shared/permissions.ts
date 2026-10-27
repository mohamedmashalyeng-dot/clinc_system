// Permission catalogue shared by the API (enforcement) and the UI (display only).
// The server is the source of truth: hiding a button in the UI is never the control.

export const ROLES = ['owner', 'receptionist', 'practitioner', 'accountant', 'assistant', 'call_center'] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  'dashboard.view',
  // Patients (administrative)
  'patients.view',
  'patients.view_all', // without it, a practitioner only sees assigned patients
  'patients.edit',
  // Clinical — never implied by administrative access
  'medical.view',
  'medical.edit',
  'clinical_notes.view',
  'clinical_notes.edit',
  'photos.view',
  'photos.upload',
  'clinical_documents.view',
  'treatment.perform',
  'aftercare.approve',
  // Scheduling
  'appointments.view',
  'appointments.manage',
  'appointments.checkin',
  // Packages
  'packages.view',
  'packages.sell',
  'packages.adjust',
  'sessions.reverse',
  // Finance
  'billing.view',
  'payments.record',
  'discounts.apply',
  'refunds.issue',
  'invoices.adjust',
  'expenses.manage',
  'reports.financial',
  'reports.operational',
  // Inventory
  'inventory.view',
  'inventory.manage',
  'inventory.override',
  // Follow-up & consents
  'followup.view',
  'followup.manage',
  'templates.manage',
  'consents.view',
  'consents.manage',
  // Administration
  'settings.manage',
  'staff.manage',
  'permissions.manage',
  'audit.view',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** Permissions that expose or change sensitive clinical content. */
export const CLINICAL_PERMISSIONS: readonly Permission[] = [
  'medical.view',
  'medical.edit',
  'clinical_notes.view',
  'clinical_notes.edit',
  'photos.view',
  'photos.upload',
  'clinical_documents.view',
  'treatment.perform',
  'aftercare.approve',
];

export const PERMISSION_GROUPS: { key: string; permissions: Permission[] }[] = [
  { key: 'general', permissions: ['dashboard.view', 'audit.view'] },
  { key: 'patients', permissions: ['patients.view', 'patients.view_all', 'patients.edit', 'consents.view', 'consents.manage'] },
  {
    key: 'clinical',
    permissions: [
      'medical.view',
      'medical.edit',
      'clinical_notes.view',
      'clinical_notes.edit',
      'photos.view',
      'photos.upload',
      'clinical_documents.view',
      'treatment.perform',
      'aftercare.approve',
    ],
  },
  { key: 'scheduling', permissions: ['appointments.view', 'appointments.manage', 'appointments.checkin'] },
  { key: 'packages', permissions: ['packages.view', 'packages.sell', 'packages.adjust', 'sessions.reverse'] },
  {
    key: 'finance',
    permissions: [
      'billing.view',
      'payments.record',
      'discounts.apply',
      'refunds.issue',
      'invoices.adjust',
      'expenses.manage',
      'reports.financial',
      'reports.operational',
    ],
  },
  { key: 'inventory', permissions: ['inventory.view', 'inventory.manage', 'inventory.override'] },
  { key: 'followup', permissions: ['followup.view', 'followup.manage', 'templates.manage'] },
  { key: 'admin', permissions: ['settings.manage', 'staff.manage', 'permissions.manage'] },
];

export const DEFAULT_ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  // Owner: full operational and financial oversight, but no clinical content by default.
  owner: PERMISSIONS.filter((p) => !CLINICAL_PERMISSIONS.includes(p)),
  receptionist: [
    'dashboard.view',
    'patients.view',
    'patients.view_all',
    'patients.edit',
    'appointments.view',
    'appointments.manage',
    'appointments.checkin',
    'packages.view',
    'packages.sell',
    'billing.view',
    'payments.record',
    'followup.view',
    'followup.manage',
    'consents.view',
    'consents.manage',
    'inventory.view',
  ],
  practitioner: [
    'dashboard.view',
    'patients.view',
    'medical.view',
    'medical.edit',
    'clinical_notes.view',
    'clinical_notes.edit',
    'photos.view',
    'photos.upload',
    'clinical_documents.view',
    'treatment.perform',
    'aftercare.approve',
    'appointments.view',
    'appointments.checkin',
    'packages.view',
    'consents.view',
    'consents.manage',
    'inventory.view',
    'followup.view',
    'followup.manage',
    'reports.operational',
  ],
  accountant: [
    'dashboard.view',
    'patients.view',
    'patients.view_all',
    'appointments.view',
    'packages.view',
    'billing.view',
    'payments.record',
    'discounts.apply',
    'refunds.issue',
    'invoices.adjust',
    'expenses.manage',
    'reports.financial',
    'reports.operational',
    'inventory.view',
  ],
  // Nurse / clinical assistant: front-of-room flow, consents, before/after photos and stock.
  assistant: [
    'dashboard.view',
    'patients.view',
    'patients.view_all',
    'appointments.view',
    'appointments.checkin',
    'packages.view',
    'consents.view',
    'consents.manage',
    'photos.view',
    'photos.upload',
    'inventory.view',
    'inventory.manage',
    'followup.view',
  ],
  // Call centre & marketing: bookings, reminders, win-back and growth lists — no money, no clinical data.
  call_center: [
    'dashboard.view',
    'patients.view',
    'patients.view_all',
    'patients.edit',
    'appointments.view',
    'appointments.manage',
    'packages.view',
    'followup.view',
    'followup.manage',
    'templates.manage',
    'consents.view',
    'reports.operational',
  ],
};

export function isPermission(value: string): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value);
}

export function hasPermission(perms: readonly string[] | Set<string>, p: Permission): boolean {
  return perms instanceof Set ? perms.has(p) : perms.includes(p);
}
