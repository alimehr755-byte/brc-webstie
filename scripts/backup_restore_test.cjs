const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const dbPath = path.join(__dirname, '..', 'db', 'brc.db');
const uploadsDir = path.join(__dirname, '..', 'uploads');
const tmpDir = path.join(require('os').tmpdir(), 'brc-backup-test-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });

let failures = [];
function check(cond, msg) {
  if (cond) console.log('PASS:', msg);
  else { console.log('FAIL:', msg); failures.push(msg); }
}

// 1. Source DB exists and opens
check(fs.existsSync(dbPath), 'source db/brc.db exists');
let src;
try {
  src = new Database(dbPath, { readonly: true });
  check(true, 'source DB opens read-only');
  const integrity = src.prepare('PRAGMA integrity_check').get().integrity_check;
  check(integrity === 'ok', `source DB integrity: ${integrity}`);
  const tableCount = src.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").get().n;
  check(tableCount > 0, `source DB has ${tableCount} table(s)`);
} catch (e) {
  check(false, `source DB open failed: ${e.message}`);
}

// 2. Uploads directory exists
check(fs.existsSync(uploadsDir), 'uploads/ directory exists');
const gaitDir = path.join(uploadsDir, 'gait');
check(fs.existsSync(gaitDir), 'uploads/gait/ directory exists');

// 3. Create backup copies
const backupDb = path.join(tmpDir, 'brc.db.backup');
const backupUploads = path.join(tmpDir, 'uploads.backup');
try {
  fs.copyFileSync(dbPath, backupDb);
  check(true, 'DB backup copied');
} catch (e) { check(false, `DB backup failed: ${e.message}`); }
try {
  fs.cpSync(uploadsDir, backupUploads, { recursive: true });
  check(true, 'uploads/ backup copied');
} catch (e) { check(false, `uploads backup failed: ${e.message}`); }

// 4. Restore simulation: open backup DB and verify integrity + a sample query
try {
  const restored = new Database(backupDb, { readonly: true });
  const rIntegrity = restored.prepare('PRAGMA integrity_check').get().integrity_check;
  check(rIntegrity === 'ok', `restored DB integrity: ${rIntegrity}`);
  const sessionCount = restored.prepare("SELECT COUNT(*) AS n FROM gait_sessions").get().n;
  check(typeof sessionCount === 'number', `restored DB readable (gait_sessions = ${sessionCount})`);
  restored.close();
} catch (e) { check(false, `restored DB verify failed: ${e.message}`); }
try { src.close(); } catch (e) {}

// 5. Verify backup files are non-empty
check(fs.existsSync(backupDb) && fs.statSync(backupDb).size > 0, 'backup DB non-empty');
check(fs.existsSync(backupUploads) && fs.readdirSync(backupUploads).length >= 0, 'backup uploads dir readable');

// cleanup
try { fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (e) {}

if (failures.length) {
  console.log('\nBACKUP/RESTORE TEST FAILED');
  process.exit(1);
} else {
  console.log('\nBACKUP/RESTORE TEST PASSED');
}
