// scripts/promote-super-admin.js
// Promotes an existing account to super_admin (the bootstrap Super Admin).
// Usage:
//   node scripts/promote-super-admin.js <username-or-user-id>
// Example:
//   node scripts/promote-super-admin.js 923139327164
//
// The promoted account is set to status 'active' so it can log in immediately
// and then manage Administrators / Clinicians from the admin dashboard.

const path = require('path');
const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));

const target = process.argv[2];
if (!target) {
  console.error('Usage: node scripts/promote-super-admin.js <username-or-user-id>');
  process.exit(1);
}

const db = new Database(path.join(__dirname, '..', 'db', 'brc.db'));
try {
  const where = /^\d+$/.test(target) ? 'id = ?' : 'username = ?';
  const user = db.prepare(`SELECT id, username, role, status FROM users WHERE ${where}`).get(target);
  if (!user) {
    console.error(`No account matches "${target}".`);
    process.exit(1);
  }
  if (user.role === 'super_admin') {
    console.log(`Account "${user.username}" (id ${user.id}) is already a super admin.`);
    process.exit(0);
  }
  db.prepare("UPDATE users SET role = 'super_admin', status = 'active' WHERE id = ?").run(user.id);
  console.log(`Promoted "${user.username}" (id ${user.id}) to super_admin (status=active).`);
} finally {
  db.close();
}