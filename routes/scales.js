// Clinical Scales API — BBS (14-item), TUG, GMFCS-E&R, digital Rancho OGA.
//
// Scoring life in the Python engine (python/bbs_engine.py + scales_registry.py,
// reached via scales_cli.py); this router only persists/returns what the engine
// produced — no interpretation logic duplicated in JS.
//
// Role model (routes/auth.js):
//   admin / super_admin : create for any patient, review, edit, delete
//   clinician           : create + read for any patient, read-only elsewhere
//   patient             : read own records only
//
// Zero-assumption (spec P1): every POST is scored by the engine; a record is
// stored with status exactly as the engine judged it ('assessed'/'unassessed'/'stub').

const express = require('express');
const path = require('path');
const { spawn } = require('child_process');
const db = require('../db/database');
const { requireAuth, requireAdmin, requireStaffView } = require('./auth');

const router = express.Router();

const SCALE_TYPES = ['bbs', 'tug', 'gmfcs', 'oga', '6mwt', '2mwt', '10mwt', 'fac', 'tinetti', 'dgi', 'fap', 'iowa_loa'];
const CLI_PATH = path.join(__dirname, '..', 'python', 'scales_cli.py');

// ---- python interpreter plumbing (mirrors routes/gait.js, kept local so the
// scales router stays self-contained; env GAIT_PYTHON overrides the search) ----
function probePython(bin) {
  return new Promise((resolve) => {
    let out = '', err = '', timer, r;
    try {
      const [pcmd, ...pre] = bin.split(/\s+/);
      r = spawn(pcmd, [...pre, '-c', 'print(1)'], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { return resolve(null); }
    const done = (sel) => { clearTimeout(timer); resolve(sel); };
    timer = setTimeout(() => { try { r.kill(); } catch (e) { /* noop */ } done(null); }, 6000);
    r.stdout.on('data', d => { out += d; });
    r.on('error', () => done(null));
    r.on('close', code => done(code === 0 && String(out).trim() === '1' ? bin : null));
  });
}
async function pythonBin() {
  const candidates = process.env.GAIT_PYTHON ? [process.env.GAIT_PYTHON] : ['py', 'py -3', 'python', 'python3'];
  for (const c of candidates) { const s = await probePython(c); if (s) return s; }
  return null;
}
// Spawns scales_cli.py with the JSON payload piped over stdin; resolves the
// engine's JSON payload. Rejects with stderr on failure (fail closed; P2).
function runScaleEngine(scaleType, data) {
  return new Promise(async (resolve, reject) => {
    const bin = await pythonBin();
    if (!bin) return reject(new Error('Python runtime unavailable — scale cannot be scored (no fabricated results).'));
    const child = spawn(bin, [CLI_PATH, scaleType], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    const timer = setTimeout(() => { try { child.kill(); } catch (e) { /* noop */ } }, 15000);
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) {
        try { resolve(JSON.parse(out)); }
        catch (e) { reject(new Error(`Engine output was not JSON: ${String(out).slice(0, 200)}`)); }
      } else reject(new Error(`Scale engine exited ${code}: ${String(err).slice(0, 500)}`));
    });
    child.stdin.write(JSON.stringify(data));
    child.stdin.end();
  });
}

// ---- role helpers ----
function roleOf(req) {
  return (req.session && req.session.user && req.session.user.role) || 'patient';
}
function isStaff(role) {
  return role === 'admin' || role === 'super_admin' || role === 'clinician';
}

// req.session.user is populated by requireAuth (routes/auth.js) —arded.
function requireStaffMutator(req, res, next) {
  if (!req.userId || !isStaff(roleOf(req))) {
    return res.status(403).json({ error: 'Staff role required to record clinical scales.' });
  }
  next();
}

function patientOwnsOrStaff(req, res, next) {
  const target = Number(req.params.userId);
  if (!isStaff(roleOf(req)) && req.userId !== target) {
    return res.status(403).json({ error: 'You may only access your own records.' });
  }
  next();
}

