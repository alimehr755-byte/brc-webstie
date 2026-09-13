// routes/admin.js
// Staff-only endpoints: overview stats, patient list, appointment management, contact messages.

const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../db/database');
const { requireAdmin, requireStaffView, requireSuperAdmin, normalizePhone } = require('./auth');
const { classifyDiagnosis } = require('../config/diagnosis-categories');
const { DOMAINS } = require('../config/assessment-questions');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, Footer, AlignmentType } = require('docx');

const router = express.Router();
// router.use(requireAdmin)   // replaced by requireStaffView + per-route mutation guards
router.use(requireStaffView);

// Permission model (higher role inherits the lower role's rights):
//   super_admin  — full control (users/staff, settings, SMTP, backup, everything)
//   admin        — day-to-day operations: appointments, message replies, assessment
//                  review, patient credentials, exports; may VIEW users/audit but
//                  cannot create/manage staff, change settings, or download backups
//   clinician    — READ-ONLY staff: overview, appointments, messages, assessments,
//                  patients (view only). Every mutation below is guarded with
//                  requireAdmin or requireSuperAdmin, so clinicians always get 403.

// Attach the acting admin's identity to every request for audit logging.
router.use((req, res, next) => {
  try {
    const actor = db.prepare('SELECT id, guardian_name, role FROM users WHERE id = ?').get(req.userId);
    if (actor) {
      req.adminId = actor.id;
      req.adminName = actor.guardian_name;
      req.adminRole = actor.role;
    }
  } catch (err) { /* ignore */ }
  next();
});

const { getClinic, refreshClinic } = require('../config/clinic-info');
const { getSmtp, isConfigured, sendMail } = require('../config/mailer');
const LOGO_PATH = path.join(__dirname, '..', 'public', 'images', 'logo.png');

// ---- helper: build a SQL date-range clause from optional ?from=&to= query params ----
function dateRangeClause(column, from, to) {
  const clauses = [];
  const params = [];
  if (from) { clauses.push(`date(${column}) >= date(?)`); params.push(from); }
  if (to) { clauses.push(`date(${column}) <= date(?)`); params.push(to); }
  return { sql: clauses.length ? 'WHERE ' + clauses.join(' AND ') : '', params };
}

// ---- helper: draw the clinic letterhead at the top of a PDF page, returns the y to start content at ----
function addLetterhead(doc, subtitle) {
  const clinic = getClinic();
  try {
    doc.image(LOGO_PATH, 50, 38, { width: 62 });
  } catch (err) {
    // logo missing on disk — degrade gracefully, still show text letterhead
  }
  doc.fontSize(17).fillColor('#1E3C82').text(clinic.clinic_name, 122, 40, { width: 380 });
  doc.fontSize(8.5).fillColor('#5A5D55').text(clinic.clinic_address, 122, 62, { width: 380 });
  doc.fontSize(8.5).fillColor('#5A5D55').text(`${clinic.clinic_email}   ·   ${clinic.clinic_phone}`, 122, 75, { width: 380 });
  doc.moveTo(50, 106).lineTo(545, 106).strokeColor('#E1EEF8').lineWidth(1).stroke();
  doc.fontSize(13).fillColor('#C99436').text(subtitle, 50, 116);
  doc.fontSize(7.5).fillColor('#9FC3E0').text(
    `Generated ${new Date().toLocaleString()}   ·   Confidential — for clinical use only`, 50, 134
  );
  doc.y = 158;
}

// ---- helper: draw a page-number + address footer on every page of a buffered PDF ----
function addFooters(doc) {
  const clinic = getClinic();
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const originalBottomMargin = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.fontSize(7.5).fillColor('#9FC3E0').text(
      `${clinic.clinic_name}  ·  ${clinic.clinic_address}  ·  Page ${i - range.start + 1} of ${range.count}`,
      50, doc.page.height - 30, { align: 'center', width: doc.page.width - 100, lineBreak: false }
    );
    doc.page.margins.bottom = originalBottomMargin;
  }
}

// ---- helper: draw a simple bordered/striped data table, returns the y position after the table ----
function drawTable(doc, headers, rows, colWidths, startY) {
  const startX = 50;
  const totalWidth = colWidths.reduce((a, b) => a + b, 0);
  let y = startY;
  const rowH = 20;

  doc.rect(startX, y, totalWidth, 22).fill('#1E3C82');
  let x = startX;
  headers.forEach((h, i) => {
    doc.fillColor('#FFFFFF').fontSize(8.5).text(h, x + 5, y + 6, { width: colWidths[i] - 10, height: 14, ellipsis: true, lineBreak: false });
    x += colWidths[i];
  });
  y += 22;

  rows.forEach((row, rIdx) => {
    if (y + rowH > doc.page.height - 60) {
      doc.addPage();
      y = 50;
    }
    doc.rect(startX, y, totalWidth, rowH).fill(rIdx % 2 === 0 ? '#FBF8F2' : '#F0F7FC');
    x = startX;
    row.forEach((cell, i) => {
      doc.fillColor('#232520').fontSize(8).text(String(cell == null || cell === '' ? '—' : cell), x + 5, y + 6, {
        width: colWidths[i] - 10,
        height: 14,
        ellipsis: true,
        lineBreak: false
      });
      x += colWidths[i];
    });
    y += rowH;
  });

  // PDFKit's text() with an explicit x updates doc.x to that x for chained calls —
  // reset it back to the left margin so anything drawn after the table isn't
  // squeezed into whatever sliver of width was left after the last column.
  doc.x = startX;
  return y + 12;
}

const THERAPY_LABELS = {
  occupational_therapy: 'Occupational Therapy',
  speech_therapy: 'Speech Therapy',
  physical_therapy: 'Physical Therapy',
  behavior_therapy: 'Behavior Therapy',
  audio_verbal_therapy: 'Audio-Verbal Therapy',
  prosthetic_orthotic: 'Prosthetic / Orthotic',
  montessori: 'Montessori Program',
  school_readiness: 'School Readiness Program',
  other: 'Other'
};

// ---- GET /api/admin/stats ----
// Optional ?from=YYYY-MM-DD&to=YYYY-MM-DD filters appointments/patients by created_at.
router.get('/stats', (req, res) => {
  const { from, to } = req.query;
  const patientFilter = dateRangeClause('created_at', from, to);
  const apptFilter = dateRangeClause('created_at', from, to);

  const totalPatients = db.prepare(`SELECT COUNT(*) c FROM users ${patientFilter.sql ? patientFilter.sql + " AND role = 'patient'" : "WHERE role = 'patient'"}`).get(...patientFilter.params).c;
  const totalAppointments = db.prepare(`SELECT COUNT(*) c FROM appointments ${apptFilter.sql}`).get(...apptFilter.params).c;
  const byStatus = db.prepare(`SELECT status, COUNT(*) c FROM appointments ${apptFilter.sql} GROUP BY status`).all(...apptFilter.params);
  const byMode = db.prepare(`SELECT mode, COUNT(*) c FROM appointments ${apptFilter.sql} GROUP BY mode`).all(...apptFilter.params);
  const newMessages = db.prepare('SELECT COUNT(*) c FROM contact_messages WHERE replied = 0').get().c;

  // Count each therapy type across appointments in range (types stored as a JSON array per row)
  const allAppointments = db.prepare(`SELECT therapy_types FROM appointments ${apptFilter.sql}`).all(...apptFilter.params);
  const therapyCounts = {};
  allAppointments.forEach(row => {
    const types = JSON.parse(row.therapy_types);
    types.forEach(t => { therapyCounts[t] = (therapyCounts[t] || 0) + 1; });
  });
  const therapyBreakdown = Object.entries(therapyCounts).map(([key, count]) => ({
    label: THERAPY_LABELS[key] || key,
    count
  })).sort((a, b) => b.count - a.count);

  const statusCounts = { pending: 0, confirmed: 0, completed: 0, cancelled: 0 };
  byStatus.forEach(r => { statusCounts[r.status] = r.c; });

  const modeCounts = { in_clinic: 0, online: 0 };
  byMode.forEach(r => { modeCounts[r.mode] = r.c; });

  // Patient classification by diagnosis category (all patients, not date-filtered — a standing breakdown)
  const allPatients = db.prepare("SELECT diagnosis FROM users WHERE role = 'patient'").all();
  const categoryCounts = {};
  allPatients.forEach(p => {
    const cat = classifyDiagnosis(p.diagnosis);
    categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
  });
  const diagnosisBreakdown = Object.entries(categoryCounts).map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count);

  // Appointments per month for the last 6 months (trend line)
  const monthlyTrend = db.prepare(`
    SELECT strftime('%Y-%m', created_at) as month, COUNT(*) as count
    FROM appointments
    WHERE created_at >= date('now', '-6 months')
    GROUP BY month ORDER BY month ASC
  `).all();

  // Assessment stats
  const totalAssessments = db.prepare('SELECT COUNT(*) c FROM assessments').get().c;
  const pendingAssessments = db.prepare("SELECT COUNT(*) c FROM assessments WHERE status = 'pending_review'").get().c;

  // Recent signups (last 5) and recent appointments (last 5)
  const recentPatients = db.prepare("SELECT id, guardian_name, child_name, username, created_at FROM users WHERE role = 'patient' ORDER BY created_at DESC LIMIT 5").all();

  res.json({
    totalPatients,
    totalAppointments,
    statusCounts,
    modeCounts,
    therapyBreakdown,
    diagnosisBreakdown,
    monthlyTrend,
    totalAssessments,
    pendingAssessments,
    newMessages,
    recentPatients
  });
});

