// db/database.js
// SQLite database setup for Bonsai Rehabilitation Center.
// Creates two tables: users (patient/guardian accounts) and appointments.

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Resolve the SQLite database path. In production (Render) the persistent disk
// is mounted at PERSIST_DIR (/data); fall back to the local brc.db for
// development so `node server.js` works out of the box.
const persistDir = process.env.PERSIST_DIR;
const dbFileName = 'brc.db';
const dbPath = persistDir
  ? path.join(persistDir, dbFileName)
  : path.join(__dirname, dbFileName);

// Ensure the parent directory exists (Render volume mount may be empty on first deploy).
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(dbPath);

db.pragma('journal_mode = WAL');

// ---- USERS TABLE ----
// username = phone number (unique, used to log in)
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guardian_name TEXT NOT NULL,
    child_name TEXT NOT NULL,
    diagnosis TEXT,
    country_code TEXT NOT NULL,
    phone TEXT NOT NULL,
    username TEXT NOT NULL UNIQUE,
    address TEXT,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'patient' CHECK(role IN ('patient','clinician','admin','super_admin')),
    created_at TEXT DEFAULT (datetime('now'))
  )
`);

// Safety net: if an older database file exists without the role column, add it.
const cols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
if (!cols.includes('role')) {
  db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'patient'");
}

// ---- APPOINTMENTS TABLE ----
// therapy_types stored as JSON array string, e.g. ["occupational_therapy","speech_therapy"]
db.exec(`
  CREATE TABLE IF NOT EXISTS appointments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    therapy_types TEXT NOT NULL,
    other_description TEXT,
    mode TEXT NOT NULL CHECK(mode IN ('in_clinic','online')),
    preferred_date TEXT,
    notes TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','confirmed','completed','cancelled')),
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  )
`);

// ---- CONTACT MESSAGES TABLE (from the public Contact Us form) ----
db.exec(`
  CREATE TABLE IF NOT EXISTS contact_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT,
    phone TEXT,
    message TEXT NOT NULL,
    replied INTEGER NOT NULL DEFAULT 0,
    reply_text TEXT,
    reply_to TEXT,
    replied_by TEXT,
    replied_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )
`);

// Guarded column additions for contact_messages databases created before the
// admin-reply feature shipped. Each ALTER is guarded in its own try/catch
// (SQLite throws when a column already exists) — they MUST NOT be combined.
const contactCols = db.prepare('PRAGMA table_info(contact_messages)').all().map(c => c.name);
if (!contactCols.includes('replied')) {
  try { db.exec("ALTER TABLE contact_messages ADD COLUMN replied INTEGER NOT NULL DEFAULT 0"); } catch (e) { /* ignore */ }
}
if (!contactCols.includes('reply_text')) {
  try { db.exec('ALTER TABLE contact_messages ADD COLUMN reply_text TEXT'); } catch (e) { /* ignore */ }
}
if (!contactCols.includes('reply_to')) {
  try { db.exec('ALTER TABLE contact_messages ADD COLUMN reply_to TEXT'); } catch (e) { /* ignore */ }
}
if (!contactCols.includes('replied_by')) {
  try { db.exec('ALTER TABLE contact_messages ADD COLUMN replied_by TEXT'); } catch (e) { /* ignore */ }
}
if (!contactCols.includes('replied_at')) {
  try { db.exec('ALTER TABLE contact_messages ADD COLUMN replied_at TEXT'); } catch (e) { /* ignore */ }
}

// ---- ONLINE ASSESSMENTS TABLE ----
// responses = JSON blob of every question's answer, keyed by question id.
// flagged_domains = JSON array of domains the rule-based triage marked for review, e.g. ["speech","motor"].
// admin_conclusion / admin_reviewer / reviewed_at are filled in later by staff — the patient-facing
// summary generated at submission time is explicitly a preliminary triage note, never a diagnosis.
db.exec(`
  CREATE TABLE IF NOT EXISTS assessments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    responses TEXT NOT NULL,
    flagged_domains TEXT NOT NULL DEFAULT '[]',
    preliminary_summary TEXT,
    status TEXT NOT NULL DEFAULT 'pending_review' CHECK(status IN ('pending_review','reviewed')),
    admin_conclusion TEXT,
    admin_reviewer TEXT,
    reviewed_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  )
`);

// ---- BLOG POSTS TABLE ----
// content is stored as markdown and escaped client-side before rendering (never raw HTML).
db.exec(`
  CREATE TABLE IF NOT EXISTS blog_posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    author TEXT NOT NULL DEFAULT 'Bonsai Rehabilitation Center',
    category TEXT NOT NULL DEFAULT 'General',
    abstract TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published')),
    published_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )
`);

// ---- RESEARCH PAPERS TABLE ----
// pdf_path is server-relative (e.g. uploads/research/....pdf) and always served via the API.
db.exec(`
  CREATE TABLE IF NOT EXISTS research_papers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    author TEXT NOT NULL DEFAULT 'Bonsai Rehabilitation Center',
    category TEXT NOT NULL DEFAULT 'General',
    publication_date TEXT,
    abstract TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    pdf_path TEXT,
    pdf_name TEXT,
    status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published')),
    published_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )
`);

// ---- GAIT LAB SESSIONS TABLE ----
// Stores dual-view gait analysis sessions. Videos are server-relative paths under
// uploads/gait/. `results` holds the full analyzer JSON (cycle phases, anomalies,
// deformities, kinematics, muscles, prescriptions, references). `analyzer_meta`
// records which engine/mode produced the result. Staff review fills the review fields.
db.exec(`
  CREATE TABLE IF NOT EXISTS gait_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'created' CHECK(status IN ('created','analyzed','reviewed')),
    frontal_video TEXT,
    sagittal_video TEXT,
    frontal_name TEXT,
    sagittal_name TEXT,
    combined_video TEXT,
    combined_name TEXT,
    notes TEXT,
    speed_hint TEXT DEFAULT 'auto',
    height_cm REAL,
    results TEXT,
    analyzer_meta TEXT,
    review_note TEXT,
    reviewed_by TEXT,
    reviewed_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  )
`);

// ---- RESEARCH NORMATIVE REFERENCE BANDS ----
// Age/sex-stratified normative joint-angle bands used by the Research Portal
// waveform charts instead of hardcoded constants. Populated by
// scripts/seed_normative_bands.js. Units: degrees.
db.exec(`
  CREATE TABLE IF NOT EXISTS research_normative_bands (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    joint TEXT NOT NULL,
    plane TEXT NOT NULL,
    side TEXT NOT NULL,
    age_min INTEGER NOT NULL DEFAULT 0,
    age_max INTEGER NOT NULL DEFAULT 999,
    sex TEXT NOT NULL DEFAULT 'all',
    metric TEXT NOT NULL,
    p5 REAL,
    p50 REAL,
    p95 REAL,
    source TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(joint, plane, side, age_min, age_max, sex, metric)
  )
`);

// Seed illustrative normative bands (idempotent). Replace with clinic-specific data.
const normativeSeed = [
  ['knee','sagittal','L',0,999,'all','knee_flex',30,60,90,'representative'],
  ['knee','sagittal','R',0,999,'all','knee_flex',30,60,90,'representative'],
  ['knee','frontal','L',0,999,'all','knee_valgus',-5,0,10,'representative'],
  ['knee','frontal','R',0,999,'all','knee_valgus',-5,0,10,'representative'],
  ['hip','sagittal','L',0,999,'all','hip_flex',-10,30,50,'representative'],
  ['hip','sagittal','R',0,999,'all','hip_flex',-10,30,50,'representative'],
  ['hip','frontal','L',0,999,'all','hip_ab_abd',-10,0,15,'representative'],
  ['hip','frontal','R',0,999,'all','hip_ab_abd',-10,0,15,'representative'],
  ['ankle','sagittal','L',0,999,'all','ankle_angle',-20,0,30,'representative'],
  ['ankle','sagittal','R',0,999,'all','ankle_angle',-20,0,30,'representative'],
  ['pelvis','sagittal','L',0,999,'all','pelvic_obliquity_mean',-5,0,10,'representative'],
  ['pelvis','frontal','L',0,999,'all','pelvic_obliquity_mean',-5,0,10,'representative'],
  ['spine','sagittal','L',0,999,'all','lateral_trunk_lean_max',-10,0,15,'representative'],
  ['hip','transverse','L',0,999,'all','hip_rot',-5,0,15,'representative'],
  ['hip','transverse','R',0,999,'all','hip_rot',-5,0,15,'representative'],
  ['pelvis','transverse','L',0,999,'all','pelvic_rot',-10,0,20,'representative'],
  ['pelvis','transverse','R',0,999,'all','pelvic_rot',-10,0,20,'representative'],
  ['trunk','transverse','L',0,999,'all','trunk_rot',-15,0,15,'representative'],
  ['trunk','transverse','R',0,999,'all','trunk_rot',-15,0,15,'representative'],
];
const normativeInsert = db.prepare(
  `INSERT OR IGNORE INTO research_normative_bands (joint, plane, side, age_min, age_max, sex, metric, p5, p50, p95, source)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);
for (const row of normativeSeed) normativeInsert.run(...row);

