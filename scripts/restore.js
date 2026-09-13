// scripts/restore.js
// Restore the SQLite database from a backup file.
// Usage: node scripts/restore.js <path-to-backup.sqlite>
//
// IMPORTANT: the server must NOT be running while you restore, otherwise the
// running process can overwrite the file with in-memory state afterwards. This
// script takes a defensive copy of the current DB (backups/pre-restore-*.sqlite)
// before replacing it, so a mistake is easy to undo.

const path = require('path');
const fs = require('fs');

const src = process.argv[2];
if (!src) {
  console.error('Usage: node scripts/restore.js <path-to-backup.sqlite>');
  process.exit(1);
}

const absSrc = path.resolve(src);
if (!fs.existsSync(absSrc)) {
  console.error(`Backup file not found: ${absSrc}`);
  process.exit(1);
}

const dbPos = require.resolve('../db/database');
const dbDir = path.dirname(dbPos);
const dbFile = 'brc.db';
const dbPath = path.join(dbDir, dbFile);

if (!fs.existsSync(dbPath)) {
  console.error(`Database not found at expected location: ${dbPath}`);
  process.exit(1);
}

require('../db/database').close();

const backupsDir = path.join(__dirname, '..', 'backups');
if (!fs.existsSync(backupsDir)) fs.mkdirSync(backupsDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
const preRestore = path.join(backupsDir, `pre-restore-${stamp}.sqlite`);
fs.copyFileSync(dbPath, preRestore);

fs.copyFileSync(absSrc, dbPath);
console.log(`Database restored from ${absSrc}`);
console.log(`A copy of the pre-restore database was saved to ${preRestore}`);
process.exit(0);

// require('../db/database').close() is loaded above to ensure no connection
// holds the file handle; restore.closed = true lets a fresh server start cleanly.