// ---- GET /api/admin/patients ----
// Optional ?category=Autism+Spectrum to filter by classified diagnosis group.
router.get('/patients', (req, res) => {
  const patients = db.prepare(`
    SELECT u.id, u.guardian_name, u.child_name, u.diagnosis, u.country_code, u.phone, u.username, u.address, u.created_at,
           COUNT(a.id) as appointment_count
    FROM users u
    LEFT JOIN appointments a ON a.user_id = u.id
    WHERE u.role = 'patient'
    GROUP BY u.id
    ORDER BY u.created_at DESC
  `).all();

  let withCategory = patients.map(p => ({ ...p, diagnosis_category: classifyDiagnosis(p.diagnosis) }));

  const { category } = req.query;
  if (category && category !== 'all') {
    withCategory = withCategory.filter(p => p.diagnosis_category === category);
  }

  res.json({ patients: withCategory });
});

// ---- GET /api/admin/patients/:id  (full record: profile + appointments + assessments) ----
router.get('/patients/:id', (req, res) => {
  const patient = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'patient'").get(req.params.id);
  if (!patient) return res.status(404).json({ error: 'Patient not found.' });
  delete patient.password_hash;

  const appointments = db.prepare('SELECT * FROM appointments WHERE user_id = ? ORDER BY created_at DESC').all(req.params.id)
    .map(r => ({ ...r, therapy_types: JSON.parse(r.therapy_types).map(t => THERAPY_LABELS[t] || t) }));

  const assessments = db.prepare('SELECT * FROM assessments WHERE user_id = ? ORDER BY created_at DESC').all(req.params.id)
    .map(r => ({
      id: r.id,
      createdAt: r.created_at,
      status: r.status,
      flaggedDomains: JSON.parse(r.flagged_domains),
      preliminarySummary: r.preliminary_summary,
      adminConclusion: r.admin_conclusion,
      reviewedAt: r.reviewed_at
    }));

  res.json({
    patient: { ...patient, diagnosis_category: classifyDiagnosis(patient.diagnosis) },
    appointments,
    assessments
  });
});

// ---- PATCH /api/admin/patients/:id/credentials  (admin edits a patient's phone/username and/or password) ----
router.patch('/patients/:id/credentials', requireAdmin, (req, res) => {
  const { newUsername, newPassword } = req.body;
  const patient = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'patient'").get(req.params.id);
  if (!patient) return res.status(404).json({ error: 'Patient not found.' });

  if (!newUsername && !newPassword) {
    return res.status(400).json({ error: 'Provide a new phone number and/or a new password to change.' });
  }

  if (newPassword && newPassword.length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters.' });
  }

  let finalUsername = patient.username;
  if (newUsername && newUsername.trim()) {
    finalUsername = normalizePhone(newUsername.trim());
    if (!/^\+\d{7,15}$/.test(finalUsername)) {
      return res.status(400).json({ error: 'That phone number doesn\'t look valid. Use local (03xxxxxxxxx) or international (+92xxxxxxxxxx) format.' });
    }
    if (finalUsername !== patient.username) {
      const clash = db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(finalUsername, patient.id);
      if (clash) return res.status(409).json({ error: 'Another account already uses that phone number.' });
    }
  }

  const updates = ['username = ?'];
  const params = [finalUsername];

  if (newPassword) {
    updates.push('password_hash = ?');
    params.push(bcrypt.hashSync(newPassword, 10));
  }

  params.push(patient.id);
  db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);

  res.json({
    success: true,
    message: newPassword && finalUsername !== patient.username
      ? 'Phone number and password updated.'
      : newPassword ? 'Password updated.' : 'Phone number updated.',
    username: finalUsername
  });
});

// ---- GET /api/admin/appointments ----
// Optional query params: ?status=pending&from=YYYY-MM-DD&to=YYYY-MM-DD
router.get('/appointments', (req, res) => {
  const { status, from, to } = req.query;
  const conditions = [];
  const params = [];
  if (status && status !== 'all') { conditions.push('a.status = ?'); params.push(status); }
  if (from) { conditions.push("date(a.created_at) >= date(?)"); params.push(from); }
  if (to) { conditions.push("date(a.created_at) <= date(?)"); params.push(to); }
  const whereSql = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  const rows = db.prepare(`
    SELECT a.*, u.guardian_name, u.child_name, u.username
    FROM appointments a JOIN users u ON u.id = a.user_id
    ${whereSql}
    ORDER BY a.created_at DESC
  `).all(...params);

  const appointments = rows.map(r => ({ ...r, therapy_types: JSON.parse(r.therapy_types) }));
  res.json({ appointments });
});

// ---- PATCH /api/admin/appointments/:id  (update status) ----
router.patch('/appointments/:id', requireAdmin, (req, res) => {
  const { status } = req.body;
  const validStatuses = ['pending', 'confirmed', 'completed', 'cancelled'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: 'Invalid status.' });
  }
  const result = db.prepare('UPDATE appointments SET status = ? WHERE id = ?').run(status, req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Appointment not found.' });
  res.json({ success: true, message: 'Appointment updated.' });
});

// ---- GET /api/admin/messages ----
router.get('/messages', (req, res) => {
  const messages = db.prepare('SELECT * FROM contact_messages ORDER BY created_at DESC').all()
    .map(m => ({ ...m, replied: Boolean(m.replied) }));
  res.json({ messages, smtpConfigured: isConfigured(getSmtp()) });
});

// ---- POST /api/admin/messages/:id/reply ----
// Sends an email reply to the visitor (when SMTP is configured and send !== false)
// and records the reply on the message row so it shows as "Replied" in the table.
// { replyText, send: bool, to?: emailOverride } — send=false saves the reply as a
// note only (SMTP is then optional).
router.post('/messages/:id/reply', requireAdmin, async (req, res) => {
  const msg = db.prepare('SELECT * FROM contact_messages WHERE id = ?').get(req.params.id);
  if (!msg) return res.status(404).json({ error: 'Message not found.' });

  const b = req.body || {};
  const body = String(b.replyText || '').trim().slice(0, 5000);
  if (!body) return res.status(400).json({ error: 'Please enter a reply before sending.' });

  const sendFlag = b.send !== false && b.send !== 'false';
  const recipient = String(b.to || '').trim() || (msg.email || '').trim();
  const senderName = req.adminName || 'Staff';
  if (!recipient) {
    return res.status(400).json({
      error: 'This visitor did not provide an email address. Reply via the WhatsApp / email draft links, or save the reply as a note instead.'
    });
  }

  let info = null;
  if (sendFlag) {
    if (!isConfigured(getSmtp())) {
      return res.status(400).json({ error: 'Outbound email is not configured. Open Settings → Email, save your mail host/credentials, then try again (or save the reply as a note).' });
    }
    try {
      info = await sendMail({
        to: recipient,
        subject: `Re: your message to ${getClinic().clinic_name}`,
        text: `Hello ${msg.name},\n\n${body}\n\n--\n${getClinic().clinic_name}\n${getClinic().clinic_phone}\n${getClinic().clinic_email}`
      });
    } catch (err) {
      return res.status(502).json({ error: `Email could not be sent: ${err.message}` });
    }
  }

  db.prepare(`
    UPDATE contact_messages
    SET replied = 1, reply_text = ?, reply_to = ?, replied_by = ?, replied_at = datetime('now')
    WHERE id = ?
  `).run(body, recipient, senderName, msg.id);
  logAudit(req, 'contact_reply', 'contact_message', msg.id,
    sendFlag ? `Replied to ${recipient}${info && info.messageId ? ' (messageId ' + info.messageId + ')' : ''}` : `Saved reply note for ${recipient}`);
  res.json({
    ok: true,
    message: sendFlag ? 'Reply sent to the visitor.' : 'Reply saved and marked as replied.',
    messageId: info && info.messageId ? info.messageId : null
  });
});

// ---- GET /api/admin/assessments ----
// Optional ?status=pending_review
router.get('/assessments', (req, res) => {
  const { status } = req.query;
  const conditions = [];
  const params = [];
  if (status && status !== 'all') { conditions.push('s.status = ?'); params.push(status); }
  const whereSql = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  const rows = db.prepare(`
    SELECT s.*, u.guardian_name, u.child_name, u.username
    FROM assessments s JOIN users u ON u.id = s.user_id
    ${whereSql}
    ORDER BY s.created_at DESC
  `).all(...params);

  const assessments = rows.map(r => ({
    id: r.id,
    guardianName: r.guardian_name,
    childName: r.child_name,
    username: r.username,
    createdAt: r.created_at,
    status: r.status,
    flaggedDomains: JSON.parse(r.flagged_domains),
    preliminarySummary: r.preliminary_summary,
    adminConclusion: r.admin_conclusion,
    adminReviewer: r.admin_reviewer,
    reviewedAt: r.reviewed_at
  }));
  res.json({ assessments });
});

// ---- GET /api/admin/assessments/:id  (full Q&A detail) ----
router.get('/assessments/:id', (req, res) => {
  const row = db.prepare(`
    SELECT s.*, u.guardian_name, u.child_name, u.username, u.diagnosis
    FROM assessments s JOIN users u ON u.id = s.user_id
    WHERE s.id = ?
  `).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Assessment not found.' });

  const stored = JSON.parse(row.responses);
  const domainDetail = DOMAINS.map(domain => ({
    id: domain.id,
    label: domain.label,
    relatedTherapy: domain.relatedTherapy,
    questions: domain.questions.map(q => ({
      text: q.text,
      answer: stored.responses[q.id]
    }))
  }));

  res.json({
    id: row.id,
    guardianName: row.guardian_name,
    childName: row.child_name,
    username: row.username,
    diagnosis: row.diagnosis,
    createdAt: row.created_at,
    status: row.status,
    flaggedDomains: JSON.parse(row.flagged_domains),
    preliminarySummary: row.preliminary_summary,
    additionalNotes: stored.additionalNotes || '',
    domainDetail,
    adminConclusion: row.admin_conclusion,
    adminReviewer: row.admin_reviewer,
    reviewedAt: row.reviewed_at
  });
});

