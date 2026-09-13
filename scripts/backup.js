// scripts/backup.js
// One-off CLI backup of the SQLite database to ./backups/brc-backup-<timestamp>.sqlite
// Usage: node scripts/backup.js [custom-name]
// Uses better-sqlite3's backup API for a consistent snapshot even while the
// server is running.

const path = require('path');
const fs = require('fs');
const db = require('../db/database');

(async () => {
  const dir = path.join(__dirname, '..', 'backups');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const arg = process.argv[2];
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const target = arg
    ? path.join(dir, arg.endsWith('.sqlite') ? arg : `${arg}.sqlite`)
    : path.join(dir, `brc-backup-${stamp}.sqlite`);

  await db.backup(target);
  console.log(`Backup written to ${target}`);
  process.exit(0);
})().catch((err) => {
  console.error('Backup failed:', err.message || err);
  process.exit(1);
});