# Luma Clinic — clinic management (demo build)

An operational management application for an aesthetic, laser and skincare clinic. Appointments,
patient records, treatment sessions, packages, billing, inventory and follow-up share one data model,
so a completed session updates the package balance, stock and invoices in a single step.

"Luma Clinic" is a placeholder name; change it under **Settings → Clinic details**.

> **Demo mode.** This build ships with a local SQLite database seeded with **fictional** patients,
> staff and records. Messaging (WhatsApp/SMS/email), online card payments and cloud file storage are
> **not connected** — see [What is not connected](#what-is-not-connected-and-production-requirements).

## Quick start

Requirements: **Node.js 22.13 or newer** (uses the built-in `node:sqlite`; developed on Node 24). No
database server or native build tools are needed.

On Windows, double-click **`start.bat`**: it installs dependencies on first run, starts the app and
opens the browser. Keep its window open while using the app; closing it stops the app.

Or from a terminal:

```bash
npm install
npm run dev          # API on :4000 (auto-reload) + web app on http://127.0.0.1:5173
```

On first start the API creates `data/clinic.db` and loads the demo data. Open
<http://127.0.0.1:5173> (or <http://localhost:5173>) and sign in with a demo account (the sign-in
page has one-click buttons). The page only loads while the app is running — if the browser says it
can't connect, start it again.

| Role | Email | Password |
|---|---|---|
| Owner / Admin | `owner@luma.demo` | `demo1234` |
| Receptionist | `reception@luma.demo` (also `reception2@luma.demo`) | `demo1234` |
| Practitioner | `dr.nour@luma.demo` (also `dr.karim@luma.demo`, `salma@luma.demo`) | `demo1234` |
| Accountant | `accounts@luma.demo` | `demo1234` |

Other commands:

```bash
npm test             # end-to-end API test of the acceptance scenario (throwaway database)
npm run seed         # wipe data/ and reload fresh demo data (stop the server first)
npm run typecheck    # TypeScript, client and server
npm run build        # typecheck + production web build into dist/
npm start            # production mode: one process serves the API and dist/ on :4000
```

The demo data is generated relative to **today** (about four months of history and two weeks of
bookings), so the schedule always looks current. Owners can also reset it from
**Settings → Demo data**.

### Configuration

| Variable | Default | Purpose |
|---|---|---|
| `API_PORT` / `PORT` | `4000` | API port (in production it also serves the web app) |
| `LUMA_DATA_DIR` | `./data` | Database and private uploads location |
| `LUMA_DEMO_MODE` | `true` | `false` hides demo accounts/reset and refuses to seed an empty database |
| `NODE_ENV` | — | `production` serves `dist/` and marks the session cookie `Secure` |
| `LUMA_INSECURE_COOKIES` | — | `true` drops the `Secure` flag (only for local HTTP testing in production mode) |

Clinic currency (default **EGP**), time zone (default **Africa/Cairo**), tax rate, opening hours,
booking grid and cancellation rules are set in the app under **Settings**. Rooms and devices have an
English and an Arabic name (**Settings → Rooms & devices**); an empty Arabic name falls back to the
English one. A database created by an earlier build is upgraded in place on start.

## How it fits together

```
shared/    Domain rules used by both sides: permissions, money, time zones, validation schemas
server/    Express API + SQLite
  db/        schema.sql (tables, indexes, triggers), db helpers, demo seed
  services/  scheduling, packages, finance, inventory, session completion (transactional logic)
  routes/    HTTP endpoints; every route checks permissions on the server
src/       React + TypeScript web app (React Router, TanStack Query)
  components/ one design system (buttons, fields, dialogs, drawers, tables, badges)
  pages/      dashboard, appointments, patients (8 tabs), workspace, billing, inventory, …
  i18n/       English and Arabic dictionaries (Arabic is type-checked against English)
tests/     e2e.test.ts — the acceptance scenario against the real API
```

Key decisions:

- **Balances are derived, never stored.** Package sessions remaining = purchased quantity + Σ of a
  usage ledger (consume / reversal / adjustment). Stock on hand = Σ of stock movements per batch.
  Invoice balance = total − payments + refunds. Reports and the dashboard read the same records.
- **Completing a session is one transaction** (`server/services/sessions.ts`): consent check →
  package ledger entry → stock deductions (expired batches and shortages blocked unless someone with
  override permission gives a reason) → appointment completed → invoice raised for non-package
  services → follow-up scheduled. Unique indexes make a second package or stock deduction for the
  same session impossible, so repeated clicks and retries return the existing result.
- **Booking, cancellation and no-show never touch the package ledger.** A package session is used
  only when the treatment session is completed. Reversal needs `sessions.reverse`, a reason, and adds
  a traceable reversal entry (optionally returning stock).
- **No double booking.** Availability is checked inside a write-locked transaction
  (`BEGIN IMMEDIATE`) and again by a database trigger that rejects overlapping practitioner, room or
  device time (including preparation/cleanup buffers). Conflicts return an explanation and the
  nearest free alternatives.
- **Practitioner time off** (leave, sickness, training — whole days or part of one day) is recorded
  under **Appointments → Time off** by anyone who can manage bookings. New bookings that overlap it
  are refused like any other conflict and the slot finder skips it. Existing bookings are never
  cancelled automatically: recording time off over them lists them and asks for confirmation, and the
  time-off record keeps showing them until each is rescheduled. Cancelling time off needs a reason and
  keeps the record. The type and note are shown only to schedulers and to the practitioner concerned;
  other staff see "Unavailable".