// ---- PATCH /api/admin/assessments/:id  (add staff conclusion, mark reviewed) ----
router.patch('/assessments/:id', requireAdmin, (req, res) => {
  const { conclusion, reviewerName } = req.body;
  if (!conclusion || !conclusion.trim()) {
    return res.status(400).json({ error: 'Please enter a conclusion before saving.' });
  }
  const result = db.prepare(`
    UPDATE assessments
    SET admin_conclusion = ?, admin_reviewer = ?, status = 'reviewed', reviewed_at = datetime('now')
    WHERE id = ?
  `).run(conclusion.trim(), reviewerName || 'Staff', req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Assessment not found.' });
  res.json({ success: true, message: 'Conclusion saved.' });
});

// ==================== USER MANAGEMENT & AUDIT LOG ====================

const USER_ROLES = ['patient', 'clinician', 'admin', 'super_admin'];
const STATUSES = ['pending', 'active', 'suspended', 'deactivated', 'deleted'];

// Record an administrative action. Logging must never break the action itself.
function logAudit(req, action, targetType, targetId, detail) {
  try {
    db.prepare(
      'INSERT INTO audit_logs (admin_id, admin_name, action, target_type, target_id, detail) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(req.adminId || req.userId || null, req.adminName || '', action, targetType || '', targetId == null ? null : Number(targetId),
      detail == null ? null : String(detail).slice(0, 500));
  } catch (err) { /* noop */ }
}

// Is this acting admin allowed to manage the given target user?
// Super admins manage everyone; regular admins manage only patients and clinicians
// (never other admins / super admins).
function canManage(actorRole, target) {
  if (actorRole === 'super_admin') return true;
  return target.role === 'patient' || target.role === 'clinician';
}

// Build the login username the same way signup does: country code + bare national digits.
function buildUsername(countryCode, phone) {
  let cleanPhone = String(phone || '').replace(/\D/g, '');
  if (cleanPhone.startsWith('0')) cleanPhone = cleanPhone.slice(1);
  return `${String(countryCode || '').replace(/\D/g, '')}${cleanPhone}`;
}

function generateTemporaryPassword(length = 10) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

// ---- GET /api/admin/users  (classified user list: pagination + search + filters) ----
// ?tab=all|patients|clinicians|administrators|pending  ?search=  ?role=  ?status=  ?from=  ?to=  ?page=  ?perPage=
router.get('/users', (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const perPage = Math.min(200, Math.max(1, parseInt(req.query.perPage, 10) || 25));
  const tab = String(req.query.tab || 'all');

  const conditions = [];
  const params = [];

  if (tab === 'patients') conditions.push("u.role = 'patient'");
  else if (tab === 'clinicians') conditions.push("u.role = 'clinician'");
  else if (tab === 'administrators') conditions.push("u.role IN ('admin','super_admin')");
  else if (tab === 'pending') conditions.push("u.status = 'pending'");

  const roleParam = String(req.query.role || '');
  if (roleParam) {
    const roles = roleParam.split(',').map(s => s.trim()).filter(r => USER_ROLES.includes(r));
    if (roles.length) {
      conditions.push(`u.role IN (${roles.map(() => '?').join(',')})`);
      params.push(...roles);
    }
  }
  const statusParam = String(req.query.status || '');
  if (statusParam) {
    const statuses = statusParam.split(',').map(s => s.trim()).filter(s => STATUSES.includes(s));
    if (statuses.length) {
      conditions.push(`u.status IN (${statuses.map(() => '?').join(',')})`);
      params.push(...statuses);
    }
  } else if (tab !== 'pending') {
    // By default hide soft-deleted accounts unless explicitly requested.
    conditions.push("u.status != 'deleted'");
  }
  if (statusParam.includes('deleted')) {
    conditions.push("u.status = 'deleted'");
  }

  if (req.query.from) { conditions.push('date(u.created_at) >= date(?)'); params.push(String(req.query.from)); }
  if (req.query.to) { conditions.push('date(u.created_at) <= date(?)'); params.push(String(req.query.to)); }

  const searchTerm = String(req.query.search || '').trim();
  if (searchTerm) {
    conditions.push('(u.guardian_name LIKE ? OR u.child_name LIKE ? OR u.username LIKE ? OR u.email LIKE ? OR u.phone LIKE ? OR CAST(u.id AS TEXT) = ?)');
    const like = `%${searchTerm}%`;
    params.push(like, like, like, like, like, searchTerm);
  }

  const whereSql = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  const total = db.prepare(`SELECT COUNT(*) c FROM users u ${whereSql}`).get(...params).c;
  const pages = Math.max(1, Math.ceil(total / perPage));
  const offset = (page - 1) * perPage;

  const users = db.prepare(`
    SELECT u.id, u.guardian_name, u.child_name, u.diagnosis, u.country_code, u.phone, u.username,
           u.address, u.email, u.role, u.status, u.must_change_password, u.created_at,
           (SELECT COUNT(*) FROM appointments a WHERE a.user_id = u.id) AS appointment_count,
           (SELECT COUNT(*) FROM assessments s WHERE s.user_id = u.id) AS assessment_count,
           (SELECT COUNT(*) FROM gait_sessions g WHERE g.user_id = u.id) AS gait_count
    FROM users u
    ${whereSql}
    ORDER BY u.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, perPage, offset);

  res.json({ users, total, page, pages, perPage });
});

// ---- GET /api/admin/users/:id  (full classified profile + activity summary) ----
router.get('/users/:id', (req, res) => {
  const user = db.prepare(`
    SELECT id, guardian_name, child_name, diagnosis, country_code, phone, username, address,
           email, role, status, must_change_password, created_at
    FROM users WHERE id = ?
  `).get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Account not found.' });

  const stats = {
    appointments: db.prepare('SELECT COUNT(*) c FROM appointments WHERE user_id = ?').get(user.id).c,
    assessments: db.prepare('SELECT COUNT(*) c FROM assessments WHERE user_id = ?').get(user.id).c,
    gaitSessions: db.prepare('SELECT COUNT(*) c FROM gait_sessions WHERE user_id = ?').get(user.id).c
  };

  const activity = db.prepare(`
    SELECT id, admin_id, admin_name, action, target_type, target_id, detail, created_at
    FROM audit_logs
    WHERE target_type = 'user' AND target_id = ?
    ORDER BY created_at DESC LIMIT 15
  `).all(user.id);

  res.json({ user, stats, activity });
});

// ---- POST /api/admin/users  (Super Admin creates Clinician / Admin / Super Admin accounts) ----
// New staff accounts start with status 'pending' and cannot log in until a
// super administrator approves them (PATCH .../users/:id/status → active).
router.post('/users', requireSuperAdmin, (req, res) => {
  const {
    guardianName, childName, diagnosis, countryCode, phone, address, email, role, password, generate
  } = req.body;

  const cleanRole = String(role || 'clinician');
  if (!['clinician', 'admin', 'super_admin'].includes(cleanRole)) {
    return res.status(400).json({ error: 'Role must be clinician, admin or super_admin for a staff account.' });
  }
  if (!guardianName || !guardianName.trim()) {
    return res.status(400).json({ error: 'Guardian/full name is required.' });
  }
  if (!countryCode || !phone) {
    return res.status(400).json({ error: 'Phone number and country code are required.' });
  }

  let cleanEmail = String(email || '').trim();
  if (cleanEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    return res.status(400).json({ error: 'That email address doesn\'t look valid.' });
  }
  if (!cleanEmail) cleanEmail = null;

  const username = buildUsername(countryCode, phone);
  if (!/^\d{7,15}$/.test(username)) {
    return res.status(400).json({ error: 'That phone number doesn\'t look valid.' });
  }
  const clash = db.prepare('SELECT id FROM users WHERE username = ?').get(username)
    || db.prepare('SELECT id FROM users WHERE username = ?').get('+' + username);
  if (clash) return res.status(409).json({ error: 'An account with this phone number already exists.' });

  let newPassword = String(password || '');
  let tempPassword = null;
  if (generate || !newPassword) {
    tempPassword = generateTemporaryPassword();
    newPassword = tempPassword;
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }

  const result = db.prepare(`
    INSERT INTO users (guardian_name, child_name, diagnosis, country_code, phone, username, address, email, password_hash, role, status, must_change_password)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 1)
  `).run(
    guardianName.trim(), String(childName || '').trim(), String(diagnosis || '').trim(),
    String(countryCode), String(phone), username, String(address || '').trim(), cleanEmail,
    bcrypt.hashSync(newPassword, 10), cleanRole
  );

  logAudit(req, 'create_user', 'user', result.lastInsertRowid, `Created ${cleanRole} account (${username}) — forced password change on first login`);
  addNotification('staff_created', `New ${cleanRole} account created: ${guardianName.trim()} (${username})`, `/admin-dashboard.html#users`);
  res.status(201).json({
    success: true,
    id: result.lastInsertRowid,
    message: `${cleanRole === 'super_admin' ? 'Super administrator' : cleanRole === 'admin' ? 'Administrator' : 'Clinician'} account created. It is pending approval and cannot log in until activated.`,
    tempPassword
  });
});

// ---- PUT /api/admin/users/:id  (edit account details / contact info / role) ----
router.put('/users/:id', requireAdmin, (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'Account not found.' });
  if (!canManage(req.adminRole, target)) {
    return res.status(403).json({ error: 'Only a super administrator can manage administrator accounts.' });
  }

  const {
    guardian_name, child_name, diagnosis, country_code, phone, address, email, role, username
  } = req.body;

  let changes = [];

  const finalGuardian = String(guardian_name ?? target.guardian_name).trim() || target.guardian_name;
  const finalChild = String(child_name ?? target.child_name).trim() || target.child_name;
  const finalDiagnosis = String((diagnosis ?? target.diagnosis) || '').trim() || null;
  const finalAddr = String((address ?? target.address) || '').trim() || null;

  if (finalGuardian !== target.guardian_name) changes.push('guardian_name');
  if (finalChild !== target.child_name) changes.push('child_name');
  if (finalDiagnosis !== (target.diagnosis || null)) changes.push('diagnosis');
  if (finalAddr !== (target.address || null)) changes.push('address');

  let finalEmail = (email !== undefined ? String(email).trim() : target.email);
  if (!finalEmail) finalEmail = null;
  if (finalEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(finalEmail)) {
    return res.status(400).json({ error: 'That email address doesn\'t look valid.' });
  }
  if ((finalEmail || null) !== (target.email || null)) changes.push('email');

  // Username changes are classified: only super admins may set the login username directly.
  let finalUsername = target.username;
  if (username !== undefined && String(username).trim() !== '') {
    const raw = String(username).trim();
    const bare = raw.startsWith('+') ? raw.slice(1) : raw;
    if (req.adminRole !== 'super_admin') {
      return res.status(403).json({ error: 'Only a super administrator can change account usernames.' });
    }
    if (!/^\d{7,15}$/.test(bare)) {
      return res.status(400).json({ error: 'Username must contain 7–15 digits.' });
    }
    if (bare !== target.username.replace(/^\+/, '')) {
      const clash = db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(bare, target.id)
        || db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get('+' + bare, target.id);
      if (clash) return res.status(409).json({ error: 'Another account already uses that username.' });
      finalUsername = bare;
      changes.push('username');
    }
  } else if (country_code !== undefined || phone !== undefined) {
    // Otherwise phone changes still produce a new derived login username (mirrors signup rule).
    const cc = country_code !== undefined ? country_code : target.country_code;
    const ph = phone !== undefined ? phone : target.phone;
    const candidate = buildUsername(cc, ph);
    if (!/^\d{7,15}$/.test(candidate)) {
      return res.status(400).json({ error: 'That phone number doesn\'t look valid.' });
    }
    if (candidate !== target.username) {
      const clash = db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(candidate, target.id)
        || db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get('+' + candidate, target.id);
      if (clash) return res.status(409).json({ error: 'Another account already uses that phone number.' });
      finalUsername = candidate;
      changes.push('username');
    }
    if (String(cc || '') !== String(target.country_code || '')) changes.push('country_code');
  }

  // Role changes are classified: only super admins may assign or change
  // admin/super_admin roles, and nobody may demote the last active super admin.
  let finalRole = target.role;
  if (role !== undefined && String(role) !== target.role) {
    if (req.adminRole !== 'super_admin') {
      return res.status(403).json({ error: 'Only a super administrator can change roles.' });
    }
    if (!USER_ROLES.includes(String(role))) {
      return res.status(400).json({ error: 'Invalid role.' });
    }
    if (req.userId === target.id) {
      return res.status(400).json({ error: 'You cannot change your own role.' });
    }
    if (target.role === 'super_admin' || String(role) === 'super_admin') {
      const activeSupers = db.prepare("SELECT COUNT(*) c FROM users WHERE role = 'super_admin' AND status = 'active'").get().c;
      const willDemote = target.role === 'super_admin' && String(role) !== 'super_admin';
      if (willDemote && activeSupers <= 1) {
        return res.status(400).json({ error: 'Cannot demote the last active super administrator.' });
      }
    }
    finalRole = String(role);
    changes.push('role');
  }

  db.prepare(`
    UPDATE users SET guardian_name = ?, child_name = ?, diagnosis = ?, country_code = ?,
                     phone = ?, username = ?, address = ?, email = ?, role = ?
    WHERE id = ?
  `).run(finalGuardian, finalChild, finalDiagnosis, cfgCc(target, country_code), finalPhone(target, phone), finalUsername, finalAddr, finalEmail, finalRole, target.id);

  logAudit(req, 'edit_user', 'user', target.id, `Updated: ${changes.length ? changes.join(', ') : 'no fields'}`);
  res.json({ success: true, message: 'Account updated.', username: finalUsername, changes });
});

