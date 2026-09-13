// routes/appointments.js
// Handles creating and listing appointments for the logged-in patient.

const express = require('express');
const db = require('../db/database');
const { requireAuth } = require('./auth');

const router = express.Router();

// ---- POST /api/appointments  (create a booking) ----
router.post('/', requireAuth, (req, res) => {
  const { therapyTypes, otherDescription, mode, preferredDate, notes } = req.body;

  if (!Array.isArray(therapyTypes) || therapyTypes.length === 0) {
    return res.status(400).json({ error: 'Please select at least one therapy type.' });
  }
  if (!mode || !['in_clinic', 'online'].includes(mode)) {
    return res.status(400).json({ error: 'Please choose in-clinic or online.' });
  }
  if (therapyTypes.includes('other') && !otherDescription) {
    return res.status(400).json({ error: 'Please describe the "Other" therapy need.' });
  }

  const stmt = db.prepare(`
    INSERT INTO appointments (user_id, therapy_types, other_description, mode, preferred_date, notes)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    req.userId,
    JSON.stringify(therapyTypes),
    otherDescription || '',
    mode,
    preferredDate || '',
    notes || ''
  );

  const user = req.session.user || {};
  const label = user.child_name || user.guardian_name || ('user #' + req.userId);
  db.prepare('INSERT INTO notifications (type, message, link) VALUES (?, ?, ?)')
    .run('new_booking', `New appointment request from ${label} (${mode === 'online' ? 'online' : 'in-clinic'})`, `/admin-dashboard.html#appointments`);

  res.json({ success: true, appointmentId: result.lastInsertRowid, message: 'Appointment request submitted.' });
});

// ---- GET /api/appointments  (list this patient's bookings) ----
router.get('/', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM appointments WHERE user_id = ? ORDER BY created_at DESC').all(req.userId);
  const appointments = rows.map(r => ({ ...r, therapy_types: JSON.parse(r.therapy_types) }));
  res.json({ appointments });
});

module.exports = router;
