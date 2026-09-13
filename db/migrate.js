// db/migrate.js
// Idempotent schema migration for the classified Admin Dashboard / User
// Management overhaul:
//   - expands users.role to allow 'clinician' and 'super_admin'
//   - adds users.status (pending/active/suspended/deactivated/deleted)
//   - adds users.email (optional)
//   - adds users.must_change_password (forced password reset on next login)
//   - creates the audit_logs table for administrative actions
//
// Run directly:            node db/migrate.js
// Or import and call:      migrate(db)   (works on a better-sqlite3 handle)
//
// Existing SQLite files created before this feature have a role CHECK of
// CHECK(role IN ('patient','admin')) which cannot be altered in place, so the
// users table is rebuilt (CREATE + copy + DROP + RENAME) with the expanded
// schema. Foreign keys referencing `users` by name (appointments, assessments,
// gait_sessions) keep working because PRAGMA foreign_keys is OFF during the
// rebuild and SQLite resolves the REFERENCES clause by table name at runtime.

function listColumns(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
}

function migrate(db) {
  // ---- audit_logs table (created on every schema, old or new) ----
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_id INTEGER,
      admin_name TEXT,
      action TEXT NOT NULL,
      target_type TEXT,
      target_id INTEGER,
      detail TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // ---- app_settings table: clinic profile overrides (key/value) ----
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);
  db.prepare('INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)').run('clinic_name', 'Bonsai Rehabilitation Center');
  db.prepare('INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)').run('clinic_address', 'Shadman Colony, Abdara Road, University Town, Peshawar, Pakistan');
  db.prepare('INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)').run('clinic_phone', '0313 9327164');
  db.prepare('INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)').run('clinic_email', 'bonsai.rehabilitaion@gmail.com');

  // ---- SMTP outbound mail settings (admin reply emails, config/mailer.js) ----
  db.prepare('INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)').run('smtp_host', '');
  db.prepare('INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)').run('smtp_port', '587');
  db.prepare('INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)').run('smtp_secure', 'false');
  db.prepare('INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)').run('smtp_user', '');
  db.prepare('INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)').run('smtp_pass', '');
  db.prepare('INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)').run('smtp_from_name', '');
  db.prepare('INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)').run('smtp_from_email', '');

  // ---- notifications table: in-app alerts for staff (bookings, new staff, etc.) ----
  db.exec(`
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      link TEXT,
      read INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  const tableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get();
  const isLegacy = tableSql && /role\s+IN\s*\(\s*'patient'\s*,\s*'admin'\s*\)/.test(tableSql.sql);

  if (isLegacy) {
    // Full table rebuild: the old CHECK constraint cannot be widened by ALTER.
    db.pragma('foreign_keys = OFF');
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(`
        CREATE TABLE users_new (
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
          status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('pending','active','suspended','deactivated','deleted')),
          email TEXT,
          must_change_password INTEGER NOT NULL DEFAULT 0,
          created_at TEXT DEFAULT (datetime('now'))
        )
      `);
      db.exec(`
        INSERT INTO users_new
          (id, guardian_name, child_name, diagnosis, country_code, phone, username,
           address, password_hash, role, created_at)
        SELECT id, guardian_name, child_name, diagnosis, country_code, phone, username,
               address, password_hash, role, created_at
        FROM users
      `);
      db.exec('DROP TABLE users');
      db.exec('ALTER TABLE users_new RENAME TO users');
      db.exec('COMMIT');
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch (e) { /* noop */ }
      throw err;
    }
  }

  // Guarded column additions for databases that already have the new role CHECK
  // but were created before status/email existed.
  const cols = listColumns(db, 'users');
  if (!cols.includes('status')) {
    try {
      db.exec("ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('pending','active','suspended','deactivated','deleted'))");
    } catch (e) { /* ignore duplicate column */ }
  }
  if (!cols.includes('email')) {
    try {
      db.exec('ALTER TABLE users ADD COLUMN email TEXT');
    } catch (e) { /* ignore duplicate column */ }
  }
  if (!cols.includes('must_change_password')) {
    try {
      db.exec('ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0');
    } catch (e) { /* ignore duplicate column */ }
  }

  return { rebuilt: Boolean(isLegacy) };
}

// CLI entry: migrate the real database in place.
// Opens its own handle so this script is safe to run alongside the server.
if (require.main === module) {
  const Database = require('better-sqlite3');
  const path = require('path');
  const dbPath = path.join(__dirname, 'brc.db');
  const db = new Database(dbPath);
  try {
    const result = migrate(db);
    db.pragma('checkpoint');
    console.log(`migrate: ok rebuilt=${result.rebuilt}`);
  } finally {
    db.close();
  }
}

module.exports = { migrate, listColumns };