function cfgCc(target, country_code) {
  return country_code !== undefined ? String(country_code) : target.country_code;
}
function finalPhone(target, phone) {
  return phone !== undefined ? String(phone) : target.phone;
}

// ---- POST /api/admin/users/:id/reset-password  (admin override / temporary password) ----
// body: { newPassword }  or  { generate: true }  → a temporary password is generated
// and returned exactly once to the administrator.
router.post('/users/:id/reset-password', requireAdmin, (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'Account not found.' });
  if (!canManage(req.adminRole, target)) {
    return res.status(403).json({ error: 'Only a super administrator can reset administrator credentials.' });
  }

  const { newPassword, generate, forceChange } = req.body;
  let password = String(newPassword || '');
  let tempPassword = null;
  if (generate) {
    // Any staff admin may generate a temporary password for an account they manage.
    tempPassword = generateTemporaryPassword();
    password = tempPassword;
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters.' });
  }
  const mustChange = tempPassword ? 1 : (forceChange ? 1 : 0);

  db.prepare('UPDATE users SET password_hash = ?, must_change_password = ? WHERE id = ?').run(bcrypt.hashSync(password, 10), mustChange, target.id);
  logAudit(req, 'reset_password', 'user', target.id,
    tempPassword ? `Generated and set a temporary password${mustChange ? ' — forced change on next login' : ''}`
                  : `Password overridden by administrator${mustChange ? ' — forced change on next login' : ''}`);
  res.json({
    success: true,
    message: tempPassword ? 'Temporary password generated and set. Share it once with the user.' : 'Password updated.',
    tempPassword,
    forceChange: !!mustChange
  });
});

// ---- PATCH /api/admin/users/:id/status  (approve / suspend / deactivate / activate) ----
router.patch('/users/:id/status', requireAdmin, (req, res) => {
  const { status } = req.body;
  if (!STATUSES.includes(String(status)) || String(status) === 'deleted') {
    return res.status(400).json({ error: 'Valid statuses: pending, active, suspended, deactivated.' });
  }
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'Account not found.' });
  if (!canManage(req.adminRole, target)) {
    return res.status(403).json({ error: 'Only a super administrator can change administrator account status.' });
  }
  if (req.userId === target.id && String(status) !== 'active') {
    return res.status(400).json({ error: 'You cannot suspend/deactivate your own account.' });
  }
  if ((target.role === 'admin' || target.role === 'super_admin') && req.adminRole !== 'super_admin') {
    return res.status(403).json({ error: 'Only a super administrator can change administrator account status.' });
  }

  db.prepare('UPDATE users SET status = ? WHERE id = ?').run(String(status), target.id);
  logAudit(req, 'set_status', 'user', target.id, `${target.role} account moved to '${status}'`);
  if (String(status) === 'active') {
    addNotification('staff_approved', `${target.role === 'clinician' ? 'Clinician' : 'Administrator'} account approved and activated: ${target.guardian_name || target.username} (${target.username})`, `/admin-dashboard.html#staff`);
  }
  res.json({ success: true, message: `Account status set to ${String(status)}.` });
});

// ---- DELETE /api/admin/users/:id  (soft delete — record is kept, account hidden) ----
// The UI double-confirm requires typing DELETE; server enforces the same token.
router.delete('/users/:id', requireAdmin, (req, res) => {
  const { confirm } = req.body || {};
  if (!req.body || String(confirm ?? '').trim().toUpperCase() !== 'DELETE') {
    return res.status(400).json({ error: 'Type DELETE to confirm this account deletion.' });
  }
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'Account not found.' });
  if (!canManage(req.adminRole, target)) {
    return res.status(403).json({ error: 'Only a super administrator can delete administrator accounts.' });
  }
  if (req.userId === target.id) {
    return res.status(400).json({ error: 'You cannot delete your own account.' });
  }
  if ((target.role === 'admin' || target.role === 'super_admin') && req.adminRole !== 'super_admin') {
    return res.status(403).json({ error: 'Only a super administrator can delete administrator accounts.' });
  }

  db.prepare("UPDATE users SET status = 'deleted' WHERE id = ?").run(target.id);
  logAudit(req, 'delete_user', 'user', target.id, `Soft-deleted ${target.role} account (${target.username})`);
  res.json({ success: true, message: 'Account hidden and its login disabled. Record retained (soft delete).' });
});

// ---- POST /api/admin/users/:id/purge  (Super Admin — permanent hard delete + related records) ----
router.post('/users/:id/purge', requireSuperAdmin, (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'Account not found.' });
  if (req.userId === target.id) {
    return res.status(400).json({ error: 'You cannot purge your own account.' });
  }

  const trim = /^\d+$/.test(String(target.id));
  const gaitIds = trim ? db.prepare('SELECT id FROM gait_sessions WHERE user_id = ?').all(target.id).map(r => r.id) : [];
  db.prepare('DELETE FROM appointments WHERE user_id = ?').run(target.id);
  db.prepare('DELETE FROM assessments WHERE user_id = ?').run(target.id);
  db.prepare('DELETE FROM gait_sessions WHERE user_id = ?').run(target.id);
  db.prepare('DELETE FROM audit_logs WHERE target_type = ? AND target_id = ?').run('user', target.id);
  db.prepare('DELETE FROM users WHERE id = ?').run(target.id);

  // Best-effort file cleanup for this account's gait artifacts.
  const fs = require('fs');
  gaitIds.forEach(sid => {
    const dir = path.join(__dirname, '..', 'uploads', 'gait', 'artifacts', String(sid));
    try { if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true }); } catch (err) { /* ignore */ }
  });

  logAudit(req, 'purge_user', 'user', target.id, `Permanently removed account (${target.username}) and all related records`);
  res.json({ success: true, message: 'Account and all related records permanently removed.' });
});

// ---- GET /api/admin/audit-logs  (recent administrative actions) ----
// ?action=edit_user&adminId=  ?page=  ?perPage=
router.get('/audit-logs', (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const perPage = Math.min(200, Math.max(1, parseInt(req.query.perPage, 10) || 25));
  const conditions = [];
  const params = [];
  if (req.query.action) { conditions.push('action = ?'); params.push(String(req.query.action)); }
  if (req.query.adminId) { conditions.push('admin_id = ?'); params.push(Number(req.query.adminId)); }

  const whereSql = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const total = db.prepare(`SELECT COUNT(*) c FROM audit_logs ${whereSql}`).get(...params).c;
  const pages = Math.max(1, Math.ceil(total / perPage));
  const logs = db.prepare(`
    SELECT id, admin_id, admin_name, action, target_type, target_id, detail, created_at
    FROM audit_logs ${whereSql}
    ORDER BY created_at DESC, id DESC
    LIMIT ? OFFSET ?
  `).all(...params, perPage, (page - 1) * perPage);
  res.json({ logs, total, page, pages, perPage });
});

