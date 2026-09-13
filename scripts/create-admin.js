// scripts/create-admin.js
// Creates a staff (admin) account. Run this once to give yourself dashboard access.
//
// Usage:
//   node scripts/create-admin.js "Muhammad Mehr Ali" +923001234567 yourpassword
//
// Args:  <full name>  <phone with country code>  <password>

const bcrypt = require('bcryptjs');
const db = require('../db/database');

const [,, name, rawUsername, password] = process.argv;

if (!name || !rawUsername || !password) {
  console.log('Usage: node scripts/create-admin.js "<Full Name>" <phone> <password>');
  console.log('Example: node scripts/create-admin.js "Muhammad Mehr Ali" 03001234567 mySecurePass123');
  process.exit(1);
}

// Accept the phone in whatever format is natural to type, and normalize it to +92XXXXXXXXXX:
//   03139327164        -> +923139327164   (local format, leading 0 dropped)
//   923139327164        -> +923139327164   (missing + only)
//   +923139327164        -> +923139327164   (already correct, left as-is)
let username = rawUsername.trim();
if (/^0\d{9,10}$/.test(username)) {
  username = '+92' + username.slice(1);
} else if (/^\d{10,15}$/.test(username)) {
  username = '+' + username;
}

if (!/^\+\d{7,15}$/.test(username)) {
  console.log(`❌ "${rawUsername}" doesn't look like a real phone number.`);
  console.log('   Use your local format (e.g. 03139327164) or full international format (e.g. +923139327164).');
  process.exit(1);
}

// Guard against copy-pasting one of my example passwords instead of a real one.
const knownExamplePasswords = [
  'yourpassword', 'herpassword', 'hispassword',
  'somerealpassword', 'anotherrealpassword', 'yetanotherpassword',
  'mysecurepass123'
];
if (knownExamplePasswords.includes(password.toLowerCase())) {
  console.log(`❌ "${password}" is one of the example passwords from the docs, not a real one.`);
  console.log('   Re-run the command with a password you actually want to use.');
  process.exit(1);
}

const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
if (existing) {
  db.prepare("UPDATE users SET role = 'admin' WHERE username = ?").run(username);
  console.log(`Existing account "${username}" upgraded to admin.`);
  process.exit(0);
}

const passwordHash = bcrypt.hashSync(password, 10);
const countryCodeMatch = username.match(/^\+\d{1,4}/);
const countryCode = countryCodeMatch ? countryCodeMatch[0] : '+92';
const phone = username.replace(countryCode, '');

db.prepare(`
  INSERT INTO users (guardian_name, child_name, diagnosis, country_code, phone, username, address, password_hash, role)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'admin')
`).run(name, '—', '', countryCode, phone, username, '', passwordHash);

console.log(`Admin account created.\nLogin at /login.html with:\n  Username: ${username}\n  Password: (the one you set)`);