- **Money is integer minor units** (piastres) and computed by one shared function on both sides.
  Payments, refunds, expenses and invoices carry idempotency keys; history is kept through
  adjustments, voids and linked refunds rather than deletion.
- **Time:** instants are stored in UTC; everything shown, booked and reported uses the clinic's
  configured time zone, not the browser's or server's.
- **Clinical data is separate from administrative access.** Medical history, treatment notes, clinical
  photos and clinical documents need explicit clinical permissions; the Owner role does not have them
  by default. Practitioners see only patients assigned to or booked with them. Viewing clinical
  content is written to the audit log (without the clinical content itself).
- **Files are private.** Photos and documents are stored outside the web root, validated by content
  (not file name), never modified after upload (SHA-256 recorded), and served only through
  permission-checked endpoints with `no-store`.

## Roles and permissions

Permissions are enforced by the API; the UI hides what a role cannot use. The Owner can change role
permissions (with a reason, audited) under **Settings → Roles & permissions**, and grant extra
permissions to an individual (e.g. an owner who also treats patients).

| | Owner/Admin | Receptionist | Practitioner | Accountant |
|---|:-:|:-:|:-:|:-:|
| Patient contact details | ✔ | ✔ | assigned only | ✔ (read) |
| Medical history, treatment notes, clinical photos | — | — | ✔ | — |
| Book / reschedule / cancel, check-in | ✔ | ✔ | check-in | — |
| Treatment workspace | — | — | ✔ | — |
| Sell packages / record payments | ✔ | ✔ | — | payments |
| Discounts, refunds, invoice adjustments, expenses | ✔ | — | — | ✔ |
| Reverse a completed session, adjust packages | ✔ | — | — | — |
| Inventory (manage / override) | ✔ | view | view | view |
| Financial reports | ✔ | — | — | ✔ |
| Settings, staff, permissions, audit log | ✔ | — | — | — |

## Acceptance scenario

`npm test` runs this against the real API and a temporary database:

1. Create a patient (and confirm a second record with the same phone number is flagged, not merged).
2. Sell a six-session laser package (reception cannot apply a discount; a retried sale returns the same package).
3. Record a partial payment (a retried payment is recorded once; an overpayment is refused).
4. Book an available practitioner, room and device (a clashing booking is refused with practitioner,
   room and device conflicts plus alternatives; two simultaneous bookings for one slot → one wins).
5. Check the patient in (appears in the reception queue). Cancelling another booking uses no session.
6. Open the treatment workspace (reception and owner get 403 on medical history, photos and workspace).
7. Save treatment details and consumables (an expired batch blocks completion; the practitioner cannot override).
8. Complete the session — two parallel completions and a retry produce one completion.
9. Five sessions remain.
10. Stock was deducted exactly once.
11. Outstanding balance is 8,000 EGP (12,000 − 4,000; the package session adds no charge).
12. Book the next appointment.

It also checks session reversal (permission + reason, retry-safe, package and stock restored), refunds
linked to and capped by the original payment, the treatment-consent gate, single invoicing of a
non-package visit, and that the audit log records sensitive access without clinical text. A second
test covers practitioner time off: practitioners cannot record it, existing bookings must be
acknowledged (and stay booked), overlapping time off is refused, bookings and free slots in the period
are blocked with an explanation, other clinicians do not see the reason, and cancelling (with a
reason, retry-safe) frees the diary again.

To walk through it in the UI: sign in as **Receptionist** → *Add patient* → patient page →
*Consents* (record treatment consent) → *Sell package* (Laser Full Legs – 6) with a part payment →
*Book* → on the day, *Check in*. Sign in as **Practitioner** → dashboard queue → *Start treatment* →
fill the workspace, add Cooling gel → *Complete session*. The patient's *Packages* tab shows 5
remaining with the ledger entry, *Inventory → Stock movements* shows one usage movement, and
*Billing* shows the balance.

## What is not connected, and production requirements

Not connected in this build (the UI says so wherever it matters and never reports otherwise):

- **WhatsApp, SMS, email.** Reminders and follow-ups are *prepared* from bilingual templates for
  staff to copy and send themselves, then the outcome is logged. Nothing is sent or marked as sent.
- **Online payments.** Payments are records of money already received (cash, card terminal, bank
  transfer). No card data is collected or charged.
- **Cloud storage.** Photos and documents live on the server's disk under `data/uploads/`.
- **Electronic signatures.** Consents record *that* consent was obtained (paper or in-clinic
  acknowledgement) and which template version; they are not legally binding e-signatures.

Before using this with real patients you would still need:

- HTTPS (TLS termination in front of the app), backups and tested restore, encryption at rest for the
  database and uploads, and a move from SQLite to a managed database (e.g. PostgreSQL) if more than
  one server instance is needed.
- Account security: password policy and reset flow, MFA, session management UI, rate limiting at the
  proxy, and removal of the shared demo accounts (`LUMA_DEMO_MODE=false` plus a first-owner setup).
- Real integrations: a WhatsApp Business provider, SMS gateway and SMTP (with delivery status), a
  payment gateway if online payment is wanted, private object storage with signed URLs.
- Compliance review for patient data under local law (e.g. Egypt's Personal Data Protection Law
  No. 151 of 2020), retention rules, and tax/e-invoicing requirements for issued invoices — printed
  invoices here are marked as demo documents, not tax invoices.
- Operational gaps not built yet: multi-branch support, image
  thumbnails/EXIF handling for large photo libraries, automated reminder scheduling (once messaging
  is connected), and data import from an existing system.