// ==================== EXPORTS ====================

// ---- GET /api/admin/export/xlsx  (multi-sheet workbook: Patients, Appointments, Assessments) ----
// Optional ?from=YYYY-MM-DD&to=YYYY-MM-DD filters appointments/assessments by created_at.
// Zebra-stripe data rows of a worksheet (header row 1 excluded) for readability.
function zebraFill(ws, rowCount) {
  for (let i = 2; i <= rowCount; i++) {
    if (i % 2 === 0) {
      ws.getRow(i).eachCell(cell => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEAF0F8' } };
      });
    }
  }
}

router.get('/export/xlsx', requireAdmin, async (req, res) => {
  const { from, to } = req.query;
  const apptFilter = dateRangeClause('a.created_at', from, to);
  const assessFilter = dateRangeClause('s.created_at', from, to);

  const workbook = new ExcelJS.Workbook();
  const clinic = getClinic();
  workbook.creator = clinic.clinic_name;
  workbook.created = new Date();

  // --- Summary sheet, created first so it's the first tab a reader sees ---
  const patientCountForSummary = db.prepare("SELECT COUNT(*) c FROM users WHERE role = 'patient'").get().c;
  const apptCountForSummary = db.prepare(`SELECT COUNT(*) c FROM appointments ${apptFilter.sql}`).get(...apptFilter.params).c;
  const assessCountForSummary = db.prepare(`SELECT COUNT(*) c FROM assessments ${assessFilter.sql.replace(/s\.created_at/g, 'created_at')}`).get(...assessFilter.params).c;

  const summarySheet = workbook.addWorksheet('Summary');
  summarySheet.getCell('A1').value = clinic.clinic_name;
  summarySheet.getCell('A1').font = { bold: true, size: 16, color: { argb: 'FF1E3C82' } };
  summarySheet.getCell('A2').value = clinic.clinic_address;
  summarySheet.getCell('A3').value = `${clinic.clinic_email}  ·  ${clinic.clinic_phone}`;
  summarySheet.getCell('A5').value = 'Full Data Export';
  summarySheet.getCell('A5').font = { bold: true, size: 12 };
  summarySheet.getCell('A6').value = 'Export Date';
  summarySheet.getCell('B6').value = new Date().toLocaleString();
  summarySheet.getCell('A7').value = 'Generator Admin';
  summarySheet.getCell('B7').value = req.adminName || 'Staff';
  const totalUserRecords = db.prepare("SELECT COUNT(*) c FROM users WHERE status != 'deleted'").get().c;
  summarySheet.getCell('A8').value = 'Total Records (active accounts)';
  summarySheet.getCell('B8').value = totalUserRecords;
  summarySheet.getCell('A9').value = (from || to) ? `Appointments/assessments filtered: ${from || 'start'} to ${to || 'today'}` : 'No date filter applied — full history included';
  summarySheet.getCell('A11').value = 'Total Patients';
  summarySheet.getCell('B11').value = patientCountForSummary;
  summarySheet.getCell('A12').value = 'Total Appointments (in range)';
  summarySheet.getCell('B12').value = apptCountForSummary;
  summarySheet.getCell('A13').value = 'Total Assessments (in range)';
  summarySheet.getCell('B13').value = assessCountForSummary;
  summarySheet.getColumn('A').width = 34;
  summarySheet.getColumn('B').width = 14;

  // --- Users sheet (all accounts: patients, clinicians, admins, super admins) ---
  const usersSheet = workbook.addWorksheet('Users');
  usersSheet.columns = [
    { header: 'User ID', key: 'id', width: 10 },
    { header: 'Full Name (Guardian)', key: 'guardian_name', width: 24 },
    { header: 'Child Name', key: 'child_name', width: 22 },
    { header: 'Role', key: 'role', width: 14 },
    { header: 'Status', key: 'status', width: 14 },
    { header: 'Email', key: 'email', width: 28 },
    { header: 'Phone (Username)', key: 'username', width: 18 },
    { header: 'Diagnosis', key: 'diagnosis', width: 26 },
    { header: 'Address', key: 'address', width: 34 },
    { header: 'Appointments', key: 'appointment_count', width: 14 },
    { header: 'Assessments', key: 'assessment_count', width: 13 },
    { header: 'Gait Sessions', key: 'gait_count', width: 13 },
    { header: 'Registered', key: 'created_at', width: 20 }
  ];
  const allUsers = db.prepare(`
    SELECT u.id, u.guardian_name, u.child_name, u.role, u.status, u.email, u.username,
           u.diagnosis, u.address, u.created_at,
           (SELECT COUNT(*) FROM appointments a WHERE a.user_id = u.id) AS appointment_count,
           (SELECT COUNT(*) FROM assessments s WHERE s.user_id = u.id) AS assessment_count,
           (SELECT COUNT(*) FROM gait_sessions g WHERE g.user_id = u.id) AS gait_count
    FROM users u
    WHERE u.status != 'deleted'
    ORDER BY u.created_at DESC
  `).all();
  allUsers.forEach(r => usersSheet.addRow(r));
  usersSheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  usersSheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3C82' } };
  usersSheet.autoFilter = { from: 'A1', to: `M${allUsers.length + 1}` };
  zebraFill(usersSheet, allUsers.length + 1);

  // --- Patients sheet ---
  const patientsSheet = workbook.addWorksheet('Patients');
  patientsSheet.columns = [
    { header: 'Patient ID', key: 'id', width: 10 },
    { header: 'Guardian Name', key: 'guardian_name', width: 22 },
    { header: 'Child Name', key: 'child_name', width: 22 },
    { header: 'Diagnosis', key: 'diagnosis', width: 26 },
    { header: 'Diagnosis Category', key: 'diagnosis_category', width: 24 },
    { header: 'Country Code', key: 'country_code', width: 12 },
    { header: 'Phone (Username)', key: 'username', width: 18 },
    { header: 'Home Address', key: 'address', width: 34 },
    { header: 'Total Appointments', key: 'appointment_count', width: 16 },
    { header: 'Total Assessments', key: 'assessment_count', width: 16 },
    { header: 'Last Appointment Status', key: 'last_status', width: 20 },
    { header: 'Last Appointment Date', key: 'last_appt_date', width: 20 },
    { header: 'Registered', key: 'created_at', width: 20 }
  ];
  const patients = db.prepare(`
    SELECT u.id, u.guardian_name, u.child_name, u.diagnosis, u.country_code, u.username, u.address, u.created_at,
           (SELECT COUNT(*) FROM appointments a WHERE a.user_id = u.id) as appointment_count,
           (SELECT COUNT(*) FROM assessments s WHERE s.user_id = u.id) as assessment_count,
           (SELECT status FROM appointments a WHERE a.user_id = u.id ORDER BY a.created_at DESC LIMIT 1) as last_status,
           (SELECT preferred_date FROM appointments a WHERE a.user_id = u.id ORDER BY a.created_at DESC LIMIT 1) as last_appt_date
    FROM users u
    WHERE u.role = 'patient'
    ORDER BY u.created_at DESC
  `).all();
  patients.forEach(p => patientsSheet.addRow({ ...p, diagnosis_category: classifyDiagnosis(p.diagnosis) }));
  patientsSheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  patientsSheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3C82' } };
  patientsSheet.autoFilter = { from: 'A1', to: `M${patients.length + 1}` };
  zebraFill(patientsSheet, patients.length + 1);

  // --- Appointments sheet ---
  const apptSheet = workbook.addWorksheet('Appointments');
  apptSheet.columns = [
    { header: 'Appointment ID', key: 'id', width: 14 },
    { header: 'Patient ID', key: 'user_id', width: 10 },
    { header: 'Guardian', key: 'guardian_name', width: 20 },
    { header: 'Child', key: 'child_name', width: 20 },
    { header: 'Phone', key: 'username', width: 16 },
    { header: 'Therapy Types', key: 'therapy_types', width: 36 },
    { header: 'Other Description', key: 'other_description', width: 24 },
    { header: 'Mode', key: 'mode', width: 12 },
    { header: 'Preferred Date', key: 'preferred_date', width: 16 },
    { header: 'Status', key: 'status', width: 14 },
    { header: 'Notes', key: 'notes', width: 30 },
    { header: 'Booked On', key: 'created_at', width: 20 }
  ];
  const appts = db.prepare(`
    SELECT a.*, u.guardian_name, u.child_name, u.username
    FROM appointments a JOIN users u ON u.id = a.user_id
    ${apptFilter.sql}
    ORDER BY a.created_at DESC
  `).all(...apptFilter.params);
  appts.forEach(a => apptSheet.addRow({
    ...a,
    therapy_types: JSON.parse(a.therapy_types).map(t => THERAPY_LABELS[t] || t).join(', ')
  }));
  apptSheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  apptSheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3C82' } };
  apptSheet.autoFilter = { from: 'A1', to: `L${appts.length + 1}` };
  zebraFill(apptSheet, appts.length + 1);

  // --- Assessments sheet ---
  const assessSheet = workbook.addWorksheet('Assessments');
  assessSheet.columns = [
    { header: 'Assessment ID', key: 'id', width: 14 },
    { header: 'Patient ID', key: 'user_id', width: 10 },
    { header: 'Guardian', key: 'guardian_name', width: 20 },
    { header: 'Child', key: 'child_name', width: 20 },
    { header: 'Phone', key: 'username', width: 16 },
    { header: 'Flagged Domains', key: 'flagged_domains', width: 30 },
    { header: 'Preliminary Summary', key: 'preliminary_summary', width: 50 },
    { header: 'Status', key: 'status', width: 16 },
    { header: 'Staff Conclusion', key: 'admin_conclusion', width: 40 },
    { header: 'Reviewed By', key: 'admin_reviewer', width: 18 },
    { header: 'Reviewed At', key: 'reviewed_at', width: 20 },
    { header: 'Submitted', key: 'created_at', width: 20 }
  ];
  const assessments = db.prepare(`
    SELECT s.*, u.guardian_name, u.child_name, u.username
    FROM assessments s JOIN users u ON u.id = s.user_id
    ${assessFilter.sql}
    ORDER BY s.created_at DESC
  `).all(...assessFilter.params);
  assessments.forEach(a => assessSheet.addRow({
    ...a,
    flagged_domains: JSON.parse(a.flagged_domains).join(', ') || 'None'
  }));
  assessSheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  assessSheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3C82' } };
  assessSheet.autoFilter = { from: 'A1', to: `L${assessments.length + 1}` };
  zebraFill(assessSheet, assessments.length + 1);

  logAudit(req, 'export_xlsx', 'export', null, `Full data export (${totalUserRecords} active accounts, ${apptCountForSummary} appointments, ${assessCountForSummary} assessments)`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="brc-data-export.xlsx"');
  await workbook.xlsx.write(res);
  res.end();
});

// ---- GET /api/admin/export/overview.pdf  (clinic-wide summary report) ----
router.get('/export/overview.pdf', requireAdmin, (req, res) => {
  const { from, to } = req.query;
  const apptFilter = dateRangeClause('created_at', from, to);

  const totalPatients = db.prepare("SELECT COUNT(*) c FROM users WHERE role = 'patient'").get().c;
  const totalAppointments = db.prepare(`SELECT COUNT(*) c FROM appointments ${apptFilter.sql}`).get(...apptFilter.params).c;
  const byStatus = db.prepare(`SELECT status, COUNT(*) c FROM appointments ${apptFilter.sql} GROUP BY status`).all(...apptFilter.params);
  const allAppointments = db.prepare(`SELECT therapy_types FROM appointments ${apptFilter.sql}`).all(...apptFilter.params);
  const therapyCounts = {};
  allAppointments.forEach(row => {
    JSON.parse(row.therapy_types).forEach(t => { therapyCounts[t] = (therapyCounts[t] || 0) + 1; });
  });
  const therapyBreakdown = Object.entries(therapyCounts).map(([key, count]) => ({ label: THERAPY_LABELS[key] || key, count })).sort((a, b) => b.count - a.count);

  const allPatients = db.prepare("SELECT diagnosis FROM users WHERE role = 'patient'").all();
  const categoryCounts = {};
  allPatients.forEach(p => { const c = classifyDiagnosis(p.diagnosis); categoryCounts[c] = (categoryCounts[c] || 0) + 1; });
  const diagnosisBreakdown = Object.entries(categoryCounts).map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count);

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="brc-overview-report.pdf"');

  const doc = new PDFDocument({ margin: 50, bufferPages: true });
  doc.pipe(res);

  const rangeLabel = from || to ? `Period: ${from || 'start'} to ${to || 'today'}` : 'Period: All time';
  addLetterhead(doc, 'Clinic Overview Report');
  doc.fontSize(9).fillColor('#8A8A8A').text(rangeLabel, 50, doc.y);
  doc.moveDown(1);

  const kpis = [
    ['Total Patients', totalPatients],
    ['Appointments (period)', totalAppointments],
    ['Pending', byStatus.find(s => s.status === 'pending')?.c || 0],
    ['Completed', byStatus.find(s => s.status === 'completed')?.c || 0]
  ];
  const kpiColWidth = 122;
  const kpiStartY = doc.y;
  kpis.forEach(([label, value], i) => {
    const cx = 50 + i * kpiColWidth;
    doc.roundedRect(cx, kpiStartY, kpiColWidth - 10, 58, 6).fill('#F0F7FC');
    doc.fontSize(8.5).fillColor('#5A5D55').text(label, cx + 8, kpiStartY + 10, { width: kpiColWidth - 26, height: 22, ellipsis: true });
    doc.fontSize(20).fillColor('#1E3C82').text(String(value), cx + 8, kpiStartY + 30, { width: kpiColWidth - 26, height: 24, lineBreak: false });
  });
  doc.x = 50;
  doc.y = kpiStartY + 74;

  doc.fontSize(13).fillColor('#1E3C82').text('Appointments by Therapy Type');
  doc.moveDown(0.5);
  const chartX = 50, chartW = 400, barH = 16, gap = 10;
  const maxCount = Math.max(1, ...therapyBreakdown.map(t => t.count));
  let y = doc.y;
  therapyBreakdown.forEach(t => {
    const w = Math.max(4, (t.count / maxCount) * chartW);
    doc.rect(chartX, y, w, barH).fill('#46B4DC');
    doc.fontSize(9).fillColor('#232520').text(`${t.label} (${t.count})`, chartX + w + 8, y + 3, { width: 130 });
    y += barH + gap;
  });
  doc.y = y + 10;

  doc.fontSize(13).fillColor('#1E3C82').text('Appointments by Status');
  doc.moveDown(0.4);
  ['pending', 'confirmed', 'completed', 'cancelled'].forEach(s => {
    const count = byStatus.find(row => row.status === s)?.c || 0;
    doc.fontSize(10).fillColor('#232520').text(`${s.charAt(0).toUpperCase() + s.slice(1)}: ${count}`);
  });
  doc.moveDown(1);

  doc.fontSize(13).fillColor('#1E3C82').text('Patients by Diagnosis Category');
  doc.moveDown(0.4);
  diagnosisBreakdown.forEach(d => {
    doc.fontSize(10).fillColor('#232520').text(`${d.label}: ${d.count}`);
  });

  addFooters(doc);
  logAudit(req, 'export_overview_pdf', 'export', null, `Clinic overview PDF (${from || 'all time'} to ${to || 'today'})`);
  doc.end();
});

