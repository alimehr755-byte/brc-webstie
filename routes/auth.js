// routes/auth.js
// Handles signup, login, logout, and "who am I" session check.

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db/database');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'brc-dev-secret-change-in-production';
const COOKIE_NAME = 'brc_session';

// ---- helper: sign a JWT for a user id ----
function signToken(userId) {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: '30d' });
}

// ---- middleware: require a logged-in user ----
// Also enforces the forced password change: while users.must_change_password is
// set (admin-created staff or an admin password reset), an active session may
// only reach /api/auth/me and /api/auth/change-password (and logout) until the
// user sets a new password.
function requireAuth(req, res, next) {
  // Accept the session token from either the httpOnly cookie (web) or an
  // Authorization: Bearer header (native mobile app — avoids cross-origin cookies).
  let token = req.cookies[COOKIE_NAME];
  if (!token && req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
    token = req.headers.authorization.slice(7).trim();
  }
  if (!token) return res.status(401).json({ error: 'Not logged in.' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.userId;
    const row = db.prepare('SELECT id, guardian_name, username, email, role, status, must_change_password FROM users WHERE id = ?').get(payload.userId);
    if (!row) return res.status(401).json({ error: 'Account no longer exists.' });
    if (row.status !== 'active') {
      return res.status(403).json({ error: 'Your account is not active. Contact the Bonsai Rehabilitation Center.' });
    }
    if (row.must_change_password) {
      const base = req.baseUrl || '/';
      const p = req.path || '/';
      const allowed = base === '/api/auth' && (p === '/me' || p === '/change-password' || p === '/logout');
      if (!allowed) {
        return res.status(403).json({ error: 'You must set a new password before continuing.', code: 'PASSWORD_CHANGE_REQUIRED' });
      }
    }
    req.session = { user: { id: row.id, guardian_name: row.guardian_name, username: row.username, email: row.email, role: row.role, status: row.status } };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Session expired. Please log in again.' });
  }
}

// ---- middleware: require a logged-in admin (staff) user ----
// 'admin' and 'super_admin' both gain access to the admin dashboard / admin APIs.
function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    const user = db.prepare('SELECT role, status FROM users WHERE id = ?').get(req.userId);
    if (!user || (user.role !== 'admin' && user.role !== 'super_admin')) {
      return res.status(403).json({ error: 'Staff access only.' });
    }
    if (user.status !== 'active') {
      return res.status(403).json({ error: 'This account is not active. Contact a super administrator.' });
    }
    next();
  });
}

// ---- middleware: require a logged-in staff member with VIEW (read-only) rights ----
// 'clinician', 'admin' and 'super_admin' can all open the staff dashboard and read
// the overview / patient / appointment / message data. Anything that CHANGES data
// must additionally use requireAdmin (or requireSuperAdmin) so read-only staff
// (clinicians) are blocked from every mutation.
function requireStaffView(req, res, next) {
  requireAuth(req, res, () => {
    const user = db.prepare('SELECT role, status FROM users WHERE id = ?').get(req.userId);
    if (!user || !['clinician', 'admin', 'super_admin'].includes(user.role)) {
      return res.status(403).json({ error: 'Staff access only.' });
    }
    if (user.status !== 'active') {
      return res.status(403).json({ error: 'This account is not active.' });
    }
    next();
  });
}

// ---- middleware: require a logged-in super admin ----
// Super Admin only: manages Administrators/Clinicians, staff creation, role changes,
// hard deletes (purge), and other classified controls.
function requireSuperAdmin(req, res, next) {
  requireAuth(req, res, () => {
    const user = db.prepare('SELECT role, status FROM users WHERE id = ?').get(req.userId);
    if (!user || user.role !== 'super_admin') {
      return res.status(403).json({ error: 'Super administrator access only.' });
    }
    if (user.status !== 'active') {
      return res.status(403).json({ error: 'This account is not active.' });
    }
    next();
  });
}

