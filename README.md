# Bonsai Rehabilitation Center — Website (Phase 1)

Full-stack website: static frontend + Express/SQLite backend with real signup, login, logout, and appointment booking.

## What's included

- **Home, About Us, Services, Contact Us** — public pages, playful pediatric-therapy palette matching your logo, with a live Google Maps embed on Contact
- **Signup** — guardian name, child name, diagnosis, phone (with country code → becomes username), address, password/confirm
- **Login / Logout** — phone number + password, session via secure httpOnly cookie
- **Patient Dashboard** — profile summary, appointment booking (multi-select therapy types + Other + description, in-clinic/online mode, date, notes), appointment history, and a link into the Online Assessment
- **Online Assessment** — a 15-question, 5-domain screening questionnaire (Motor, Speech, Behavior, Sensory, Hearing). The patient gets an immediate preliminary summary (explicitly labeled as *not* a diagnosis); staff then review it and add the official clinical conclusion, which appears back in the patient's dashboard.
- **Staff Admin Dashboard** (`/admin-dashboard.html`):
  - **Overview** — KPIs (patients, appointments, pending assessments, messages), a 6-month appointment trend line, therapy-type / status / mode / diagnosis-category charts, date-range filtering
  - **Patients** — full list with auto-classified diagnosis categories (Autism Spectrum, Cerebral Palsy, Speech Delay, etc.), filter pills, and a detail panel per patient (profile + appointment history + assessment history) with one-click PDF/Word export
  - **Appointments** — status filters, inline status updates
  - **Assessments** — pending/reviewed filters, a review panel showing every question and answer, where staff write the official conclusion
  - **Reports** — download the full dataset as a 3-sheet XLSX (Patients/Appointments/Assessments), or a clinic-wide PDF overview report, both respecting an optional date range
  - **PNG export** on every chart (small ⬇ PNG button)
- **SQLite database** — `db/brc.db` (auto-created on first run, stores users, appointments, assessments, contact messages)

## Diagnosis classification

Patients are auto-grouped into categories (Autism Spectrum, Cerebral Palsy, Speech/Language Delay, Hearing Loss/Cochlear, Down Syndrome, Developmental Delay, Physical/Orthopedic, ADHD/Behavioral, Sensory Processing, Other) by keyword-matching the free-text diagnosis field. The keyword list lives in `config/diagnosis-categories.js` — add more keywords there any time.

## Staff roles and permissions

Three staff roles share the Admin Dashboard (`/admin-dashboard.html`); a higher role inherits everything from the roles below it.

| Capability | Super Admin | Admin | Clinician (staff) |
|---|---|---|---|
| Overview / KPIs / charts | ✔ | ✔ | ✔ |
| Patients list + details (view) | ✔ | ✔ | ✔ |
| Appointments (view) | ✔ | ✔ | ✔ |
| Messages / contact form (view) | ✔ | ✔ | ✔ |
| Assessments (view) | ✔ | ✔ | ✔ |
| Audit logs (view) | ✔ | ✔ | ✔ |
| Edit appointment status | ✔ | ✔ | — (blocked) |
| Reply to contact messages | ✔ | ✔ | — (blocked) |
| Review assessments / write conclusion | ✔ | ✔ | — (blocked) |
| Edit patient credentials | ✔ | ✔ | — (blocked) |
| Approve / suspend / delete accounts | ✔ | ✔ (patients/clinicians only) | — |
| Create staff accounts | ✔ | — | — |
| Manage Administrator/Super Admin accounts | ✔ | — | — |
| Clinic settings + SMTP / test email | ✔ | — | — |
| Download database backup | ✔ | — | — |
| Reports (XLSX / PDF / DOCX exports) | ✔ | ✔ | — |

Definition of the roles:
- **Super Admin** — full control: staff accounts, approvals, settings, SMTP, backup, everything below.
- **Admin** — day-to-day clinic operations (appointments, replies, assessment review, patient accounts, reports) plus viewing users/audit. Cannot create/manage staff, change settings, or download a raw backup.
- **Clinician (staff)** — **read-only** view of the overview, appointments, messages, patients, and assessments. Every mutation endpoint returns `403` for this role. The dashboard hides all edit controls (appointment status dropdown, Reply button) and restricts the sidebar to **Overview, Appointments, Messages**.