// ---- GET /api/admin/export/docx  (full "Users Directory" Word report for all active accounts) ----
// ?from=&to= optionally restrict to accounts registered in a date range.
router.get('/export/docx', requireAdmin, async (req, res) => {
  const { from, to } = req.query;
  const recFilter = dateRangeClause('u.created_at', from, to);
  const users = db.prepare(`
    SELECT u.id, u.guardian_name, u.child_name, u.role, u.status, u.email, u.username, u.created_at,
           (SELECT COUNT(*) FROM appointments a WHERE a.user_id = u.id) AS appointment_count,
           (SELECT COUNT(*) FROM assessments s WHERE s.user_id = u.id) AS assessment_count,
           (SELECT COUNT(*) FROM gait_sessions g WHERE g.user_id = u.id) AS gait_count
    FROM users u
    WHERE u.status != 'deleted' ${recFilter.sql.replace(/^WHERE /, 'AND ')}
    ORDER BY u.created_at DESC
  `).all(...recFilter.params);
  const total = users.length;
  const clinic = getClinic();
  const ROLE_LABEL = { patient: 'Patient', clinician: 'Clinician / Staff', admin: 'Administrator', super_admin: 'Super Administrator' };
  const STATUS_LABEL = { pending: 'Pending Approval', active: 'Active', suspended: 'Suspended', deactivated: 'Deactivated', deleted: 'Deleted' };

  const styleHeaderCell = (text) => new TableCell({
    children: [new Paragraph({ text, bold: true, color: 'FFFFFF' })],
    shading: { fill: '1E3C82' }
  });
  const tableRows = [
    new TableRow({ children: ['User ID', 'Full Name', 'Email / Username', 'Role', 'Status', 'Registered'].map(styleHeaderCell) }),
    ...users.map(u => new TableRow({ children: [
      new TableCell({ children: [new Paragraph(String(u.id))] }),
      new TableCell({ children: [new Paragraph([u.guardian_name, u.child_name].filter(Boolean).join(' - ') || '-')] }),
      new TableCell({ children: [new Paragraph([u.email, `@${u.username}`].filter(Boolean).join('\n'))] }),
      new TableCell({ children: [new Paragraph(ROLE_LABEL[u.role] || u.role)] }),
      new TableCell({ children: [new Paragraph(STATUS_LABEL[u.status] || u.status)] }),
      new TableCell({ children: [new Paragraph(String(u.created_at || ''))] })
    ]}))
  ];

  const doc = new Document({
    styles: {
      default: { document: { run: { size: 22 } } },
      paragraphStyles: [{ id: 'EndNote', name: 'EndNote', run: { italics: true, color: '9FC3E0' } }]
    },
    sections: [{
      children: [
        new Paragraph({ text: clinic.clinic_name, heading: HeadingLevel.TITLE }),
        new Paragraph({ text: clinic.clinic_address }),
        new Paragraph({ text: `${clinic.clinic_email}  ·  ${clinic.clinic_phone}`, spacing: { after: 200 } }),
        new Paragraph({ text: 'Users Directory', heading: HeadingLevel.HEADING_2 }),
        new Paragraph({ text: `Generated ${new Date().toLocaleString()} by ${req.adminName || 'Staff'}  ·  ${total} accounts${(from || to) ? ` registered ${from || 'start'} to ${to || 'today'}` : ''}`, spacing: { after: 300 } }),
        new Table({ rows: tableRows, width: { size: 100, type: WidthType.PERCENTAGE } }),

        new Paragraph({ text: '', spacing: { after: 300 } }),
        new Paragraph({ text: 'Clinical & Activity Notes', heading: HeadingLevel.HEADING_1 }),
        new Paragraph({ text: `This directory lists every active account (patients, clinicians and administrators) retained by the clinic — ${total} total. Per-account histories (appointments, assessments, gait sessions) are available from each profile's individual summary report or the spreadsheet export. Therapeutic assignment and program association are maintained through each patient's dashboard and appointment history.`, spacing: { after: 200 } }),
        new Paragraph({ text: '— End of report —', style: 'EndNote' })
      ],
      footers: {
        default: new Footer({
          children: [new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [new TextRun({ text: `${clinic.clinic_name}  ·  ${clinic.clinic_address}`, size: 16, color: '9FC3E0' })]
          })]
        })
      }
    }]
  });
  const buffer = await Packer.toBuffer(doc);

  logAudit(req, 'export_docx', 'export', null, `Full users directory DOCX (${total} accounts${(from || to) ? `, registered ${from || 'start'} to ${to || 'today'}` : ''})`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.setHeader('Content-Disposition', 'attachment; filename="brc-users-directory.docx"');
  res.send(buffer);
});

