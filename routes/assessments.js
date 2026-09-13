// routes/assessments.js
// Patient-facing: fetch the questionnaire, submit answers, view own submissions.

const express = require('express');
const db = require('../db/database');
const { requireAuth } = require('./auth');
const { DOMAINS, ANSWER_OPTIONS, scoreResponses } = require('../config/assessment-questions');

const router = express.Router();

// ---- GET /api/assessments/questions ----
router.get('/questions', requireAuth, (req, res) => {
  res.json({ domains: DOMAINS, answerOptions: ANSWER_OPTIONS });
});

// ---- POST /api/assessments  (submit a completed assessment) ----
router.post('/', requireAuth, (req, res) => {
  const { responses, additionalNotes } = req.body;

  if (!responses || typeof responses !== 'object') {
    return res.status(400).json({ error: 'Please answer all questions before submitting.' });
  }

  const allQuestionIds = DOMAINS.flatMap(d => d.questions.map(q => q.id));
  const missing = allQuestionIds.filter(id => !(id in responses));
  if (missing.length > 0) {
    return res.status(400).json({ error: `Please answer all questions. ${missing.length} question(s) missing.` });
  }

  const { domainResults, flaggedDomains, summary } = scoreResponses(responses);

  const storedResponses = JSON.stringify({ responses, additionalNotes: additionalNotes || '' });

  const stmt = db.prepare(`
    INSERT INTO assessments (user_id, responses, flagged_domains, preliminary_summary)
    VALUES (?, ?, ?, ?)
  `);
  const result = stmt.run(req.userId, storedResponses, JSON.stringify(flaggedDomains), summary);

  res.json({
    success: true,
    assessmentId: result.lastInsertRowid,
    summary,
    domainResults
  });
});

// ---- GET /api/assessments/mine  (patient's own assessment history) ----
router.get('/mine', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM assessments WHERE user_id = ? ORDER BY created_at DESC').all(req.userId);
  const assessments = rows.map(r => ({
    id: r.id,
    createdAt: r.created_at,
    status: r.status,
    flaggedDomains: JSON.parse(r.flagged_domains),
    preliminarySummary: r.preliminary_summary,
    adminConclusion: r.admin_conclusion,
    reviewedAt: r.reviewed_at
  }));
  res.json({ assessments });
});

module.exports = router;
