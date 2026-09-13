// routes/contact.js
// Handles the public Contact Us form (no login required).

const express = require('express');
const db = require('../db/database');

const router = express.Router();

router.post('/', (req, res) => {
  const { name, email, phone, message } = req.body;
  if (!name || !message) {
    return res.status(400).json({ error: 'Please enter your name and a message.' });
  }
  db.prepare('INSERT INTO contact_messages (name, email, phone, message) VALUES (?, ?, ?, ?)')
    .run(name, email || '', phone || '', message);
  const preview = String(message).trim().slice(0, 80).replace(/\s+/g, ' ') || '(no message text)';
  db.prepare('INSERT INTO notifications (type, message, link) VALUES (?, ?, ?)')
    .run('contact_message', `New contact message from ${String(name).slice(0, 40)} — "${preview}"`, '/admin-dashboard.html#messages');
  res.json({ success: true, message: 'Thanks — we\'ll get back to you soon.' });
});

module.exports = router;