// ---- GET /api/admin/export/user/:id/report.docx  (classified per-user summary report) ----
// Branded clinic header + demographic table + account metadata + clinical assignment notes for
// any account (patient, clinician, admin). Super admins may export anyone; admins export everyone too.
router.get('/export/user/:id/report.docx', requireAdmin, async (req, res) => {
  const user = db.prepare(`
    SELECT id, guardian_name, child_name, diagnosis, country_code, phone, username, address,
           email, role, status, created_at
    FROM users WHERE id = ?
  `).get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Account not found.' });
  const clinic = getClinic();
  const appointments = db.prepare('SELECT COUNT(*) c FROM appointments WHERE user_id = ?').get(user.id).c;
  const assessments = db.prepare('SELECT COUNT(*) c FROM assessments WHERE user_id = ?').get(user.id).c;
  const gaitCount = db.prepare('SELECT COUNT(*) c FROM gait_sessions WHERE user_id = ?').get(user.id).c;

  const ROLE_LABEL = { patient: 'Patient', clinician: 'Clinician / Staff', admin: 'Administrator', super_admin: 'Super Administrator' };
  const STATUS_LABEL = { pending: 'Pending Approval', active: 'Active', suspended: 'Suspended', deactivated: 'Deactivated', deleted: 'Deleted' };

  const demoRows = (label, value) => new TableRow({
    children: [
      new TableCell({ children: [new Paragraph({ text: label, bold: true })] }),
      new TableCell({ children: [new Paragraph(String(value ?? '—'))] })
    ]
  });

  const children = [
    new Paragraph({ text: clinic.clinic_name, heading: HeadingLevel.TITLE }),
    new Paragraph({ text: clinic.clinic_address }),
    new Paragraph({ text: `${clinic.clinic_email}  ·  ${clinic.clinic_phone}`, spacing: { after: 200 } }),
    new Paragraph({ text: `User Profile Summary — ${user.child_name || user.guardian_name}`, heading: HeadingLevel.HEADING_2 }),
    new Paragraph({ text: `Generated ${new Date().toLocaleString()} by ${req.adminName || 'Staff'}  ·  Confidential — for clinical use only`, spacing: { after: 300 } }),

    new Paragraph({ text: 'Classified Demographic Table', heading: HeadingLevel.HEADING_1 }),
    new Table({
      rows: [
        demoRows('User ID', user.id),
        demoRows('Full Name (Guardian)', user.guardian_name),
        demoRows('Child / Assigned Name', user.child_name),
        demoRows('Role', ROLE_LABEL[user.role] || user.role),
        demoRows('Account Status', STATUS_LABEL[user.status] || user.status),
        demoRows('Email', user.email),
        demoRows('Phone (login username)', user.username),
        demoRows('Diagnosis', user.diagnosis || 'Not specified'),
        demoRows('Home Address', user.address || 'Not specified'),
        demoRows('Registered', user.created_at)
      ],
      width: { size: 100, type: WidthType.PERCENTAGE }
    }),

    new Paragraph({ text: '', spacing: { after: 300 } }),
    new Paragraph({ text: 'Clinical & Activity Notes', heading: HeadingLevel.HEADING_1 }),
    new Paragraph({ text: `Appointments recorded: ${appointments}` }),
    new Paragraph({ text: `Online assessments submitted: ${assessments}` }),
    new Paragraph({ text: `Gait Lab sessions: ${gaitCount}` }),
    new Paragraph({ text: 'Therapeutic assignment and program association are maintained through the patient dashboard and appointment history sections of the Bonsai Rehabilitation Center portal.', spacing: { after: 200 } }),
    new Paragraph({ text: '— End of report —', style: 'EndNote' })
  ];

  const doc = new Document({
    styles: {
      default: { document: { run: { size: 22 } } },
      paragraphStyles: [{ id: 'EndNote', name: 'EndNote', run: { italics: true, color: '9FC3E0' } }]
    },
    sections: [{
      children,
      footers: {
        default: new Footer({
          children: [new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [new TextRun({ text: `${clinic.clinic_name}  ·  ${clinic.clinic_address}`, size: 16, color: '9FC3E0' })]
          })]
        })
      }
    }]
  });
  const buffer = await Packer.toBuffer(doc);

  logAudit(req, 'export_docx', 'user', user.id, `Exported profile summary report for ${user.username}`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.setHeader('Content-Disposition', `attachment; filename="user-${user.id}-report.docx"`);
  res.send(buffer);
});

// ---- GET /api/admin/export/patient/:id/report.pdf ----
router.get('/export/patient/:id/report.pdf', requireAdmin, (req, res) => {
  const patient = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'patient'").get(req.params.id);
  if (!patient) return res.status(404).json({ error: 'Patient not found.' });

  const appointments = db.prepare('SELECT * FROM appointments WHERE user_id = ? ORDER BY created_at DESC').all(req.params.id);
  const assessments = db.prepare('SELECT * FROM assessments WHERE user_id = ? ORDER BY created_at DESC').all(req.params.id);

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="patient-${patient.id}-report.pdf"`);

  const doc = new PDFDocument({ margin: 50, bufferPages: true });
  doc.pipe(res);

  addLetterhead(doc, `Patient Report — ${patient.child_name}`);
  doc.moveDown(0.5);

  doc.fontSize(13).fillColor('#1E3C82').text('Profile');
  doc.moveDown(0.3);
  doc.fontSize(10).fillColor('#232520');
  doc.text(`Guardian: ${patient.guardian_name}`);
  doc.text(`Child: ${patient.child_name}`);
  doc.text(`Diagnosis: ${patient.diagnosis || 'Not specified'}  (${classifyDiagnosis(patient.diagnosis)})`);
  doc.text(`Phone (login username): ${patient.username}`);
  doc.text(`Patient's home address (as provided at signup): ${patient.address || 'Not specified'}`);
  doc.text(`Registered: ${patient.created_at}`);
  doc.moveDown(1);

  doc.fontSize(13).fillColor('#1E3C82').text(`Appointment History (${appointments.length})`);
  doc.moveDown(0.4);
  if (appointments.length === 0) {
    doc.fontSize(10).fillColor('#5A5D55').text('No appointments booked yet.');
    doc.moveDown(1);
  } else {
    const rows = appointments.map(a => [
      JSON.parse(a.therapy_types).map(t => THERAPY_LABELS[t] || t).join(', '),
      a.mode === 'online' ? 'Online' : 'In-Clinic',
      a.status,
      a.preferred_date || 'Not set',
      a.created_at.split(' ')[0]
    ]);
    const afterTableY = drawTable(doc, ['Therapy', 'Mode', 'Status', 'Preferred Date', 'Booked'], rows, [175, 60, 65, 85, 80], doc.y);
    doc.y = afterTableY;
    const notedAppointments = appointments.filter(a => a.notes);
    if (notedAppointments.length) {
      doc.fontSize(8.5).fillColor('#5A5D55').text('Notes:');
      notedAppointments.forEach(a => doc.fontSize(8.5).fillColor('#5A5D55').text(`• ${a.notes}`));
    }
    doc.moveDown(1);
  }

  doc.fontSize(13).fillColor('#1E3C82').text(`Online Assessments (${assessments.length})`);
  doc.moveDown(0.3);
  if (assessments.length === 0) {
    doc.fontSize(10).fillColor('#5A5D55').text('No online assessments submitted yet.');
  }
  assessments.forEach(a => {
    const flagged = JSON.parse(a.flagged_domains);
    doc.fontSize(10).fillColor('#232520').text(`Submitted ${a.created_at} — Status: ${a.status}`);
    doc.fontSize(9).fillColor('#5A5D55').text(`Flagged areas: ${flagged.length ? flagged.join(', ') : 'None'}`);
    doc.fontSize(9).fillColor('#5A5D55').text(`Preliminary summary: ${a.preliminary_summary}`);
    if (a.admin_conclusion) {
      doc.fontSize(9).fillColor('#1E3C82').text(`Staff conclusion (${a.admin_reviewer || 'staff'}): ${a.admin_conclusion}`);
    } else {
      doc.fontSize(9).fillColor('#B3452F').text('Staff conclusion: pending review');
    }
    doc.moveDown(0.5);
  });

  addFooters(doc);
  logAudit(req, 'export_docx', 'user', patient.id, `Exported patient PDF report for ${patient.username}`);
  doc.end();
});