// 3e.txt — combined dual-plane upload mode. Add the columns for pre-existing
// databases created before this feature shipped. Each ALTER is guarded in its
// own try/catch: SQLite throws when a column already exists, which we
// intentionally ignore. They MUST NOT share one try block — if the first
// throws on a duplicate, the later ALTERs would be skipped.
const gaitCols = db.prepare('PRAGMA table_info(gait_sessions)').all().map(c => c.name);
if (!gaitCols.includes('combined_video')) {
  try { db.exec('ALTER TABLE gait_sessions ADD COLUMN combined_video TEXT'); } catch (e) { /* ignore */ }
}
if (!gaitCols.includes('combined_name')) {
  try { db.exec('ALTER TABLE gait_sessions ADD COLUMN combined_name TEXT'); } catch (e) { /* ignore */ }
}
// 2.md — third plane upload (Coronal Plane per spec). Anatomically the frontal
// plane is the coronal plane, so this third slot is an additional camera view
// for tri-view triangulation, stored under a neutral `third` key to avoid
// colliding with the existing `frontal` slot. Display label: "Coronal Plane".
if (!gaitCols.includes('third_video')) {
  try { db.exec('ALTER TABLE gait_sessions ADD COLUMN third_video TEXT'); } catch (e) { /* ignore */ }
}
if (!gaitCols.includes('third_name')) {
  try { db.exec('ALTER TABLE gait_sessions ADD COLUMN third_name TEXT'); } catch (e) { /* ignore */ }
}
// 2.md + Phase 1 — golden session flag. A session is marked golden after the
// treating physiotherapist has completed manual assessment (goniometry, CP
// knee pattern, BBS, TUG, GMFCS) per docs/capture-sop.md. The concordance
// harness reads these rows to compute engine-vs-physio agreement gates.
if (!gaitCols.includes('is_golden')) {
  try { db.exec("ALTER TABLE gait_sessions ADD COLUMN is_golden INTEGER DEFAULT 0"); } catch (e) { /* ignore */ }
}
if (!gaitCols.includes('speed_hint')) {
  try { db.exec("ALTER TABLE gait_sessions ADD COLUMN speed_hint TEXT DEFAULT 'auto'"); } catch (e) { /* ignore */ }
}
// run.txt §2 — physician-measured standing height (cm) as the metric calibration anchor.
if (!gaitCols.includes('height_cm')) {
  try { db.exec('ALTER TABLE gait_sessions ADD COLUMN height_cm REAL'); } catch (e) { /* ignore */ }
}
// run.txt demographics: patient age, gender, body mass, and assessing clinician.
if (!gaitCols.includes('age_years')) {
  try { db.exec('ALTER TABLE gait_sessions ADD COLUMN age_years REAL'); } catch (e) { /* ignore */ }
}
if (!gaitCols.includes('gender')) {
  try { db.exec("ALTER TABLE gait_sessions ADD COLUMN gender TEXT"); } catch (e) { /* ignore */ }
}
if (!gaitCols.includes('body_mass_kg')) {
  try { db.exec('ALTER TABLE gait_sessions ADD COLUMN body_mass_kg REAL'); } catch (e) { /* ignore */ }
}
if (!gaitCols.includes('clinician_name')) {
  try { db.exec("ALTER TABLE gait_sessions ADD COLUMN clinician_name TEXT"); } catch (e) { /* ignore */ }
}

// ---- CLINICAL SCALES TABLE ----
// Structured functional-assessment records, one row per administered scale
// (BBS 14-item, TUG, GMFCS-E&R observational, digital Rancho OGA, plus
// future-ready stubs). All interpretation/cutoff logic lives in the Python
// engine (python/bbs_engine.py, python/scales_registry.py); this table only
// persists what the engine returned. `items` holds the engine's itemized
// payload; `payload` holds the full normalized engine output so reports and
// views can trace every interpretation back to its citation.
db.exec(`
  CREATE TABLE IF NOT EXISTS clinical_scales (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    scale_type TEXT NOT NULL CHECK(scale_type IN ('bbs','tug','gmfcs','oga','6mwt','2mwt','10mwt','fac','tinetti','dgi','fap','iowa_loa')),
    status TEXT NOT NULL DEFAULT 'assessed' CHECK(status IN ('assessed','unassessed','stub','reviewed')),
    items TEXT,
    payload TEXT NOT NULL DEFAULT '{}',
    total REAL,
    interpretation TEXT,
    assessor TEXT,
    notes TEXT,
    related_session_id INTEGER,
    created_by INTEGER,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (related_session_id) REFERENCES gait_sessions(id),
    FOREIGN KEY (created_by) REFERENCES users(id)
  )
`);

const scaleCols = db.prepare('PRAGMA table_info(clinical_scales)').all().map(c => c.name);
if (!scaleCols.includes('related_session_id')) {
  try { db.exec('ALTER TABLE clinical_scales ADD COLUMN related_session_id INTEGER'); } catch (e) { /* ignore */ }
}

module.exports = db;

// Research cohort diagnosis per session (added for Research Portal filters).
try {
  const _gaitColsDx = db.prepare("PRAGMA table_info(gait_sessions)").all().map(c => c.name);
  if (!_gaitColsDx.includes("diagnosis")) {
    db.exec("ALTER TABLE gait_sessions ADD COLUMN diagnosis TEXT");
  }
} catch (e) { /* ignore */ }

// Research cohort GMFCS level per session (added for Research Portal multi-plane filters).
try {
  const _gaitColsGmfcs = db.prepare("PRAGMA table_info(gait_sessions)").all().map(c => c.name);
  if (!_gaitColsGmfcs.includes("gmfcs_level")) {
    db.exec('ALTER TABLE gait_sessions ADD COLUMN gmfcs_level TEXT');
  }
} catch (e) { /* ignore */ }