// ---- serialize a stored row ----
function serialize(row) {
  return {
    id: row.id,
    user_id: row.user_id,
    scale_type: row.scale_type,
    status: row.status,
    items: safeParse(row.items),
    payload: safeParse(row.payload),
    total: row.total,
    interpretation: row.interpretation,
    assessor: row.assessor,
    notes: row.notes,
    related_session_id: row.related_session_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
function safeParse(s) { try { return s ? JSON.parse(s) : null; } catch (e) { return null; } }

// ===========================================================================
// POST /api/scales/:userId/:scaleType — record + score a scale
// body: { items?, data?, evaluator_id?, notes? }
//   bbs  → items: {"1":0..4, ..., "14":0..4}, population?: 'stroke'|...
//   tug  → data: { seconds, population, assistive_device, observations[] }
//   gmfcs→ data: { level: 'I'..'V', age_years, reported_via }
//   oga  → data: { observations: [{segment, deviation, phase, side}] }
// ===========================================================================
router.post('/:userId/:scaleType', requireAuth, requireStaffMutator, async (req, res) => {
  const userId = Number(req.params.userId);
  const scaleType = String(req.params.scaleType || '').toLowerCase();
  if (!SCALE_TYPES.includes(scaleType)) return res.status(400).json({ error: 'Unknown scale type.' });

  const patient = db.prepare('SELECT id, child_name, guardian_name FROM users WHERE id = ?').get(userId);
  if (!patient || patient.id <= 0) return res.status(404).json({ error: 'Patient not found.' });

  const body = req.body || {};
  const assessorName = (req.session && req.session.user && req.session.user.guardian_name) || null;
  const engineData = scaleType === 'bbs'
    ? { patient_id: String(userId), evaluator_id: body.evaluator_id || assessorName || null,
        item_scores: body.items || {}, population: body.population || 'general' }
    : Object.assign({}, body.data || {}, body.items || {});

  let payload;
  try {
    payload = await runScaleEngine(scaleType, engineData);
  } catch (e) {
    console.error('[SCALES] engine failed:', e.message);
    return res.status(500).json({ error: e.message });
  }

  const status = (payload && payload.status) || 'unassessed';
  const staff = db.prepare('SELECT guardian_name FROM users WHERE id = ?').get(req.userId);

  const info = db.prepare(`
    INSERT INTO clinical_scales (user_id, scale_type, status, items, payload, total,
      interpretation, assessor, notes, related_session_id, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    userId, scaleType, status,
    JSON.stringify(scaleType === 'bbs' ? (body.items || {}) : (body.data || body.items || {})),
    JSON.stringify(payload),
    payload && payload.total != null ? Number(payload.total) : null,
    payload && payload.interpretation
      ? (typeof payload.interpretation === 'string'
          ? payload.interpretation
          : JSON.stringify(payload.interpretation))
      : null,
    staff ? staff.guardian_name : assessorName,
    body.notes || null,
    body.related_session_id != null ? Number(body.related_session_id) : null,
    req.userId
  );

  const row = db.prepare('SELECT * FROM clinical_scales WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json(serialize(row));
});

// ===========================================================================
// GET /api/scales/patient/:userId?scale=...  — list a patient's records
// ===========================================================================
router.get('/patient/:userId', requireAuth, patientOwnsOrStaff, (req, res) => {
  const userId = Number(req.params.userId);
  const scale = req.query.scale ? String(req.query.scale).toLowerCase() : null;
  let rows;
  if (scale && SCALE_TYPES.includes(scale)) {
    rows = db.prepare('SELECT * FROM clinical_scales WHERE user_id = ? AND scale_type = ? ORDER BY created_at DESC').all(userId, scale);
  } else {
    rows = db.prepare('SELECT * FROM clinical_scales WHERE user_id = ? ORDER BY created_at DESC').all(userId);
  }
  res.json({ records: rows.map(serialize) });
});

// ===========================================================================
// GET /api/scales/patient/:userId/latest/:scaleType — used by report builders
// ===========================================================================
router.get('/patient/:userId/latest/:scaleType', requireAuth, patientOwnsOrStaff, (req, res) => {
  const userId = Number(req.params.userId);
  const scaleType = String(req.params.scaleType || '').toLowerCase();
  if (!SCALE_TYPES.includes(scaleType)) return res.status(400).json({ error: 'Unknown scale type.' });
  const row = db.prepare(
    "SELECT * FROM clinical_scales WHERE user_id = ? AND scale_type = ? AND status IN ('assessed','reviewed') ORDER BY created_at DESC LIMIT 1"
  ).get(userId, scaleType);
  if (!row) return res.status(404).json({ error: `No ${scaleType} record on file.` });
  res.json(serialize(row));
});

// ===========================================================================
// PATCH /api/scales/:id — admin: attach notes / mark reviewed
// ===========================================================================
router.patch('/:id', requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM clinical_scales WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Record not found.' });
  const notes = req.body && req.body.notes != null ? String(req.body.notes).slice(0, 2000) : row.notes;
  const status = req.body && req.body.status === 'reviewed' ? 'reviewed' : row.status;
  db.prepare('UPDATE clinical_scales SET notes = ?, status = ?, updated_at = datetime(\'now\') WHERE id = ?').run(notes, status, id);
  res.json(serialize(db.prepare('SELECT * FROM clinical_scales WHERE id = ?').get(id)));
});

// ===========================================================================
// DELETE /api/scales/:id — admin only (Super Admin per site-wide policy)
// ===========================================================================
router.delete('/:id', requireAuth, requireAdmin, (req, res) => {
  const info = db.prepare('DELETE FROM clinical_scales WHERE id = ?').run(Number(req.params.id));
  if (!info.changes) return res.status(404).json({ error: 'Record not found.' });
  res.json({ ok: true });
});

// CLI sanity endpoint (staff): proves the offline engine is reachable.
router.get('/engine-status', requireAuth, requireStaffView, async (req, res) => {
  try {
    const bin = await pythonBin();
    res.json({ engine: 'scales_cli.py', python: bin ? 'available' : 'unavailable', offline: true });
  } catch (e) {
    res.json({ engine: 'scales_cli.py', python: 'unavailable', error: e.message });
  }
});

module.exports = router;