// ---- GET /api/admin/export/patient/:id/report.docx ----
router.get('/export/patient/:id/report.docx', requireAdmin, async (req, res) => {
  const patient = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'patient'").get(req.params.id);
  if (!patient) return res.status(404).json({ error: 'Patient not found.' });
  const clinic = getClinic();

  const appointments = db.prepare('SELECT * FROM appointments WHERE user_id = ? ORDER BY created_at DESC').all(req.params.id);
  const assessments = db.prepare('SELECT * FROM assessments WHERE user_id = ? ORDER BY created_at DESC').all(req.params.id);

  const children = [
    new Paragraph({ text: clinic.clinic_name, heading: HeadingLevel.TITLE }),
    new Paragraph({ text: clinic.clinic_address }),
    new Paragraph({ text: `${clinic.clinic_email}  ·  ${clinic.clinic_phone}`, spacing: { after: 200 } }),
    new Paragraph({ text: `Patient Report — ${patient.child_name}`, heading: HeadingLevel.HEADING_2 }),
    new Paragraph({ text: `Generated ${new Date().toLocaleString()}  ·  Confidential — for clinical use only`, spacing: { after: 300 } }),

    new Paragraph({ text: 'Profile', heading: HeadingLevel.HEADING_1 }),
    new Paragraph({ text: `Guardian: ${patient.guardian_name}` }),
    new Paragraph({ text: `Child: ${patient.child_name}` }),
    new Paragraph({ text: `Diagnosis: ${patient.diagnosis || 'Not specified'} (${classifyDiagnosis(patient.diagnosis)})` }),
    new Paragraph({ text: `Phone (login username): ${patient.username}` }),
    new Paragraph({ text: `Patient's home address (as provided at signup): ${patient.address || 'Not specified'}` }),
    new Paragraph({ text: `Registered: ${patient.created_at}`, spacing: { after: 300 } }),

    new Paragraph({ text: `Appointment History (${appointments.length})`, heading: HeadingLevel.HEADING_1 })
  ];

  if (appointments.length === 0) {
    children.push(new Paragraph({ text: 'No appointments booked yet.' }));
  } else {
    const rows = [
      new TableRow({
        children: ['Therapy', 'Mode', 'Status', 'Preferred Date', 'Booked On'].map(h =>
          new TableCell({ children: [new Paragraph({ text: h, bold: true })] })
        )
      }),
      ...appointments.map(a => new TableRow({
        children: [
          JSON.parse(a.therapy_types).map(t => THERAPY_LABELS[t] || t).join(', '),
          a.mode === 'online' ? 'Online' : 'In-Clinic',
          a.status,
          a.preferred_date || '—',
          a.created_at
        ].map(v => new TableCell({ children: [new Paragraph(String(v))] }))
      }))
    ];
    children.push(new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } }));
  }

  children.push(new Paragraph({ text: '', spacing: { after: 300 } }));
  children.push(new Paragraph({ text: `Online Assessments (${assessments.length})`, heading: HeadingLevel.HEADING_1 }));

  if (assessments.length === 0) {
    children.push(new Paragraph({ text: 'No online assessments submitted yet.' }));
  } else {
    assessments.forEach(a => {
      const flagged = JSON.parse(a.flagged_domains);
      children.push(new Paragraph({ text: `Submitted ${a.created_at} — Status: ${a.status}`, heading: HeadingLevel.HEADING_2 }));
      children.push(new Paragraph({ text: `Flagged areas: ${flagged.length ? flagged.join(', ') : 'None'}` }));
      children.push(new Paragraph({ text: `Preliminary summary: ${a.preliminary_summary}` }));
      children.push(new Paragraph({
        text: a.admin_conclusion
          ? `Staff conclusion (${a.admin_reviewer || 'staff'}): ${a.admin_conclusion}`
          : 'Staff conclusion: pending review',
        spacing: { after: 200 }
      }));
    });
  }

  const doc = new Document({
    sections: [{
      children,
      footers: {
        default: new Footer({
          children: [new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [new TextRun({ text: `${clinic.clinic_name}  ·  ${clinic.clinic_address}`, size: 16, color: '9FC3E0' })]
          })]
        })
      }
    }]
  });
  const buffer = await Packer.toBuffer(doc);

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.setHeader('Content-Disposition', `attachment; filename="patient-${patient.id}-report.docx"`);
  logAudit(req, 'export_docx', 'user', patient.id, `Exported patient DOCX report for ${patient.username}`);
  res.send(buffer);
});

// ---------------------------------------------------------------------------
// Clinic settings (Settings tab)
// ---------------------------------------------------------------------------

// ---- GET /api/admin/settings — clinic profile + masked SMTP config (super admin only) ----
// Settings hold SMTP credentials: view AND edit stay with the super administrator.
router.get('/settings', requireSuperAdmin, (req, res) => {
  const clinic = getClinic();
  const smtp = getSmtp();
  // Never leak the SMTP password — the UI shows "•••• configured" instead.
  res.json({
    clinic: {
      clinic_name: clinic.clinic_name,
      clinic_address: clinic.clinic_address,
      clinic_phone: clinic.clinic_phone,
      clinic_email: clinic.clinic_email
    },
    smtp: {
      smtp_host: smtp.smtp_host || '',
      smtp_port: smtp.smtp_port || '587',
      smtp_secure: smtp.smtp_secure === 'true',
      smtp_user: smtp.smtp_user || '',
      smtp_from_name: smtp.smtp_from_name || '',
      smtp_from_email: smtp.smtp_from_email || '',
      smtp_has_pass: Boolean(smtp.smtp_pass)
    },
    smtpConfigured: isConfigured(smtp)
  });
});

// ---- PUT /api/admin/settings — update clinic profile + SMTP (super admin only) ----
router.put('/settings', (req, res) => {
  if (req.session.user.role !== 'super_admin') {
    return res.status(403).json({ error: 'Only the super administrator can change clinic settings.' });
  }
  const b = req.body || {};
  const clean = {
    clinic_name: String(b.clinic_name || '').trim(),
    clinic_address: String(b.clinic_address || '').trim(),
    clinic_phone: String(b.clinic_phone || '').trim(),
    clinic_email: String(b.clinic_email || '').trim()
  };
  if (!clean.clinic_name) return res.status(400).json({ error: 'Clinic name is required.' });

  const smtpCur = getSmtp();
  const smtpClean = {
    smtp_host: String(b.smtp_host || '').trim(),
    smtp_port: String(b.smtp_port || smtpCur.smtp_port || '587').trim().slice(0, 8),
    smtp_secure: String(b.smtp_secure) === 'true' ? 'true' : 'false',
    smtp_user: String(b.smtp_user || '').trim(),
    // Blank password on save keeps the stored one (UI never sends the real value back).
    smtp_pass: String(b.smtp_pass || '').trim() || smtpCur.smtp_pass || '',
    smtp_from_name: String(b.smtp_from_name || '').trim(),
    smtp_from_email: String(b.smtp_from_email || '').trim()
  };

  const upsert = db.prepare(`
    INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `);
  for (const [key, value] of Object.entries({ ...clean, ...smtpClean })) upsert.run(key, value);
  refreshClinic();
  logAudit(req, 'update_settings', 'system', null, 'Clinic profile and email (SMTP) settings updated by super administrator');
  res.json({ ok: true, clinic: { ...clean }, smtpConfigured: isConfigured(smtpClean) });
});

// ---- POST /api/admin/settings/smtp-test — send a test email (super admin only) ----
router.post('/settings/smtp-test', async (req, res) => {
  if (req.session.user.role !== 'super_admin') {
    return res.status(403).json({ error: 'Only the super administrator can test email settings.' });
  }
  const smtp = getSmtp();
  if (!isConfigured(smtp)) {
    return res.status(400).json({ error: 'SMTP is not configured yet. Save your mail host/credentials first.' });
  }
  const toEmail = String(req.session.user.email || '').trim() || getClinic().clinic_email;
  if (!toEmail) {
    return res.status(400).json({ error: 'Add an email to your admin account or a clinic email before testing.' });
  }
  try {
    const info = await sendMail({
      to: toEmail,
      subject: 'Bonsai Rehabilitation Center — SMTP test',
      text: 'This is a test email from the BRC website. If you received it, your outbound email settings are working correctly.'
    });
    logAudit(req, 'smtp_test', 'system', null, `Sent an SMTP test email to ${toEmail}`);
    res.json({ ok: true, message: `Test email sent to ${toEmail}.`, messageId: info.messageId });
  } catch (err) {
    res.status(502).json({ error: `Test failed: ${err.message}` });
  }
});

// ---------------------------------------------------------------------------
// Database backup (Settings tab → Download backup)
// ---------------------------------------------------------------------------

// ---- GET /api/admin/backup — consistent snapshot of the SQLite database ----
router.get('/backup', requireSuperAdmin, async (req, res) => {
  const tmpPath = path.join(os.tmpdir(), `brc-backup-${Date.now()}.sqlite`);
  try {
    await db.backup(tmpPath);
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    res.download(tmpPath, `brc-backup-${stamp}.sqlite`, (err) => {
      try { fs.unlinkSync(tmpPath); } catch (e) {}
      if (err && !res.headersSent) {
        return res.status(500).json({ error: 'Failed to stream backup.', details: String(err.message) });
      }
    });
    logAudit(req, 'backup_database', 'system', null, 'Downloaded a snapshot backup of the database');
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch (e) {}
    res.status(500).json({ error: 'Backup failed.', details: err.message || String(err) });
  }
});

// ---------------------------------------------------------------------------
// In-app notifications (bell in the admin top bar)
// ---------------------------------------------------------------------------

function addNotification(type, message, link) {
  db.prepare('INSERT INTO notifications (type, message, link) VALUES (?, ?, ?)').run(type, message, link || null);
}

// ---- GET /api/admin/notifications?limit=&offset= ----
router.get('/notifications', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, 50);
  const offset = parseInt(req.query.offset) || 0;
  const total = db.prepare('SELECT COUNT(*) c FROM notifications').get().c;
  const unread = db.prepare('SELECT COUNT(*) c FROM notifications WHERE read = 0').get().c;
  const items = db.prepare('SELECT * FROM notifications ORDER BY id DESC LIMIT ? OFFSET ?').all(limit, offset);
  res.json({ total, unread, items });
});

// ---- GET /api/admin/notifications/unread-count ----
router.get('/notifications/unread-count', (req, res) => {
  const unread = db.prepare('SELECT COUNT(*) c FROM notifications WHERE read = 0').get().c;
  res.json({ unread });
});

// ---- POST /api/admin/notifications/:id/read ----
router.post('/notifications/:id/read', (req, res) => {
  const r = db.prepare('UPDATE notifications SET read = 1 WHERE id = ?').run(req.params.id);
  if (!r.changes) return res.status(404).json({ error: 'Notification not found.' });
  res.json({ ok: true });
});

// ---- POST /api/admin/notifications/read-all ----
router.post('/notifications/read-all', (req, res) => {
  db.prepare('UPDATE notifications SET read = 1 WHERE read = 0').run();
  res.json({ ok: true });
});

module.exports = router;