// ---- POST /api/auth/signup ----
router.post('/signup', (req, res) => {
  const {
    guardianName,
    childName,
    diagnosis,
    countryCode,
    phone,
    address,
    email,
    password,
    confirmPassword
  } = req.body;

  // Basic validation
  if (!guardianName || !childName || !countryCode || !phone || !password || !confirmPassword) {
    return res.status(400).json({ error: 'Please fill in all required fields.' });
  }
  if (password !== confirmPassword) {
    return res.status(400).json({ error: 'Passwords do not match.' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }
  let cleanEmail = String(email || '').trim();
  if (cleanEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    return res.status(400).json({ error: 'That email address doesn\'t look valid.' });
  }
  if (!cleanEmail) cleanEmail = null;

  let cleanPhone = phone.replace(/\D/g, '');
  if (cleanPhone.startsWith('0')) cleanPhone = cleanPhone.slice(1); // e.g. "03139327164" -> "3139327164"
  const username = `${countryCode}${cleanPhone}`;

  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username)
                || db.prepare('SELECT id FROM users WHERE username = ?').get('+' + username);
  if (existing) {
    return res.status(409).json({ error: 'An account with this phone number already exists. Please log in instead.' });
  }

  const passwordHash = bcrypt.hashSync(password, 10);

  const stmt = db.prepare(`
    INSERT INTO users (guardian_name, child_name, diagnosis, country_code, phone, username, address, email, password_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(guardianName, childName, diagnosis || '', countryCode, cleanPhone, username, address || '', cleanEmail, passwordHash);

  db.prepare('INSERT INTO notifications (type, message, link) VALUES (?, ?, ?)')
    .run('new_patient', `New patient registered: ${guardianName} (${childName || 'no child name'})`, `/admin-dashboard.html#users`);

  const token = signToken(result.lastInsertRowid);
  res.cookie(COOKIE_NAME, token, { httpOnly: true, maxAge: 30 * 24 * 60 * 60 * 1000, sameSite: 'lax' });
  res.json({ success: true, message: 'Account created successfully.', token });
});

// ---- helper: normalize a phone number to +92XXXXXXXXXX style ----
// Accepts local format (03139327164), missing-plus format (923139327164),
// or already-correct international format (+923139327164).
function normalizePhone(input) {
  let value = input.trim().replace(/\s/g, '');
  if (/^0\d{9,10}$/.test(value)) {
    return '+92' + value.slice(1);
  }
  if (/^\d{10,15}$/.test(value)) {
    return '+' + value;
  }
  return value;
}

// ---- POST /api/auth/login ----
router.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Please enter your phone number and password.' });
  }

  // Accept the phone in any of the historical formats. Stored usernames exist
  // both as bare international digits ("923139327164") and with a leading "+"
  // ("+92313927164") from an earlier build, so match against both canonical
  // forms. Local "0313..." input normalizes to the "+92" form.
  let digits = String(username).trim().replace(/^\+/, '').replace(/\D/g, '');
  if (digits.startsWith('0')) digits = '92' + digits.slice(1);
  const bare = digits;
  const prefixed = '+' + bare;
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(prefixed)
            || db.prepare('SELECT * FROM users WHERE username = ?').get(bare);
  if (!user) {
    return res.status(401).json({ error: 'No account found with that phone number.' });
  }
  if (user.status !== 'active') {
    const msg = user.status === 'pending'
      ? 'Your account is awaiting approval by the Bonsai Rehabilitation Center staff. Please try again later.'
      : user.status === 'deleted'
        ? 'No account found with that phone number.'
        : 'This account has been suspended/deactivated. Please contact the Bonsai Rehabilitation Center.';
    return res.status(403).json({ error: msg });
  }

  const valid = bcrypt.compareSync(password, user.password_hash);
  if (!valid) {
    return res.status(401).json({ error: 'Incorrect password.' });
  }

  const token = signToken(user.id);
  res.cookie(COOKIE_NAME, token, { httpOnly: true, maxAge: 30 * 24 * 60 * 60 * 1000, sameSite: 'lax' });
  res.json({
    success: true,
    message: 'Logged in successfully.',
    token,
    role: user.role,
    mustChangePassword: !!user.must_change_password
  });
});

