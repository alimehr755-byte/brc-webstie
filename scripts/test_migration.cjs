const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const tmpDir = path.join(os.tmpdir(), 'brc-migration-test-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
process.env.PERSIST_DIR = tmpDir;

let failures = [];
function check(cond, msg) {
  if (cond) console.log('PASS:', msg);
  else { console.log('FAIL:', msg); failures.push(msg); }
}

// Require database.js -> runs all CREATE TABLE / ALTER migrations on fresh DB
require(path.join(__dirname, '..', 'db', 'database.js'));
const dbPath = path.join(tmpDir, 'brc.db');
check(fs.existsSync(dbPath), 'fresh brc.db created at PERSIST_DIR');

const Database = require('better-sqlite3');
const db = new Database(dbPath);

function tableExists(name) {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) != null;
}
function colExists(table, col) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name).includes(col);
}

check(tableExists('users'), 'users table exists');
check(tableExists('gait_sessions'), 'gait_sessions table exists');
check(tableExists('research_normative_bands'), 'research_normative_bands table exists');
check(colExists('gait_sessions','diagnosis'), 'gait_sessions.diagnosis column exists');
check(colExists('gait_sessions','gmfcs_level'), 'gait_sessions.gmfcs_level column exists');
check(colExists('gait_sessions','body_mass_kg'), 'gait_sessions.body_mass_kg column exists');
check(colExists('gait_sessions','height_cm'), 'gait_sessions.height_cm column exists');
check(colExists('users','diagnosis'), 'users.diagnosis column exists');

const bandCount = db.prepare('SELECT COUNT(*) AS n FROM research_normative_bands').get().n;
check(bandCount > 0, `research_normative_bands seeded (${bandCount} rows)`);

// Verify a write works on the fresh migrated DB
db.prepare("INSERT INTO users (guardian_name, child_name, country_code, phone, username, password_hash) VALUES (?,?,?,?,?,?)")
  .run('E2E Guardian','E2E Child','+92','03139999999','+923139999999','hash');
const u = db.prepare("SELECT id FROM users WHERE username=?").get('+923139999999');
check(u && u.id, 'user insert works on migrated DB');

db.close();
try { fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (e) { /* cleanup best-effort on Windows file locks */ }

if (failures.length) {
  console.log('\nMIGRATION TEST FAILED');
  process.exit(1);
} else {
  console.log('\nMIGRATION TEST PASSED');
}