Enforcement lives in `routes/auth.js` (`requireStaffView` / `requireAdmin` / `requireSuperAdmin`) and per-route guards in `routes/admin.js`; the frontend (`public/js/admin.js` → `applyRoleAccess`) only hides controls — it never replaces server-side checks.

## The Online Assessment questionnaire

Questions live in `config/assessment-questions.js` — a single source of truth used by both the patient-facing form and the scoring logic. To add/edit questions or domains, edit that file only; both the API and the frontend pick it up automatically. Scoring is a simple rule-based triage flag (not a diagnosis) — the real clinical conclusion is always written by staff in the Assessments review panel.

## Creating a staff (admin) account

There's no public signup for staff — you create admin accounts yourself from the command line, from inside the `brc-website` folder. **Run these one at a time, pressing Enter after each** (pasting all three at once on Windows can merge them into a single line and only the first will run):

```bash
node scripts/create-admin.js "Muhammad Mehr Ali" 03139327164 MehrAdmin2026
```
Press Enter, wait for "Admin account created," then run the next one:
```bash
node scripts/create-admin.js "Mariya Hassam" 03219008824 MariyaAdmin2026
```
```bash
node scripts/create-admin.js "Azaz Ul Haq" 03339357572 AzazAdmin2026
```

You can use your normal local phone format (`0313...`) — the script converts it automatically. Use your **own real passwords**, not the ones shown above.

Then log in at `/login.html` with that same phone number (local or +92 format both work) and password — you'll be sent to the Admin Dashboard automatically instead of the patient dashboard.

## How to run it

You need [Node.js](https://nodejs.org) installed (v18 or newer).

```bash
cd brc-website
npm install
npm start
```

Then open **http://localhost:3000** in your browser.

The database file `db/brc.db` is created automatically the first time you run the server. It's not included in this download, so you're starting with a clean, empty database.

To fill the Blog and Research sections with starter content (4 posts + 3 papers, one with a PDF), run:

```bash
node scripts/seed-content.js
```

It's safe to re-run — posts/papers are keyed by slug and skipped if they already exist. Delete anything from the Admin Dashboard afterward.

## Project structure

```
brc-website/
├── server.js              # Express server entry point
├── db/
│   └── database.js        # SQLite schema (users, appointments, contact_messages)
├── routes/
│   ├── auth.js             # signup / login / logout / me
│   ├── appointments.js     # book / list appointments
│   └── contact.js          # contact form submissions
└── public/                 # everything the browser loads
    ├── index.html, about.html, services.html, contact.html
    ├── login.html, signup.html, dashboard.html
    ├── css/style.css
    └── js/main.js, auth.js, dashboard.js, contact.js
```

## Adding new pages later (gait lab, blog, online assessment)

Because the frontend is plain HTML/CSS/JS, you add a new page by:
1. Creating a new `.html` file in `public/` (copy the navbar/footer from an existing page)
2. Adding any new backend logic as a new file in `routes/`, then wiring it into `server.js`
3. Adding any new database tables in `db/database.js`

This keeps every page independent — you can build the Gait Lab page and Online Assessment page without touching the rest of the site.

## Notes on the current setup

- Passwords are hashed with bcrypt — never stored in plain text.
- Sessions use a JWT stored in an httpOnly cookie (can't be read by JavaScript, safe from basic XSS).
- The `JWT_SECRET` in `routes/auth.js` uses a fallback dev value — **before deploying live, set a real secret** via an environment variable (`JWT_SECRET=your-long-random-string`).
- This currently runs on SQLite, which is a single file — perfect for development and even small-scale production. If you outgrow it later, the queries can be migrated to PostgreSQL/MySQL with minor changes.

## Deploying it live

Any Node.js host works (Render, Railway, a VPS, etc.). Steps are the same as running locally: `npm install`, set `JWT_SECRET` and `PORT` as environment variables, then `npm start`. You'll want a domain and HTTPS in front of it before real patient data goes in.