// ---- POST /api/auth/change-password ----
// Self-service password change. Required before any other API use while the
// account has users.must_change_password set (admin-created staff / temp password).
router.post('/change-password', requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword) return res.status(400).json({ error: 'Please enter your current password.' });
  if (!newPassword || String(newPassword).length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters.' });
  }
  const user = db.prepare('SELECT guardian_name, password_hash, must_change_password FROM users WHERE id = ?').get(req.userId);
  if (!user) return res.status(404).json({ error: 'Account not found.' });
  if (!bcrypt.compareSync(currentPassword, user.password_hash)) {
    return res.status(400).json({ error: 'Current password is incorrect.' });
  }
  if (bcrypt.compareSync(newPassword, user.password_hash)) {
    return res.status(400).json({ error: 'New password must be different from the current password.' });
  }
  const wasForced = !!user.must_change_password;
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?')
    .run(bcrypt.hashSync(String(newPassword), 10), req.userId);
  try {
    db.prepare(`
      INSERT INTO audit_logs (admin_id, admin_name, action, target_type, target_id, detail)
      VALUES (?, ?, 'self_password_change', 'user', ?, ?)
    `).run(req.userId, user.guardian_name || '', req.userId,
      wasForced ? 'User completed the forced password change' : 'User changed their own password (self-service)');
  } catch (e) { /* logging must never break the action */ }
  res.json({ success: true, message: 'Password updated. You are all set.' });
});

// ---- POST /api/auth/change-username ----
// Self-service login-username (phone) change. New username must be 7–15 digits,
// must not collide with any existing account, and the current password is required.
router.post('/change-username', requireAuth, (req, res) => {
  const { currentPassword, username } = req.body;
  if (!currentPassword) return res.status(400).json({ error: 'Please enter your current password.' });
  const digits = String(username || '').replace(/^\+/, '').replace(/\D/g, '');
  if (!/^\d{7,15}$/.test(digits)) {
    return res.status(400).json({ error: 'New phone number must be 7–15 digits.' });
  }
  const bare = digits;
  const prefixed = '+' + digits;
  const user = db.prepare('SELECT guardian_name, password_hash FROM users WHERE id = ?').get(req.userId);
  if (!user) return res.status(404).json({ error: 'Account not found.' });
  if (!bcrypt.compareSync(currentPassword, user.password_hash)) {
    return res.status(400).json({ error: 'Current password is incorrect.' });
  }
  const clash = db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(bare, req.userId)
    || db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(prefixed, req.userId);
  if (clash) return res.status(409).json({ error: 'That phone number is already in use by another account.' });

  db.prepare('UPDATE users SET username = ? WHERE id = ?').run(prefixed, req.userId);
  try {
    db.prepare(`
      INSERT INTO audit_logs (admin_id, admin_name, action, target_type, target_id, detail)
      VALUES (?, ?, 'self_username_change', 'user', ?, ?)
    `).run(req.userId, user.guardian_name || '', req.userId, `User changed their own login phone number`);
  } catch (e) { /* logging must never break the action */ }
  res.json({ success: true, username: prefixed, message: 'Login phone number updated. Use the new number next time you log in.' });
});

// ---- POST /api/auth/logout ----
router.post('/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME);
  res.json({ success: true, message: 'Logged out.' });
});

// ---- GET /api/auth/me ----
router.get('/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT id, guardian_name, child_name, diagnosis, country_code, phone, username, address, role, status, email, must_change_password, created_at FROM users WHERE id = ?').get(req.userId);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  res.json({ user });
});

module.exports = { router, requireAuth, requireAdmin, requireStaffView, requireSuperAdmin, normalizePhone };
