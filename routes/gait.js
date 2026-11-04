// routes/gait.js
// Gait Lab — dual-view video sessions with an automated multi-planar analysis
// pipeline. Authenticated patients upload Frontal + Sagittal walk videos; the
// BRC Python analyzer (python/gait_analyzer.py) produces the clinical
// interpretation (gait-cycle phases, anomalies, deformities, ROM, muscle map,
// prescriptions, references). Branded PDF / Word reports are exported from the
// stored result. Staff review sessions in the Admin Dashboard.

const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const multer = require('multer');
const db = require('../db/database');
const { requireAuth, requireAdmin, requireStaffView } = require('./auth');
const PDFDocument = require('pdfkit');
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow,
  TableCell, WidthType, Footer, AlignmentType, ImageRun
} = require('docx');

const { getClinic } = require('../config/clinic-info');
const {
  VIEWS, SECTION_VIEWS, ROLE_VIEWS, ROLE_DEFAULT_VIEW,
  viewForRole, allowedViews, canPreview, isStaffRole
} = require('../config/view-matrix');

// ---- local audit helper (mirrors the admin.js logAudit signature) ----
function auditGait(req, action, targetType, targetId, detail) {
  try {
    const admin = req.session.user || {};
    db.prepare(`
      INSERT INTO audit_logs (admin_id, admin_name, action, target_type, target_id, detail)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(req.userId || admin.id || null, admin.guardian_name || admin.username || '', action, targetType, targetId, detail);
  } catch (e) { /* logging must never break the action */ }
}

const router = express.Router();

// ---- clinic identity (letterhead on every gait report) ----
const LOGO_PATH = path.join(__dirname, '..', 'public', 'images', 'logo.png');

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads', 'gait');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const RESOLVED_UPLOAD_DIR = path.resolve(UPLOAD_DIR);

// Real computer-vision artifacts (overlay videos + graphs) live per session under
// uploads/gait/artifacts/<sessionId>/ and are served back to the client.
const ARTIFACTS_ROOT = path.join(__dirname, '..', 'uploads', 'gait', 'artifacts');
if (!fs.existsSync(ARTIFACTS_ROOT)) fs.mkdirSync(ARTIFACTS_ROOT, { recursive: true });
const RESOLVED_ARTIFACTS_ROOT = path.resolve(ARTIFACTS_ROOT);

const VIDEO_EXTENSIONS = /\.(mp4|mov|webm|avi|mkv|m4v)$/i;
const MAX_VIDEO_BYTES = 200 * 1024 * 1024;

// Live analysis progress (sessionId -> { pct, phase, startedAt, state }).
// Populated from the Python child's PROGRESS:<pct> <phase> stdout lines so the
// frontend can show active loading feedback while frames are processed on CPU.
const analyzeProgress = new Map();

// Deep validation — sniff the saved file's container signature (magic bytes) so
// that renamed non-video files are rejected even when MIME/extension pass.
function sniffVideoContainer(absPath) {
  let fd;
  try {
    fd = fs.openSync(absPath, 'r');
    const header = Buffer.alloc(16);
    const n = fs.readSync(fd, header, 0, header.length, 0);
    const h = header.subarray(0, n);
    if (n >= 12 && h.subarray(4, 8).toString('ascii') === 'ftyp') return 'mp4/mov';
    if (n >= 4 && h.subarray(0, 4).equals(Buffer.from([0x1A, 0x45, 0xDF, 0xA3]))) return 'webm/mkv';
    if (n >= 12 && h.subarray(0, 4).toString('ascii') === 'RIFF' && h.subarray(8, 12).toString('ascii') === 'AVI ') return 'avi';
    return null;
  } catch (e) {
    return null;
  } finally {
    if (fd) { try { fs.closeSync(fd); } catch (e) { /* noop */ } }
  }
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = (path.extname(file.originalname) || '.mp4').toLowerCase();
    cb(null, `session-${req.params.id}-${file.fieldname}-${Date.now()}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_VIDEO_BYTES, files: 4 },
  fileFilter: (req, file, cb) => {
    const mimeOk = String(file.mimetype || '').startsWith('video/');
    const extOk = VIDEO_EXTENSIONS.test(file.originalname || '');
    cb(mimeOk || extOk ? null : new Error('Only video files (MP4, MOV, WebM, AVI) are allowed.'), true);
  }
});

const SESSION_FIELDS = 'id, user_id, status, frontal_video, sagittal_video, frontal_name, sagittal_name, combined_video, combined_name, third_video, third_name, notes, speed_hint, height_cm, age_years, gender, body_mass_kg, clinician_name, results, analyzer_meta, review_note, reviewed_by, reviewed_at, created_at, updated_at';

function serialize(row, includeResults = false) {
  const s = { ...row };
  if (row.results) {
    s.results = includeResults ? safeJson(row.results) : null;
  } else {
    s.results = null;
  }
  s.analyzerMeta = row.analyzer_meta ? safeJson(row.analyzer_meta) : null;
  delete s.analyzer_meta;
  delete s.results_raw;
  return s;
}

function safeJson(text) {
  try { return JSON.parse(text); } catch (e) { return null; }
}

function relUploadPath(absPath) {
  return path.relative(path.join(__dirname, '..'), absPath).replace(/\\/g, '/');
}

// Serve a local file with HTTP Range (206) support so HTML5 <video> playback
// and seeking work reliably in every browser. Fails 416 on an invalid range.
function sendFileWithRange(req, res, abs, type, disposition) {
  const stat = fs.statSync(abs);
  const total = stat.size;
  let start = 0;
  let end = total - 1;
  let status = 200;
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
    if (m) {
      const s = m[1] === '' ? null : parseInt(m[1], 10);
      const e = m[2] === '' ? null : parseInt(m[2], 10);
      if (s !== null && Number.isFinite(s) && s >= 0 && s < total) {
        start = s;
        end = e !== null && Number.isFinite(e) && e < total ? e : total - 1;
        if (start > end) {
          res.setHeader('Content-Range', `bytes */${total}`);
          return res.status(416).end();
        }
        status = 206;
        res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
      }
    }
  }
  res.status(status);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Length', end - start + 1);
  res.setHeader('Content-Disposition', disposition);
  fs.createReadStream(abs, { start, end }).pipe(res);
}

// Normalize analyzer temp suffixes so artifact references always stay a clean
// single-extension path (e.g. sagittal_overlay.mp4.h264.tmp.mp4 -> sagittal_overlay.mp4).
function cleanArtifactBase(s) {
  return String(s || '')
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    .replace(/\.(h264\.tmp|tmp|part|download)(\.mp4)?$/i, '');
}

function resolveUploadRel(relPath) {
  if (!relPath) return null;
  const abs = path.resolve(path.join(__dirname, '..', relPath));
  if (!abs.startsWith(RESOLVED_UPLOAD_DIR + path.sep)) return null;
  return fs.existsSync(abs) ? abs : null;
}

// Convert absolute artifact paths (overlay videos / graphs written by the CV
// engine) into web-servable relative paths under uploads/gait/artifacts/<id>.
// Temp re-encode suffixes are normalized to a single .mp4 extension so the
// stored reference always points at the final, playable file.
function relArtifact(artifactsRelDir, v) {
  if (!v) return null;
  return `${artifactsRelDir}/${cleanArtifactBase(v)}`;
}

function remapArtifacts(cv, artifactsRelDir) {
  if (!cv || typeof cv !== 'object') return cv;
  if (cv.artifacts_abs) delete cv.artifacts_abs;
  ['sagittal', 'frontal'].forEach(plane => {
    const block = cv[plane];
    if (block && typeof block === 'object') {
      if (block.overlay_video) block.overlay_video = relArtifact(artifactsRelDir, block.overlay_video);
      if (block.plots && typeof block.plots === 'object') {
        Object.keys(block.plots).forEach(k => {
          if (block.plots[k]) block.plots[k] = relArtifact(artifactsRelDir, block.plots[k]);
        });
      }
    }
  });
  return cv;
}

// ---- authorization helpers ----
function loadSession(req, res) {
  const id = parseInt(req.params.id, 10) || parseInt(req.params.sessionId, 10) || 0;
  const row = db.prepare(`SELECT ${SESSION_FIELDS} FROM gait_sessions WHERE id = ?`).get(id);
  if (!row) { res.status(404).json({ error: 'Gait session not found.' }); return null; }
  return row;
}

function roleOf(req) {
  if (req.session && req.session.user && req.session.user.role) return req.session.user.role;
  const user = db.prepare('SELECT role FROM users WHERE id = ?').get(req.userId);
  return user ? user.role : null;
}

function canAccess(req, row) {
  if (row.user_id === req.userId) return true;
  const r = roleOf(req);
  return r === 'admin' || r === 'super_admin';
}

// Read access is broader than mutation access: clinicians (read-only staff) may
// open any patient's session, its videos, artifacts, raw JSON and reports, but
// never create/edit/delete/analyze a session they do not own (those routes keep
// the stricter canAccess / requireAdmin checks).
function canRead(req, row) {
  if (row.user_id === req.userId) return true;
  return !!isStaffRole(roleOf(req));
}

// ---- Python analyzer plumbing ----
// Determines a real Python interpreter. On Windows, `python`/`python3` can be
// Microsoft-Store alias stubs that print a warning to stderr but exit 0 without
// running anything, so we validate BOTH the exit code AND that the probe actually
// produced the expected `1` on stdout. The `py` launcher (preferred) reliably
// targets the installed CPython regardless of PATH ordering.
function probePython(bin) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let timer;
    let r;
    try {
      const [pcmd, ...pre] = bin.split(/\s+/);
      r = spawn(pcmd, [...pre, '-c', 'print(1)'], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      console.error(`[GAIT-LAB] python candidate "${bin}" spawn threw: ${e.message}`);
      return resolve(null);
    }
    const done = (selected) => { clearTimeout(timer); resolve(selected); };
    timer = setTimeout(() => { try { r.kill(); } catch (e) { /* noop */ } done(null); }, 6000);
    r.stdout.on('data', d => { out += d; });
    r.stderr.on('data', d => { err += d; });
    r.on('error', e => { console.error(`[GAIT-LAB] python candidate "${bin}" error: ${e.message}`); done(null); });
    r.on('close', code => {
      const ok = code === 0 && String(out).trim() === '1';
      if (ok) {
        console.error(`[GAIT-LAB] python selected: "${bin}" (exit ${code})`);
        done(bin);
      } else {
        console.error(`[GAIT-LAB] python candidate "${bin}" rejected: exit=${code} out=${JSON.stringify(String(out).slice(0, 80))} err=${JSON.stringify(String(err).slice(0, 120))}`);
        done(null);
      }
    });
  });
}

async function findPython() {
  const candidates = process.env.GAIT_PYTHON ? [process.env.GAIT_PYTHON] : ['py', 'py -3', 'python', 'python3'];
  for (const bin of candidates) {
    const selected = await probePython(bin);
    if (selected) return selected;
  }
  console.error('[GAIT-LAB] no usable python interpreter found');
  return null;
}

let PYTHON_PROMISE = null;
function pythonBin() {
  if (!PYTHON_PROMISE) PYTHON_PROMISE = findPython();
  return PYTHON_PROMISE;
}

// ---- analyze pipeline (2e.txt: real CV only; no demo fallback) ----

async function runAnalyzer(session) {
  const bin = await pythonBin();
  console.error(`[GAIT-LAB] runAnalyzer session=${session.id} pythonBin=${bin}`);
  const outFile = path.join(UPLOAD_DIR, `analysis-${session.id}.json`);
  const patientName = db.prepare('SELECT child_name FROM users WHERE id = ?').get(session.user_id)?.child_name || '';

  // 2e.txt — strict fail-safe: there is NO demo / simulated fallback. If the real
  // Python CV engine is unavailable the request errors; the platform never stores
  // or displays fabricated metrics.
  if (!bin) {
    throw new Error('The real computer-vision analysis engine is unavailable on this server. No results can be generated.');
  }

  // Real computer-vision path (MediaPipe pose, frontal + sagittal planes).
    const labPath = path.join(__dirname, '..', 'python', 'gait_lab.py');
    const artifactsRelDir = `uploads/gait/artifacts/${session.id}`;
    const artifactsAbsDir = path.join(__dirname, '..', artifactsRelDir);
    if (!fs.existsSync(artifactsAbsDir)) fs.mkdirSync(artifactsAbsDir, { recursive: true });

    const resolveVideo = rel => {
      if (!rel) return 'none';
      const abs = resolveUploadRel(rel);
      return abs || rel;
    };

    // IMPORTANT: the script path MUST be the first positional argument, otherwise the
    // interpreter (py/python) treats "--session" as its own option and exits instantly.
    const args = [labPath, '--session', String(session.id), '--patient', patientName,
      '--frontal', resolveVideo(session.frontal_video), '--sagittal', resolveVideo(session.sagittal_video),
      '--combined', resolveVideo(session.combined_video), '--third', resolveVideo(session.third_video),
      '--artifacts', artifactsAbsDir, '--out', outFile,
    '--height-cm', String(session.height_cm ?? ''),
    '--speed-hint', String(session.speed_hint || 'auto')];

    // Phase D — pass pediatric norms + GMFCS context through to the engine.
    // GMFCS comes from the latest stored clinical record (zero-assumption:
    // when absent the flag is omitted entirely and the report says nothing).
    if (session.age_years != null) args.push('--age-years', String(session.age_years));
    if (session.gender) args.push('--gender', String(session.gender));
    try {
      const gmfcsRow = db.prepare(
        "SELECT payload FROM clinical_scales WHERE user_id = ? AND scale_type = 'gmfcs' AND status IN ('assessed','reviewed') ORDER BY created_at DESC LIMIT 1"
      ).get(session.user_id);
      if (gmfcsRow && gmfcsRow.payload) {
        const gp = JSON.parse(gmfcsRow.payload);
        if (gp && gp.level) {
          args.push('--context', JSON.stringify({
            gmfcs: { level: gp.level, age_label: gp.age_label || null,
                     reported_via: gp.reported_via || null,
                     source: 'clinical_scales record (Palisano 1997/2007, CanChild McMaster)' },
          }));
        }
      }
    } catch (e) { /* context is optional; never block analysis on it */ }

    // Long timeout: real pose estimation is compute heavy (MediaPipe on CPU +
    // overlay video encoding + matplotlib graphs). Default 45 min; overridable
    // via GAIT_ANALYZER_TIMEOUT env var.
    const timeoutMs = Number(process.env.GAIT_ANALYZER_TIMEOUT || 45 * 60 * 1000);

    // Reset + publish live progress for this session.
    const prog = { pct: 0, phase: 'Queued', state: 'running', startedAt: Date.now(), error: null };
    analyzeProgress.set(String(session.id), prog);

    // Run with cwd = python dir so `import gait_analyzer` resolves reliably
    // regardless of how the server process was launched.
    const pythonDir = path.join(__dirname, '..', 'python');
    console.error(`[GAIT-LAB] spawning "${bin}" cwd=${pythonDir} args=${JSON.stringify(args)}`);

    try {
      await new Promise((resolve, reject) => {
        // Expose the bundled ffmpeg (H.264 encoder) to the analyzer so it can
        // re-encode the OpenCV overlay videos into a device-compatible format.
        const ffmpegBin = (function () {
          try { return require('ffmpeg-static'); } catch (e) { return null; }
        })();
        const child = spawn(bin, args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          cwd: pythonDir,
          env: { ...process.env, ...(ffmpegBin ? { FFMPEG_BIN: ffmpegBin } : {}) },
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', d => {
          const chunk = String(d);
          stdout += chunk;
          // Parse machine-readable progress lines: PROGRESS:<pct> <phase>
          chunk.split(/\r?\n/).forEach(line => {
            const m = line.match(/^PROGRESS:(\d{1,3})\s+(.+)$/);
            if (m) { prog.pct = Math.max(0, Math.min(100, parseInt(m[1], 10))); prog.phase = String(m[2]).slice(0, 120); }
          });
        });
        child.stderr.on('data', d => { stderr += d; });
        const timer = setTimeout(() => {
          try { child.kill(); } catch (e) { /* noop */ }
          prog.state = 'error'; prog.error = 'Analysis timed out after ' + Math.round(timeoutMs / 60000) + ' min.';
          reject(new Error('Analyzer timed out.'));
        }, timeoutMs);
        child.on('error', err => { clearTimeout(timer); prog.state = 'error'; prog.error = err.message; reject(err); });
        child.on('close', code => {
          clearTimeout(timer);
          if (code === 0 && fs.existsSync(outFile)) { prog.state = 'done'; prog.pct = 100; resolve(String(stdout).trim()); }
          else {
            prog.state = 'error'; prog.error = `Analyzer exited with code ${code}`;
            reject(new Error(`Analyzer exited with code ${code}\n--stderr--\n${String(stderr).slice(0, 1500)}\n--stdout--\n${String(stdout).slice(0, 800)}\n--outfile-exists=${fs.existsSync(outFile)}`));
          }
        });
      });
      prog.state = 'done';
      prog.pct = 100;
      const results = JSON.parse(fs.readFileSync(outFile, 'utf-8'));
      // Remap absolute artifact paths to web-servable relative paths so the client
      // (and PDF/DOCX) can reference the overlay videos + graphs (incl. 3D plots).
      results.cv = remapArtifacts(results.cv, artifactsRelDir);
      if (results.cv3d && results.cv3d.plots && typeof results.cv3d.plots === 'object') {
        Object.keys(results.cv3d.plots).forEach(k => {
          if (results.cv3d.plots[k]) results.cv3d.plots[k] = relArtifact(artifactsRelDir, results.cv3d.plots[k]);
        });
      }
      if (results.cv3d && results.cv3d.overlay_video) {
        results.cv3d.overlay_video = relArtifact(artifactsRelDir, results.cv3d.overlay_video);
      }
      return { results, meta: { engine: 'python-cv', version: results.version || '1.0.0', mode: results.mode || 'video', generatedAt: results.generated_at || new Date().toISOString() } };
    } catch (err) {
      console.error('[GAIT-LAB] python-cv path failed:', err && err.message ? err.message : err);
      prog.state = 'error'; prog.error = (err && err.message) || 'Python CV failed';
      // 2e.txt — always fail closed: a failed analysis NEVER falls back to
      // demo/simulated numbers. Throw so the route returns 500 and stores nothing.
      throw err;
    }
}

// ===========================================================================
// On-demand OCR (run.txt §1) — name overlay verification AT REPORT EXPORT ONLY
// ===========================================================================
// OCR is deliberately excluded from video analysis. When the clinician clicks
// "Export PDF" or "Export Word", overlay_ocr.py is spawned to read the
// patient-name overlay from the stored recordings and verify it against the
// patient record. The result is returned to the report builder in-memory and is
// never persisted into the stored analysis results.

const OCR_SCRIPT = path.join(__dirname, '..', 'python', 'overlay_ocr.py');
const OCR_TIMEOUT_MS = Number(process.env.GAIT_OCR_TIMEOUT || 5 * 60 * 1000);

function ocrUnavailable(reason, expectedName) {
  return {
    status: 'ocr_unavailable',
    unverified_name_metadata: true,
    flag: 'Unverified Name Metadata',
    source: 'video-overlay-ocr',
    engine: 'none',
    frames_scanned: 0,
    texts_seen: [],
    cleaned_text: null,
    expected_name: expectedName || '',
    matched_name: null,
    confidence: 0,
    reason: reason || 'The video-overlay OCR could not be run on this server. Name metadata is UNVERIFIED.'
  };
}

async function runOcrAtExport(row) {
  const videos = [row.sagittal_video, row.frontal_video, row.combined_video]
    .map(resolveUploadRel)
    .filter(Boolean);
  const patientName = db.prepare('SELECT child_name FROM users WHERE id = ?').get(row.user_id)?.child_name || '';
  if (!videos.length) {
    return ocrUnavailable('No recorded walk videos are available for this session, so the video-overlay name could not be read by OCR.', patientName);
  }

  const bin = await pythonBin();
  if (!bin) {
    return ocrUnavailable('The Python OCR engine is unavailable on this server, so the video-overlay name could not be read. Name metadata is UNVERIFIED.', patientName);
  }

  const outFile = path.join(UPLOAD_DIR, `ocr-${row.id}-${Date.now()}.json`);
  const pythonDir = path.join(__dirname, '..', 'python');
  const [pcmd, ...pre] = bin.split(/\s+/);
  const args = [...pre, OCR_SCRIPT, '--videos', ...videos, '--expected', patientName, '--out', outFile];

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(pcmd, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd: pythonDir });
    } catch (e) {
      console.error(`[GAIT-LAB] OCR spawn error: ${e.message}`);
      resolve(ocrUnavailable(`OCR could not be started (${e.message}). Name metadata is UNVERIFIED.`, patientName));
      return;
    }
    let errOut = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch (e) { /* noop */ }
      resolve(ocrUnavailable('OCR timed out while reading the video overlay. Name metadata is UNVERIFIED.', patientName));
    }, OCR_TIMEOUT_MS);
    child.stderr.on('data', d => { errOut += d; });
    child.on('error', err => {
      clearTimeout(timer);
      console.error(`[GAIT-LAB] OCR process error: ${err.message}`);
      resolve(ocrUnavailable(`OCR process error (${err.message}). Name metadata is UNVERIFIED.`, patientName));
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) {
        console.error(`[GAIT-LAB] OCR exited ${code}: ${errOut}`);
        resolve(ocrUnavailable('The video-overlay OCR did not complete successfully. Name metadata is UNVERIFIED.', patientName));
        return;
      }
      try {
        const meta = safeJson(fs.readFileSync(outFile, 'utf-8'));
        resolve(meta && meta.status ? meta : ocrUnavailable('The video-overlay OCR returned no usable result. Name metadata is UNVERIFIED.', patientName));
      } catch (e) {
        resolve(ocrUnavailable('The video-overlay OCR output could not be read. Name metadata is UNVERIFIED.', patientName));
      } finally {
        try { fs.unlinkSync(outFile); } catch (e) { /* noop */ }
      }
    });
  });
}

// ===========================================================================
// Patient routes (any authenticated user)
// ===========================================================================

// Role/view configuration consumed by the gait page renderer (B1).
router.get('/view-matrix', requireAuth, (req, res) => {
  const role = roleOf(req) || 'patient';
  res.json({
    views: VIEWS,
    sectionViews: SECTION_VIEWS,
    roleViews: ROLE_VIEWS,
    roleDefault: ROLE_DEFAULT_VIEW,
    user: { role, allowedViews: allowedViews(role), defaultView: viewForRole(role), canPreview: canPreview(role) }
  });
});

// Create a session (collection placeholder before upload).
function normalizeHeightCm(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  return (Number.isFinite(n) && n >= 50 && n <= 260) ? n : null;
}
function normalizeAge(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  return (Number.isFinite(n) && n >= 0 && n <= 120) ? n : null;
}
function normalizeBodyMass(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  return (Number.isFinite(n) && n >= 1 && n <= 500) ? n : null;
}
function normalizeGender(raw) {
  if (!raw) return null;
  const s = String(raw).trim().toLowerCase();
  const allowed = ['male', 'female', 'other', 'unspecified'];
  return allowed.includes(s) ? s : null;
}

router.post('/sessions', requireAuth, (req, res) => {
  const notes = String(req.body.notes || '').trim().slice(0, 2000);
  const speedHint = String(req.body.speedHint || 'auto').trim().toLowerCase();
  const allowedHints = ['auto', 'normal', 'running', 'slowmo_120', 'slowmo_240'];
  const hint = allowedHints.includes(speedHint) ? speedHint : 'auto';
  const heightCm = normalizeHeightCm(req.body.heightCm);
  const ageYears = normalizeAge(req.body.ageYears);
  const gender = normalizeGender(req.body.gender);
  const bodyMassKg = normalizeBodyMass(req.body.bodyMassKg);
  const clinicianName = String(req.body.clinicianName || '').trim().slice(0, 200) || null;
  const result = db.prepare(
    "INSERT INTO gait_sessions (user_id, notes, speed_hint, height_cm, age_years, gender, body_mass_kg, clinician_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(req.userId, notes, hint, heightCm, ageYears, gender, bodyMassKg, clinicianName);
  res.status(201).json({ success: true, id: result.lastInsertRowid, message: 'Gait session created. Upload your videos.' });
});

// Update select session fields (playback speed hint, physician height). Analysis
// re-runs on the next analyze request, so no analyzer is invoked here.
router.patch('/sessions/:id', requireAuth, (req, res) => {
  const row = loadSession(req, res);
  if (!row) return;
  if (!canAccess(req, row)) return res.status(403).json({ error: 'Not your session.' });

  const allowedHints = ['auto', 'normal', 'running', 'slowmo_120', 'slowmo_240'];
  const sets = [];
  const values = [];
  let newHint = row.speed_hint;
  let newHeight = row.height_cm;
  let newAge = row.age_years;
  let newGender = row.gender;
  let newBodyMass = row.body_mass_kg;
  let newClinician = row.clinician_name;

  const supportedFields = ['speedHint', 'heightCm', 'ageYears', 'gender', 'bodyMassKg', 'clinicianName'];

  if ('speedHint' in req.body) {
    const speedHint = String(req.body.speedHint || '').trim().toLowerCase();
    if (!allowedHints.includes(speedHint)) {
      return res.status(400).json({ error: `speedHint must be one of: ${allowedHints.join(', ')}.` });
    }
    sets.push('speed_hint = ?');
    values.push(speedHint);
    newHint = speedHint;
  }

  if ('heightCm' in req.body) {
    if (req.body.heightCm === null || req.body.heightCm === '') {
      sets.push('height_cm = ?');
      values.push(null);
      newHeight = null;
    } else {
      const hc = normalizeHeightCm(req.body.heightCm);
      if (hc === null) {
        return res.status(400).json({ error: 'heightCm must be a number between 50 and 260 cm, or empty.' });
      }
      sets.push('height_cm = ?');
      values.push(hc);
      newHeight = hc;
    }
  }

  if ('ageYears' in req.body) {
    if (req.body.ageYears === null || req.body.ageYears === '') {
      sets.push('age_years = ?');
      values.push(null);
      newAge = null;
    } else {
      const a = normalizeAge(req.body.ageYears);
      if (a === null) {
        return res.status(400).json({ error: 'ageYears must be a number between 0 and 120, or empty.' });
      }
      sets.push('age_years = ?');
      values.push(a);
      newAge = a;
    }
  }

  if ('gender' in req.body) {
    const g = normalizeGender(req.body.gender);
    sets.push('gender = ?');
    values.push(g);
    newGender = g;
  }

  if ('bodyMassKg' in req.body) {
    if (req.body.bodyMassKg === null || req.body.bodyMassKg === '') {
      sets.push('body_mass_kg = ?');
      values.push(null);
      newBodyMass = null;
    } else {
      const bm = normalizeBodyMass(req.body.bodyMassKg);
      if (bm === null) {
        return res.status(400).json({ error: 'bodyMassKg must be a number between 1 and 500 kg, or empty.' });
      }
      sets.push('body_mass_kg = ?');
      values.push(bm);
      newBodyMass = bm;
    }
  }

  if ('clinicianName' in req.body) {
    const cn = String(req.body.clinicianName || '').trim().slice(0, 200) || null;
    sets.push('clinician_name = ?');
    values.push(cn);
    newClinician = cn;
  }

  if (sets.length === 0) {
    return res.status(400).json({ error: 'No supported field provided. Try speedHint, heightCm, ageYears, gender, bodyMassKg, or clinicianName.' });
  }
  const unsupported = Object.keys(req.body || {}).filter(k => !supportedFields.includes(k));
  if (unsupported.length) {
    return res.status(400).json({ error: 'Unsupported field(s): ' + unsupported.join(', ') });
  }

  values.push(row.id);
  db.prepare(`UPDATE gait_sessions SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  res.json({ success: true, id: row.id, speed_hint: newHint, height_cm: newHeight, age_years: newAge, gender: newGender, body_mass_kg: newBodyMass, clinician_name: newClinician, message: 'Gait session updated.' });
});

// 3e.txt — capture-mode conflict + plane-orientation messages (exact wording).
const COMBINED_CONFLICT_MSG = 'Only one mode can be selected. Please either provide separate Frontal and Sagittal videos or use the Combined Dual-Plane video option, but not both.';
const WRONG_FRONTAL_SLOT_MSG = 'The uploaded video appears to be a sagittal plane recording. Please browse and upload the correct frontal plane video.';
const WRONG_SAGGITTAL_SLOT_MSG = 'The uploaded video appears to be a frontal plane recording. Please browse and upload the correct sagittal plane video.';
// 2e.txt — professional rejection message for recordings that carry no genuine
// walking (gait) pattern. Must match python/gait_validity.py NO_VALID_GAIT_MSG.
const NO_GENUINE_GAIT_MSG = 'The uploaded video does not contain a recognizable walking (gait) pattern. Please upload a clear video of the patient walking straight in the specified plane to proceed with the clinical analysis.';

function classifyPlane(videoAbsPath, slot, { skipValidity = false } = {}) {
  // Runs the lightweight plane-orientation probe (+ optionally the 2e.txt gait-validity screen).
  // skipValidity=true during upload: only checks plane orientation (~10 MediaPipe frames,
  // ~2-5s). The full gait-validity screen (200 frames) runs during gait_lab.py analysis.
  // Returns {detected, frontal_ratio, samples, gait_validation} or null on ANY soft
  // failure (interpreter missing, timeout, parse error). The upload gate treats null
  // as FAIL-CLOSED: it cannot certify a walking pattern, so the clip is rejected.
  return new Promise(resolve => {
    (async () => {
      try {
        const bin = await pythonBin();
        if (!bin) return resolve(null);
        const cPath = path.join(__dirname, '..', 'python', 'classify_plane.py');
        const pythonDir = path.join(__dirname, '..', 'python');
        const args = [cPath, '--video', videoAbsPath, '--slot', slot];
        if (skipValidity) args.push('--skip-validity');
        const child = spawn(bin, args,
          { stdio: ['ignore', 'pipe', 'pipe'], cwd: pythonDir });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', d => { stdout += String(d); });
        child.stderr.on('data', d => { stderr += String(d); });
        // Upload-time: 30s (quick plane check only); analysis-time: 120s (full validity)
        const timeoutMs = skipValidity ? 30 * 1000 : 120 * 1000;
        const timer = setTimeout(() => { try { child.kill(); } catch (e) { /* noop */ } resolve(null); }, timeoutMs);
        child.on('error', () => { clearTimeout(timer); resolve(null); });
        child.on('close', code => {
          clearTimeout(timer);
          if (code !== 0) return resolve(null);
          try {
            const lastJson = String(stdout).split(/\r?\n/).filter(l => l.trim().startsWith('{')).pop() || '{}';
            const parsed = JSON.parse(lastJson.trim());
            if (parsed.ok === false) return resolve(null);
            resolve({
              detected: parsed.detected || null,
              frontal_ratio: parsed.frontal_ratio,
              samples: parsed.samples,
              gait_validation: parsed.gait_validation || null
            });
          } catch (e) {
            resolve(null);
          }
        });
      } catch (e) {
        resolve(null);
      }
    })();
  });
}

// Upload gait-plane videos. One or both views may be supplied; a plane that is
// already uploaded is replaced by the new file, and a missing plane is left as-is,
// so a session can be created first and its sagittal/frontal clips added later.
router.post('/sessions/:id/videos', requireAuth, (req, res) => {
  const row = loadSession(req, res);
  if (!row) return;
  if (!canAccess(req, row)) return res.status(403).json({ error: 'Not your session.' });

  upload.fields([
    { name: 'frontal', maxCount: 1 },
    { name: 'sagittal', maxCount: 1 },
    { name: 'combined', maxCount: 1 },
    { name: 'third', maxCount: 1 }
  ])(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Upload failed.' });

    const files = req.files || {};
    const frontal = files.frontal && files.frontal[0];
    const sagittal = files.sagittal && files.sagittal[0];
    const combined = files.combined && files.combined[0];
    const third = files.third && files.third[0];

    const cleanUp = () => {
      [frontal, sagittal, combined, third].forEach(f => {
        if (f) { try { fs.unlinkSync(f.path); } catch (e) { /* noop */ } }
      });
    };

    if (!frontal && !sagittal && !combined && !third) {
      return res.status(400).json({ error: 'Please attach at least one video (Frontal, Sagittal, Combined Dual-Plane, or Coronal/Third Plane).' });
    }

    // 3e.txt — mutual exclusion: the combined dual-plane capture is mutually
    // exclusive with separate Frontal/Sagittal uploads. The third (Coronal)
    // plane is an additional camera view and may accompany any mode.
    const existingFrontalSagittal = Boolean(row.frontal_video || row.sagittal_video);
    const incomingFrontalSagittal = Boolean(frontal || sagittal);
    if ((combined && (incomingFrontalSagittal || existingFrontalSagittal)) || (incomingFrontalSagittal && row.combined_video)) {
      cleanUp();
      return res.status(400).json({ error: COMBINED_CONFLICT_MSG });
    }

    // Deep validation: confirm each uploaded file carries a real video container.
    const sniff = (plan, file) => {
      const detected = sniffVideoContainer(file.path);
      if (!detected) {
        cleanUp();
        res.status(400).json({ error: `The ${plan} file does not contain a recognizable video stream (container signature not detected). Please re-encode and upload again.` });
        return false;
      }
      return true;
    };
    if (frontal && !sniff('Frontal Plane', frontal)) return;
    if (sagittal && !sniff('Sagittal Plane', sagittal)) return;
    if (combined && !sniff('Combined Dual-Plane', combined)) return;
    if (third && !sniff('Coronal/Third Plane', third)) return;

    // 3e.txt — plane-orientation verification + 2e.txt gait-validity gate at upload
    // time. Fail-closed: a clip that cannot be screened, or that fails the walking
    // screen, is REJECTED with the exact 2e.txt message (never analyzed, never stored).
    const verifyPlane = async (file, slot, mismatchMsg) => {
      const cp = await classifyPlane(file.path, slot, { skipValidity: true });
      if (!cp || !cp.gait_validation || cp.gait_validation.status !== 'ok') {
        cleanUp();
        res.status(400).json({ error: (cp && cp.gait_validation && cp.gait_validation.message) || NO_GENUINE_GAIT_MSG });
        return false;
      }
      // Frontal/sagittal slot mismatch checks stay strict; the third (Coronal)
      // plane is an additional camera angle, so it only needs a valid gait screen.
      if (slot === 'frontal' || slot === 'sagittal') {
        const mismatch = cp && cp.detected && (slot === 'frontal' ? cp.detected === 'sagittal' : cp.detected === 'frontal');
        if (mismatch) {
          cleanUp();
          res.status(400).json({ error: mismatchMsg });
          return false;
        }
      }
      return true;
    };
    if (frontal && !(await verifyPlane(frontal, 'frontal', WRONG_FRONTAL_SLOT_MSG))) return;
    if (sagittal && !(await verifyPlane(sagittal, 'sagittal', WRONG_SAGGITTAL_SLOT_MSG))) return;
    if (combined && !(await verifyPlane(combined, 'sagittal', NO_GENUINE_GAIT_MSG))) return;
    if (third && !(await verifyPlane(third, 'third', NO_GENUINE_GAIT_MSG))) return;

    // Only remove the previously uploaded file for the plane(s) being replaced.
    if (frontal) {
      const abs = resolveUploadRel(row.frontal_video);
      if (abs) { try { fs.unlinkSync(abs); } catch (e) { /* noop */ } }
    }
    if (sagittal) {
      const abs = resolveUploadRel(row.sagittal_video);
      if (abs) { try { fs.unlinkSync(abs); } catch (e) { /* noop */ } }
    }
    if (third) {
      const abs = resolveUploadRel(row.third_video);
      if (abs) { try { fs.unlinkSync(abs); } catch (e) { /* noop */ } }
    }

    const newFrontal = frontal ? relUploadPath(frontal.path) : row.frontal_video;
    const newSagittal = sagittal ? relUploadPath(sagittal.path) : row.sagittal_video;
    const newFrontalName = frontal ? String(frontal.originalname).slice(0, 255) : row.frontal_name;
    const newSagittalName = sagittal ? String(sagittal.originalname).slice(0, 255) : row.sagittal_name;

    const newCombined = combined ? relUploadPath(combined.path) : row.combined_video;
    const newCombinedName = combined ? String(combined.originalname).slice(0, 255) : row.combined_name;

    const newThird = third ? relUploadPath(third.path) : row.third_video;
    const newThirdName = third ? String(third.originalname).slice(0, 255) : row.third_name;

    db.prepare(`
      UPDATE gait_sessions
      SET frontal_video = ?, sagittal_video = ?, frontal_name = ?, sagittal_name = ?,
          combined_video = ?, combined_name = ?,
          third_video = ?, third_name = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(newFrontal, newSagittal, newFrontalName, newSagittalName, newCombined, newCombinedName, newThird, newThirdName, row.id);

    const planes = [
      combined ? 'Combined dual-plane' : null,
      frontal ? 'Frontal' : null,
      sagittal ? 'Sagittal' : null,
      third ? 'Coronal/Third' : null
    ].filter(Boolean).join(' + ');
    res.json({ success: true, message: `${planes} video(s) uploaded. Run analysis to generate the report.` });
  });
});

// Run the analysis pipeline.
router.post('/sessions/:id/analyze', requireAuth, async (req, res) => {
  const row = loadSession(req, res);
  if (!row) return;
  if (!canAccess(req, row)) return res.status(403).json({ error: 'Not your session.' });
  if (!row.frontal_video && !row.sagittal_video && !row.combined_video && !row.third_video) {
    return res.status(400).json({ error: 'Upload at least one video (Frontal, Sagittal, Combined Dual-Plane, or Coronal/Third Plane) before analyzing.' });
  }

  try {
    const { results, meta } = await runAnalyzer(row);
    db.prepare(`
      UPDATE gait_sessions
      SET results = ?, analyzer_meta = ?, status = 'analyzed', updated_at = datetime('now')
      WHERE id = ?
    `).run(JSON.stringify(results), JSON.stringify(meta), row.id);
    res.json({ success: true, message: 'Analysis complete.', mode: results.mode, engine: meta.engine });
  } catch (err) {
    res.status(500).json({ error: `Analysis failed: ${err.message}` });
  }
});

// Live progress of an in-flight analysis (owner or staff).
router.get('/sessions/:id/analyze-progress', requireAuth, (req, res) => {
  const row = loadSession(req, res);
  if (!row) return;
  if (!canRead(req, row)) return res.status(403).json({ error: 'Not your session.' });
  const p = analyzeProgress.get(String(row.id));
  if (!p) return res.json({ running: false });
  res.json({
    running: p.state === 'running',
    pct: p.pct,
    phase: p.phase,
    error: p.error,
    startedAt: p.startedAt,
    state: p.state
  });
});

// List own sessions (no results payload in the list).
router.get('/sessions', requireAuth, (req, res) => {
  const rows = db.prepare(
    `SELECT ${SESSION_FIELDS} FROM gait_sessions WHERE user_id = ? ORDER BY created_at DESC`
  ).all(req.userId);
  res.json({ sessions: rows.map(r => serialize(r, false)) });
});

// Session detail incl. parsed results.
router.get('/sessions/:id', requireAuth, (req, res) => {
  const row = loadSession(req, res);
  if (!row) return;
  if (!canRead(req, row)) return res.status(403).json({ error: 'Not your session.' });
  res.json({ session: serialize(row, true) });
});

// A patient's chronological series of analyzed sessions (V3 progression view).
router.get('/sessions/:id/progression', requireAuth, (req, res) => {
  const row = loadSession(req, res);
  if (!row) return;
  if (!canRead(req, row)) return res.status(403).json({ error: 'Not your session.' });

  const rows = db.prepare(
    `SELECT ${SESSION_FIELDS} FROM gait_sessions
     WHERE user_id = ? AND status IN ('analyzed','reviewed')
     ORDER BY created_at ASC LIMIT 20`
  ).all(row.user_id);

  const points = rows.map(r2 => {
    const rs = safeJson(r2.results) || {};
    const cycle = rs.cycle || {};
    const sag = rs.cv && rs.cv.sagittal;
    const fro = rs.cv && rs.cv.frontal;
    const romL = sag && sag.rom ? sag.rom.L || {} : {};
    const romR = sag && sag.rom ? sag.rom.R || {} : {};
    const c3sym = rs.cv3d && rs.cv3d.symmetry ? rs.cv3d.symmetry : {};
    return {
      id: r2.id,
      created_at: r2.created_at,
      status: r2.status,
      stance_pct: typeof cycle.stance_pct === 'number' ? cycle.stance_pct : null,
      swing_pct: typeof cycle.swing_pct === 'number' ? cycle.swing_pct : null,
      cadence: typeof cycle.cadence_cycles_per_second === 'number' ? cycle.cadence_cycles_per_second : null,
      cycle_seconds: typeof cycle.cycle_seconds === 'number' ? cycle.cycle_seconds : null,
      stride_symmetry: sag && sag.stride_symmetry != null ? sag.stride_symmetry : null,
      knee_flex_si: sag && sag.specific && sag.specific.knee_flex_si != null ? sag.specific.knee_flex_si : null,
      coronal_load_symmetry: fro && fro.metrics && fro.metrics.coronal_load && fro.metrics.coronal_load.symmetry_pct != null ? fro.metrics.coronal_load.symmetry_pct : null,
      knee_max_L: romL.knee_max != null ? romL.knee_max : null,
      knee_max_R: romR.knee_max != null ? romR.knee_max : null,
      hip_max_L: romL.hip_peak != null ? romL.hip_peak : null,
      hip_max_R: romR.hip_peak != null ? romR.hip_peak : null,
      cv3d_knee_si: c3sym.knee_flex_si != null ? c3sym.knee_flex_si : null,
    };
  });

  res.json({ session_id: row.id, points });
});

// Preview a stored walk video (owner or staff).
router.get('/sessions/:id/video/:plane', requireAuth, (req, res) => {
  if (req.params.plane !== 'frontal' && req.params.plane !== 'sagittal' && req.params.plane !== 'combined' && req.params.plane !== 'third') {
    return res.status(400).json({ error: 'Plane must be frontal, sagittal, combined, or third.' });
  }
  const row = loadSession(req, res);
  if (!row) return;
  if (!canRead(req, row)) return res.status(403).json({ error: 'Not your session.' });
  const abs = resolveUploadRel(row[`${req.params.plane}_video`]);
  if (!abs) return res.status(404).json({ error: 'Video not found.' });
  try {
    sendFileWithRange(req, res, abs, 'video/mp4',
      `inline; filename="${encodeURIComponent(row[`${req.params.plane}_name`] || 'video.mp4')}"`);
  } catch (e) {
    res.status(500).json({ error: 'Video could not be read.' });
  }
});

// Delete a session + its videos.
router.delete('/sessions/:id', requireAuth, (req, res) => {
  const row = loadSession(req, res);
  if (!row) return;
  if (!canAccess(req, row)) return res.status(403).json({ error: 'Not your session.' });

  [row.frontal_video, row.sagittal_video, row.combined_video, row.third_video].forEach(p => {
    const abs = resolveUploadRel(p);
    if (abs) { try { fs.unlinkSync(abs); } catch (e) { /* noop */ } }
  });
  const analysisFile = path.join(UPLOAD_DIR, `analysis-${row.id}.json`);
  if (fs.existsSync(analysisFile)) { try { fs.unlinkSync(analysisFile); } catch (e) { /* noop */ } }
  const artifactDir = path.join(ARTIFACTS_ROOT, String(row.id));
  if (fs.existsSync(artifactDir)) { try { fs.rmSync(artifactDir, { recursive: true, force: true }); } catch (e) { /* noop */ } }

  db.prepare('DELETE FROM gait_sessions WHERE id = ?').run(row.id);
  res.json({ success: true, message: 'Gait session deleted.' });
});

// Serve generated artifacts (overlay videos + graphs) for an analyzed session.
// Pass ?download=1 to force the browser to save the file instead of displaying it.
// Any legacy analyzer temp suffix (e.g. .h264.tmp.mp4) is normalized back to a
// single .mp4 so playback and download always target the final clean file.
router.get('/sessions/:id/artifacts/:file', requireAuth, (req, res) => {
  const row = loadSession(req, res);
  if (!row) return;
  if (!canRead(req, row)) return res.status(403).json({ error: 'Not your session.' });
  const name = cleanArtifactBase(String(req.params.file));
  const m = /^(.+)\.(mp4|png|jpg|jpeg)$/i.exec(name);
  if (!m || !/^[\w\-\.\(\) ]+$/.test(m[1]) || m[1].includes('..')) {
    return res.status(400).json({ error: 'Invalid artifact name.' });
  }
  const ext = m[2].toLowerCase();
  const abs = path.join(ARTIFACTS_ROOT, String(row.id), name);
  if (!fs.existsSync(abs)) return res.status(404).json({ error: 'Artifact not found.' });
  const type = ext === 'mp4' ? 'video/mp4' : 'image/png';
  const disposition = req.query.download === '1' || req.query.download === 'true'
    ? `attachment; filename="${name}"`
    : `inline; filename="${name}"`;
  try {
    sendFileWithRange(req, res, abs, type, disposition);
  } catch (e) {
    res.status(500).json({ error: 'Artifact could not be read.' });
  }
});

// Download the raw analyzer JSON for a session (owner or staff).
router.get('/sessions/:id/results.json', requireAuth, (req, res) => {
  const row = loadSession(req, res);
  if (!row) return;
  if (!canRead(req, row)) return res.status(403).json({ error: 'Not your session.' });
  if (!row.results) return res.status(400).json({ error: 'No results for this session.' });
  const results = safeJson(row.results);
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="gait-results-${row.id}.json"`);
  res.send(JSON.stringify(results, null, 2));
});

// ===========================================================================
// Staff routes
// ===========================================================================

// Admin: list all sessions with status filter (read-only staff may view).
router.get('/admin/sessions', requireStaffView, (req, res) => {
  const { status } = req.query;
  let sql = `SELECT ${SESSION_FIELDS.replace('id,', 'gs.id,').replace('status,', 'gs.status,').replace('created_at,', 'gs.created_at,')}, u.guardian_name, u.child_name, u.username FROM gait_sessions gs JOIN users u ON u.id = gs.user_id`;
  const params = [];
  if (status && status !== 'all') {
    sql += ' WHERE gs.status = ?';
    params.push(status);
  }
  sql += ' ORDER BY gs.created_at DESC';
  res.json({ sessions: db.prepare(sql).all(...params).map(r => ({ ...serialize(r, false), guardian_name: r.guardian_name, child_name: r.child_name, username: r.username })) });
});

// Admin: review / approve a session with a clinical note (status -> reviewed).
router.patch('/admin/sessions/:id/review', requireAdmin, (req, res) => {
  const row = loadSession(req, res);
  if (!row) return;
  if (row.status !== 'analyzed') {
    return res.status(400).json({ error: 'Only analyzed sessions can be reviewed.' });
  }
  const note = String(req.body.reviewNote || '').trim().slice(0, 2000);
  const reviewer = db.prepare('SELECT guardian_name FROM users WHERE id = ?').get(req.userId)?.guardian_name || 'Staff';
  db.prepare(`
    UPDATE gait_sessions SET status = 'reviewed', review_note = ?, reviewed_by = ?, reviewed_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ?
  `).run(note, reviewer, row.id);
  auditGait(req, 'gait_review', 'gait', row.id, `Reviewed session #${row.id}${note ? ` — "${note.slice(0, 80)}"` : ''}`);
  res.json({ success: true, message: 'Session reviewed.' });
});

// Admin: mark/unmark a session as golden for the engine-vs-physio concordance
// harness (Phase 1). A golden session has a completed physiotherapist manual
// assessment per docs/capture-sop.md. Body: { golden: boolean }.
router.patch('/admin/sessions/:id/golden', requireAdmin, (req, res) => {
  const row = loadSession(req, res);
  if (!row) return;
  if (row.status !== 'analyzed') {
    return res.status(400).json({ error: 'Only analyzed sessions can be marked golden.' });
  }
  const golden = Boolean(req.body && req.body.golden);
  db.prepare('UPDATE gait_sessions SET is_golden = ?, updated_at = datetime(\'now\') WHERE id = ?')
    .run(golden ? 1 : 0, row.id);
  auditGait(req, golden ? 'gait_golden_mark' : 'gait_golden_unmark', 'gait', row.id,
    `Marked session #${row.id} ${golden ? 'golden' : 'not golden'}`);
  res.json({ success: true, message: `Session #${row.id} ${golden ? 'marked golden' : 'unmarked golden'}.`, golden });
});

// Admin: apply manual clinician edits to a session's stored results and re-persist
// the JSON so the patient view and PDF/DOCX reports reflect the final version.
// Body shape: { result: { ...patched results object } } — the caller submits the
// full corrected result object (or a deep-merged subset under `result`).
router.put('/admin/sessions/:id/results', requireAdmin, (req, res) => {
  const row = loadSession(req, res);
  if (!row) return;
  if (!row.results) return res.status(400).json({ error: 'No results to edit for this session.' });

  const submitted = req.body;
  if (!submitted || typeof submitted !== 'object') {
    return res.status(400).json({ error: 'Patch body required.' });
  }
  const edited = (submitted.result && typeof submitted.result === 'object')
    ? submitted.result
    : submitted;
  if (!edited || typeof edited !== 'object') {
    return res.status(400).json({ error: 'Provide the edited result object under `result`.' });
  }

  const current = safeJson(row.results) || {};
  const merged = deepMerge(current, edited);

  db.prepare(`UPDATE gait_sessions SET results = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(JSON.stringify(merged), row.id);
  auditGait(req, 'gait_edit_results', 'gait', row.id, 'Clinician applied manual corrections to session results');
  res.json({ success: true, message: 'Session results updated.' });
});

function deepMerge(target, source) {
  const out = Array.isArray(target) ? target.slice() : { ...target };
  if (Array.isArray(source)) return source.slice();
  if (typeof source !== 'object' || source === null) return source;
  for (const key of Object.keys(source)) {
    const sv = source[key];
    if (Array.isArray(sv)) {
      out[key] = sv.slice();
    } else if (sv && typeof sv === 'object') {
      out[key] = deepMerge(out[key] && typeof out[key] === 'object' && !Array.isArray(out[key]) ? out[key] : {}, sv);
    } else {
      out[key] = sv;
    }
  }
  return out;
}

// Admin: run the video-overlay OCR on demand (V5 QA re-scan) and return the fresh
// name_metadata payload without re-running analysis. Persists nothing.
router.post('/admin/sessions/:id/ocr', requireAdmin, async (req, res) => {
  const row = loadSession(req, res);
  if (!row) return;
  if (!row.frontal_video && !row.sagittal_video && !row.combined_video) {
    return res.status(400).json({ error: 'No recorded videos are available to scan.' });
  }
  const meta = await runOcrAtExport(row);
  auditGait(req, 'gait_ocr_rescan', 'gait', row.id, 'QA re-ran the video-overlay OCR for the session');
  res.json({ success: true, name_metadata: meta });
});

// Admin: full detail for a single session, including the patient's demographic
// record (used to prefill the admin edit form). Read-only staff may view.
router.get('/admin/sessions/:id', requireStaffView, (req, res) => {
  const s = loadSession(req, res);
  if (!s) return;
  const user = db.prepare(
    'SELECT id, guardian_name, child_name, diagnosis, country_code, phone, address, username FROM users WHERE id = ?'
  ).get(s.user_id) || {};
  res.json({ session: { ...serialize(s, true), user } });
});

// Admin: edit/save a session's patient details + session metadata.
// Updates the patient's user record (guardian/child name, diagnosis, address,
// phone, country) and the session's notes / uploaded (created) date.
router.put('/admin/sessions/:id/details', requireAdmin, (req, res) => {
  const s = loadSession(req, res);
  if (!s) return;
  const b = req.body || {};

  const patient = {
    guardian_name: String(b.guardian_name || '').trim().slice(0, 255) || null,
    child_name: String(b.child_name || '').trim().slice(0, 255) || null,
    diagnosis: String(b.diagnosis || '').trim().slice(0, 500) || null,
    address: String(b.address || '').trim().slice(0, 500) || null,
    phone: String(b.phone || '').trim().slice(0, 40) || null,
    country_code: String(b.country_code || '').trim().slice(0, 8) || null,
  };
  const sets = Object.keys(patient)
    .filter(k => patient[k] !== null)
    .map(k => `${k} = ?`)
    .join(', ');
  if (sets) {
    db.prepare(`UPDATE users SET ${sets} WHERE id = ?`).run(...Object.values(patient).filter(v => v !== null), s.user_id);
  }

  const notes = b.notes !== undefined ? String(b.notes).trim().slice(0, 2000) : s.notes;
  let created_at = s.created_at;
  if (b.created_at && /^\d{4}-\d{2}-\d{2}/.test(b.created_at)) {
    const d = new Date(b.created_at);
    if (!isNaN(d.getTime())) created_at = b.created_at;
  }

  // Demographics from admin edit
  const ageYears = b.ageYears !== undefined ? normalizeAge(b.ageYears) : s.age_years;
  const gender = b.gender !== undefined ? normalizeGender(b.gender) : s.gender;
  const bodyMassKg = b.bodyMassKg !== undefined ? normalizeBodyMass(b.bodyMassKg) : s.body_mass_kg;
  const clinicianName = b.clinicianName !== undefined ? (String(b.clinicianName).trim().slice(0, 200) || null) : s.clinician_name;

  db.prepare(
    'UPDATE gait_sessions SET notes = ?, created_at = ?, age_years = ?, gender = ?, body_mass_kg = ?, clinician_name = ?, updated_at = datetime(\'now\') WHERE id = ?'
  ).run(notes, created_at, ageYears, gender, bodyMassKg, clinicianName, s.id);

  auditGait(req, 'gait_edit_details', 'gait', s.id, 'Admin updated patient/session details for the gait session');
  res.json({ success: true, message: 'Patient & session details saved.' });
});

function needReportData(req, res) {
  const row = loadSession(req, res);
  if (!row) return null;
  if (!canRead(req, row)) { res.status(403).json({ error: 'Not your session.' }); return null; }
  if (!row.results) { res.status(400).json({ error: 'Analyze the session before exporting a report.' }); return null; }
  const user = db.prepare('SELECT guardian_name, child_name, username, diagnosis FROM users WHERE id = ?').get(row.user_id) || {};
  row.results = safeJson(row.results);
  return { row, user };
}

// ===========================================================================
// Functional Assessment appendix (clinical scales × gait cross-validation)
// --------------------------------------------------------------------------
// Reads the patient's latest stored scale records (python/bbs_engine.py +
// scales_registry.py produced every payload — this file only resolves the
// deep parameter paths into the session's canonical results JSON) and builds
// the BBS <-> kinematics cross-validation table, per spec P1: a cross-check
// is 'assessed' only when BOTH the predicted-deficit parameter path exists
// in this session's results and the BBS item was scored; otherwise it is
// rendered as 'unassessed', never inferred.
// ===========================================================================
const SCALE_TYPES_APP = ['bbs', 'tug', 'gmfcs', 'oga'];
const SCALE_LABELS_MAP = { bbs: 'Berg Balance Scale', tug: 'Timed Up & Go', gmfcs: 'GMFCS-E&R', oga: 'Observational Gait Analysis (Rancho Los Amigos)' };

function loadScalesForReport(userId) {
  const out = {};
  for (const st of SCALE_TYPES_APP) {
    const rowDb = db.prepare(
      "SELECT * FROM clinical_scales WHERE user_id = ? AND scale_type = ? AND status IN ('assessed','reviewed') ORDER BY created_at DESC LIMIT 1"
    ).get(userId, st);
    if (rowDb) out[st] = { ...rowDb, items: safeJson(rowDb.items), payload: safeJson(rowDb.payload) };
  }
  return out;
}

function crosscheckBbsGait(scales, results) {
  const bbs = scales.bbs;
  if (!bbs || !bbs.payload) return [];
  const curves = [];
  for (const flag of (bbs.payload.gait_impact_flags || [])) {
    const paths = flag.crosscheck_params;
    if (!paths) {
      curves.push({ bbs_item: flag.item, task: flag.task, bbs_score: flag.score,
        predicted_deficit: flag.predicted_gait_deficit, status: 'unassessed',
        reason: 'Not observable by 2D markerless video gait analysis.' });
      continue;
    }
    const observed = [];
    let anyFound = false;
    for (const p of paths) {
      let val = results, pathStr = [];
      let found = null;
      pathStr = p;
      for (const key of p) {
        if (val && typeof val === 'object' && Object.prototype.hasOwnProperty.call(val, key)) {
          val = val[key];
        } else { val = undefined; break; }
      }
      if (val !== undefined && val !== null) { anyFound = true; found = val; }
      observed.push({ param: p.join('.'), value: found == null ? null : found });
    }
    curves.push({ bbs_item: flag.item, task: flag.task, bbs_score: flag.score,
      predicted_deficit: flag.predicted_gait_deficit, status: anyFound ? 'assessed' : 'unassessed',
      observed_params: observed,
      reason: anyFound ? null : 'No supporting gait-analysis parameter present in this session (P1: withheld, not inferred).' });
  }
  return curves;
}

// Renders the appendix into the PDFKit document `doc`.
function addFunctionalAssessmentPdf(doc, scales, crosscheck) {
  const anyScale = SCALE_TYPES_APP.some(st => scales[st]);
  if (!anyScale && !crosscheck.length) return;
  doc.moveDown(0.8);
  doc.rect(50, doc.y, 495, 2).fill('#C99436');
  doc.moveDown(0.4);
  doc.fontSize(13).fillColor('#1E3C82').text('Functional Assessment (Clinical Scales)');
  doc.moveDown(0.3);
  doc.fontSize(7.5).fillColor('#5A5D55').text('Scores by the offline BRC scale engines (python/bbs_engine.py, scales_registry.py). Interpretations carry their evidence citations from docs/references/SOURCES.md. Screening indicators only — not diagnoses.', { width: 495 });
  doc.moveDown(0.3);

  if (scales.bbs && scales.bbs.payload) {
    const p = scales.bbs.payload;
    doc.fontSize(10).fillColor('#1E3C82').text(`Berg Balance Scale — ${p.total_score}/56 (${p.items_recorded}/${p.items_expected} items scored)`);
    doc.moveDown(0.2);
    if (p.mobility_band) {
      doc.fontSize(9).fillColor('#232520').text(`Mobility band: ${p.mobility_band.level} — ${p.mobility_band.recommendation}`);
    }
    if (p.fall_screen) {
      doc.fontSize(9).fillColor(p.fall_screen.risk_flagged ? '#B3452F' : '#2F7A4D')
        .text(`Fall screen (${p.fall_screen.population_label}): ${p.fall_screen.risk_flagged ? 'FLAGGED' : 'not flagged'} at cutoff ${p.fall_screen.cutoff}.`);
      doc.fontSize(7.8).fillColor('#5A5D55').text(p.fall_screen.text, { width: 495 });
    }
    doc.moveDown(0.2);
  }
  if (scales.tug && scales.tug.payload) {
    const p = scales.tug.payload;
    doc.fontSize(10).fillColor('#1E3C82').text(`Timed Up & Go — ${p.seconds} s (${p.population_label})`);
    doc.moveDown(0.2);
    if (p.interpretation) {
      doc.fontSize(9).fillColor(p.fallback_risk ? '#B3452F' : '#2F7A4D').text(p.interpretation.text, { width: 495 });
    }
    if ((p.observations || []).length) doc.fontSize(8).fillColor('#5A5D55').text(`Observations: ${p.observations.join(', ')}`, { width: 495 });
    doc.moveDown(0.2);
  }
  if (scales.gmfcs && scales.gmfcs.payload && scales.gmfcs.payload.level) {
    const p = scales.gmfcs.payload;
    doc.fontSize(10).fillColor('#1E3C82').text(`GMFCS-E&R — Level ${p.level} (${p.age_label || 'age band not recorded'})`);
    doc.moveDown(0.2);
    doc.fontSize(9).fillColor('#232520').text(p.interpretation.text);
    doc.fontSize(7.8).fillColor('#5A5D55').text('Classification of usual performance — distinguishes functional limitation, not diagnosis; not a change-over-time outcome measure (Palisano 1997/2007, CanChild McMaster).', { width: 495 });
    doc.moveDown(0.2);
  }
  if (scales.oga && scales.oga.payload) {
    const p = scales.oga.payload;
    const n = (p.entries || []).length;
    doc.fontSize(10).fillColor('#1E3C82').text(`Observational Gait Analysis (Rancho Los Amigos) — ${n} deviation${n === 1 ? '' : 's'} recorded`);
    doc.moveDown(0.2);
    (p.entries || []).slice(0, 12).forEach(e => {
      doc.fontSize(8.5).fillColor('#232520').text(`• ${e.segment} — ${e.deviation} (${e.phase}, ${e.side})`, { width: 495 });
    });
    if (n > 12) doc.fontSize(7.8).fillColor('#5A5D55').text(`…and ${n - 12} more.`, { width: 495 });
    doc.moveDown(0.2);
  }

  if (crosscheck.length) {
    doc.moveDown(0.4);
    doc.fontSize(10).fillColor('#1E3C82').text('BBS × Gait Analysis Cross-Validation');
    doc.moveDown(0.2);
    doc.fontSize(7.8).fillColor('#5A5D55').text('Predicted deficits from low-scoring BBS items (≤2) check against the objective engine measurements for this session. A cross-check is assessed only when both sides exist; otherwise it is withheld (zero-assumption protocol).', { width: 495 });
    doc.moveDown(0.3);
    crosscheck.forEach(c => {
      doc.fontSize(9).fillColor('#232520').text(
        `Item ${c.bbs_item} — ${c.task} (${c.bbs_score}/4): ${c.predicted_deficit}`,
        { width: 495 });
      if (c.status === 'assessed') {
        c.observed_params.forEach(o => doc.fontSize(8).fillColor(o.value != null ? '#2F7A4D' : '#5A5D55')
          .text(`   ${o.param} = ${o.value != null ? o.value : 'unmeasured'}`, { width: 480 }));
      } else {
        doc.fontSize(8).fillColor('#B3452F')
          .text(`   UNASSESSED — ${c.reason}`, { width: 480 });
      }
      doc.moveDown(0.15);
    });
  }
}

router.get('/sessions/:id/report.pdf', requireAuth, async (req, res) => {
  const ctx = needReportData(req, res);
  if (!ctx) return;
  const { row, user } = ctx;
  const r = row.results;
  const clinic = getClinic();

  // run.txt §1 — name overlay verification runs ONLY here, on export. OCR is
  // deliberately not part of analysis; it happens when the clinician clicks
  // "Export PDF" / "Export Word". The result is attached in-memory (not stored).
  r.name_metadata = await runOcrAtExport(row);

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="gait-report-${row.id}.pdf"`);

  const doc = new PDFDocument({ margin: 50, bufferPages: true });
  doc.pipe(res);

  // ---- letterhead ----
  try { doc.image(LOGO_PATH, 50, 38, { width: 62 }); } catch (e) { /* noop */ }
  doc.fontSize(17).fillColor('#1E3C82').text(clinic.clinic_name, 122, 40, { width: 380 });
  doc.fontSize(8.5).fillColor('#5A5D55').text(clinic.clinic_address, 122, 62, { width: 380 });
  doc.fontSize(8.5).fillColor('#5A5D55').text(`${clinic.clinic_email}   ·   ${clinic.clinic_phone}`, 122, 75, { width: 380 });
  doc.moveTo(50, 106).lineTo(545, 106).strokeColor('#E1EEF8').lineWidth(1).stroke();
  doc.fontSize(13).fillColor('#C99436').text('Gait Laboratory Report', 50, 116);
  doc.fontSize(7.5).fillColor('#9FC3E0').text(`Generated ${new Date().toLocaleString()}   ·   Confidential — for clinical use only`, 50, 134);
  doc.y = 158;

  doc.fontSize(10).fillColor('#232520');
  doc.text(`Patient: ${user.child_name}`);
  doc.text(`Guardian: ${user.guardian_name}`);
  doc.text(`Diagnosis: ${user.diagnosis || 'Not specified'}`);
  doc.text(`Session: #${row.id}   ·   Status: ${row.status}${row.reviewed_at ? `   ·   Reviewed by ${row.reviewed_by} on ${row.reviewed_at}` : ''}`);
  // Demographics block (run.txt section 1)
  const demoParts = [];
  if (row.age_years != null) demoParts.push(`Age: ${row.age_years} years`);
  if (row.gender) demoParts.push(`Gender: ${row.gender}`);
  if (row.body_mass_kg != null) demoParts.push(`Body mass: ${row.body_mass_kg} kg`);
  if (row.height_cm != null) demoParts.push(`Height: ${row.height_cm} cm`);
  if (demoParts.length) doc.text(`Demographics: ${demoParts.join('  ·  ')}`);
  if (row.clinician_name) doc.text(`Assessing clinician: ${row.clinician_name}`);
  // run.txt §1 — patient-name overlay verification result (on-demand OCR).
  if (r.name_metadata && r.name_metadata.status) {
    const nm = r.name_metadata;
    const ok = nm.status === 'verified';
    const stateLabel = ok
      ? `VERIFIED — “${nm.matched_name || ''}” read from the recording overlay`
      : (nm.status === 'deferred'
          ? 'PENDING — name overlay is verified when the report is exported'
          : (nm.status === 'ocr_unavailable' ? 'OCR UNAVAILABLE on this server' : 'UNVERIFIED — OCR mismatch'));
    doc.fontSize(8).fillColor(ok ? '#2F7A4D' : (nm.status === 'deferred' ? '#8a5a00' : '#B3452F'))
      .text(`Patient name overlay (OCR): ${stateLabel}. ${nm.reason || ''}`, { width: 495 });
  }
  const captureRouting = (r && r.input && r.input.routing) || 'single-plane';
  const captureModeLabel = captureRouting === 'combined-dual-view'
    ? 'Combined Dual-Plane Video (simultaneous frontal & sagittal capture)'
    : (captureRouting === 'dual-view-3d' ? 'Separate Frontal + Sagittal recordings' : 'Single-plane recording');
  doc.fontSize(8).fillColor('#5A5D55').text(`Capture mode: ${captureModeLabel}`);
  doc.moveDown(0.6);
  doc.fontSize(8).fillColor('#B3452F').text(`Analysis engine: ${r.mode === 'rejected' ? 'Blocked — no metrics generated' : 'BRC Biomechanical Engine'}  —  ${r.diagnostic_note}`, { width: 495 });
  doc.moveDown(0.6);
  doc.moveDown(1);

  // 2e.txt — strict rejection: no metrics were generated; print a professional
  // notice instead of empty/garbage sections (fail-safe against null values).
  if (r.mode === 'rejected') {
    doc.moveDown(1.2);
    doc.roundedRect(50, doc.y, 495, 64, 6).fill('#F9E3DE').strokeColor('#B3452F').lineWidth(1.5).stroke();
    doc.fontSize(12).fillColor('#B3452F').text('Analysis Blocked — No Metrics Generated', 62, doc.y + 10);
    doc.fontSize(8.5).fillColor('#232520').text((r.gait_validation && r.gait_validation.message) || NO_GENUINE_GAIT_MSG, 62, doc.y + 30, { width: 472 });
    doc.moveDown(5);
    doc.fontSize(9).fillColor('#232520').text('No clinical metrics were produced from this capture. To proceed, please re-upload a clear video of the patient walking straight in the specified plane and re-run the analysis.');
    doc.moveDown(0.4);
    ((r.gait_validation && r.gait_validation.reasons) || []).forEach(rs => doc.fontSize(8.5).fillColor('#5A5D55').text(`• ${rs}`, { width: 495 }));
    addFooters(doc);
    return doc.end();
  }

  // ---- beginner-friendly summary (easy-read first, plain language) ----
  if (r.beginner_summary) {
    const bs = r.beginner_summary || {};
    doc.moveDown(0.4);
    doc.fontSize(13).fillColor('#1E3C82').text('Beginner-Friendly Summary (Easy Read)');
    doc.moveDown(0.4);
    doc.rect(50, doc.y, 495, 2).fill('#C99436');
    doc.moveDown(0.5);
    doc.fontSize(10.5).fillColor('#1E3C82').text(bs.headline);
    doc.moveDown(0.25);
    if (bs.walking) doc.fontSize(9).fillColor('#232520').text(bs.walking, { width: 495 });
    doc.moveDown(0.3);
    (bs.what_we_found || []).forEach(f => {
      doc.fontSize(9).fillColor('#258DC1').text(`• ${f.title}:`);
      if (f.text) doc.fontSize(8.5).fillColor('#232520').text(`   ${f.text}`, { width: 480 });
      doc.moveDown(0.1);
    });
    (bs.measurements || []).forEach(m => doc.fontSize(8.5).fillColor('#232520').text(`• ${m}`, { width: 495 }));
    if ((bs.recommended_next || []).length) {
      doc.moveDown(0.2);
      doc.fontSize(9).fillColor('#2F7A4D').text('What to do next:');
      (bs.recommended_next || []).forEach(m => doc.fontSize(8.5).fillColor('#232520').text(`• ${m}`, { width: 495 }));
    }
    if (bs.confidence_note) {
      doc.moveDown(0.25);
      doc.fontSize(7.8).fillColor('#5A5D55').text(bs.confidence_note, { width: 495 });
    }
    doc.moveDown(0.6);
  }

  // ---- clinical impression ----
  if (r.summary) {
    doc.fontSize(13).fillColor('#1E3C82').text('Clinical Impression');
    doc.moveDown(0.4);
    doc.rect(50, doc.y, 495, 2).fill('#E1EEF8');
    doc.moveDown(0.4);
    doc.fontSize(10).fillColor('#1E3C82').text(r.summary.headline);
    doc.moveDown(0.25);
    doc.fontSize(8.5).fillColor('#232520').text(r.summary.narrative, { width: 495 });
    doc.moveDown(0.3);
    doc.fontSize(9).fillColor('#258DC1').text('Priority focus areas:');
    (r.focus_areas || []).forEach(f => doc.fontSize(8.5).fillColor('#232520').text(`• ${f}`, { width: 495 }));
    if (r.summary.recommendation) {
      doc.moveDown(0.25);
      doc.fontSize(8.5).fillColor('#2F7A4D').text(r.summary.recommendation, { width: 495 });
    }
    doc.moveDown(0.6);
  }

  // ---- cycle summary ----
  doc.fontSize(13).fillColor('#1E3C82').text('Gait Cycle Summary');
  doc.moveDown(0.4);
  const hasCycle = typeof r.cycle.stance_pct === 'number' && Number.isFinite(r.cycle.stance_pct);
  if (hasCycle) {
    const stanceW = Math.max(6, r.cycle.stance_pct * 4.5);
    doc.rect(50, doc.y, 495, 18).fill('#F0F7FC');
    doc.rect(50, doc.y, stanceW, 18).fill('#46B4DC');
    doc.fontSize(8).fillColor('#232520').text(`Stance ${r.cycle.stance_pct}%`, 54, doc.y + 5);
    doc.text(`Swing ${r.cycle.swing_pct}%`, 54 + stanceW + 8, doc.y + 5);
    doc.y += 22;
    doc.fontSize(9).fillColor('#1E3C82').text(`Gait type: ${r.cycle.running ? 'Running' : 'Walking'}${r.cycle.running && typeof r.cycle.flight_phase_frac === 'number' ? `  ·  Flight phase (double float) ${Math.round(r.cycle.flight_phase_frac * 100)}% of cycle` : ''}`);
    doc.moveDown(0.2);
    doc.fontSize(9).fillColor('#232520').text(`${r.cycle.running ? 'Running cadence' : 'Cadence'}: ${r.cycle.cadence_cycles_per_second} cycles/sec  ·  Cycle duration: ${r.cycle.cycle_seconds}s  ·  Stance/Swing: ${r.cycle.stance_pct}% / ${r.cycle.swing_pct}%`);
    const band = r.cycle.stance_norm_band || [58, 62];
    const stanceStatus = r.summary && r.summary.stance_status ? r.summary.stance_status : (r.cycle.stance_pct < band[0] ? 'shorter than normative range' : (r.cycle.stance_pct > band[1] ? 'longer than normative range' : 'within normative range'));
    doc.fontSize(8).fillColor('#5A5D55').text(`Normative stance reference band: ${band[0]}–${band[1]}%. Stance is ${stanceStatus}.`);
  } else {
    doc.fontSize(9).fillColor('#5A5D55').text((r.summary && r.summary.stance_status) || 'Temporal gait timing was not measured — no valid sagittal-plane cycle was captured.', { width: 495 });
  }
  if (r.cycle && r.cycle.playback_note) {
    doc.moveDown(0.15);
    doc.fontSize(8).fillColor('#258DC1').text(r.cycle.playback_note, { width: 495 });
  }

  // ---- phase table ----
  doc.moveDown(0.8);
  doc.fontSize(13).fillColor('#1E3C82').text('Stance & Swing Sub-Phases');
  doc.moveDown(0.4);
  const phaseRows = r.cycle.phases.map(p => {
    const range = Array.isArray(p.norm_range_pct) ? `${p.norm_range_pct[0]}–${p.norm_range_pct[1]}%` : '';
    const status = p.flag === 'none' ? 'Normal' : `${p.classification || p.flag}${p.severity ? ' · ' + p.severity : ''}`;
    return [p.name, p.type, `${p.pct_of_cycle}%`, `${p.duration_ms} ms`, range, status];
  });
  let y = drawTable(doc, ['Phase', 'Type', '% of cycle', 'Duration', 'Norm range', 'Status'], phaseRows, [170, 60, 70, 70, 80, 75], doc.y);
  doc.y = y;

  // ---- anomalies ----
  if (r.cycle.anomalies.length) {
    doc.moveDown(0.4);
    doc.fontSize(13).fillColor('#1E3C82').text('Detected Anomalies');
    doc.moveDown(0.4);
    r.cycle.anomalies.forEach(a => {
      const color = a.severity === 'major' ? '#B3452F' : (a.severity === 'moderate' ? '#C99436' : '#46B4DC');
      doc.fontSize(9).fillColor(color).text(`[${a.severity.toUpperCase()}] ${a.phase_name} — ${a.type}`);
      doc.fontSize(8).fillColor('#5A5D55').text(`  ${a.description}`);
    });
  }

  // ---- deformities ----
  doc.moveDown(0.6);
  doc.fontSize(13).fillColor('#1E3C82').text('Multi-Planar Deformity & Biomechanical Analysis');
  doc.moveDown(0.4);
  doc.fontSize(10).fillColor('#232520').text('Frontal plane');
  (r.profile.frontal.deformities || []).forEach(d => doc.fontSize(9).fillColor('#232520').text(`• ${d.name} (${d.magnitude}${d.category ? ' · ' + d.category : ''}) — ${d.description}`, { width: 495 }));
  doc.moveDown(0.3);
  doc.fontSize(10).fillColor('#232520').text('Sagittal plane');
  (r.profile.sagittal.deformities || []).forEach(d => doc.fontSize(9).fillColor('#232520').text(`• ${d.name} (${d.magnitude}${d.category ? ' · ' + d.category : ''}) — ${d.description}`, { width: 495 }));
  doc.moveDown(0.3);
  doc.fontSize(10).fillColor('#232520').text('Rotational / transverse plane');
  (r.profile.rotational ? r.profile.rotational.deformities || [] : []).forEach(d => doc.fontSize(9).fillColor('#232520').text(`• ${d.name} (${d.magnitude}${d.category ? ' · ' + d.category : ''}) — ${d.description}`, { width: 495 }));
  doc.fontSize(7.5).fillColor('#5A5D55').text('Findings classified as structural (bony/alignment), functional (timing/muscle-driven) or rotational (transverse-plane torsion).', { width: 495 });

  // ---- ROM ----
  doc.moveDown(0.6);
  doc.fontSize(13).fillColor('#1E3C82').text('Joint Kinematics (Range of Motion)');
  doc.moveDown(0.4);
  const romRows = r.kinematics.rom.map(x => [x.joint, x.movement, x.normal, x.observed]);
  y = drawTable(doc, ['Joint', 'Movement', 'Reference ROM', 'Observed'], romRows, [70, 165, 150, 120], doc.y);
  doc.y = y;

  // ---- Anthropometry (run.txt section 2) ----
  if (r.anthropometry) {
    doc.moveDown(0.6);
    doc.fontSize(13).fillColor('#1E3C82').text('Anthropometric Measurements');
    doc.moveDown(0.4);
    const anthro = r.anthropometry;
    if (anthro.estimated_segments) {
      doc.fontSize(9).fillColor('#232520').text('Estimated segment lengths (from video):');
      const segRows = [];
      Object.entries(anthro.estimated_segments).forEach(([k, v]) => {
        if (v && typeof v === 'object') {
          segRows.push([k.replace(/_/g, ' '), v.left != null ? `${v.left} cm` : '—', v.right != null ? `${v.right} cm` : '—', v.symmetry_index != null ? `${v.symmetry_index}%` : '—']);
        }
      });
      if (segRows.length) {
        y = drawTable(doc, ['Segment', 'Left', 'Right', 'SI'], segRows, [170, 110, 110, 105], doc.y);
        doc.y = y;
      }
    }
    if (anthro.body_proportions) {
      doc.fontSize(9).fillColor('#232520').text('Body proportions:');
      const bp = anthro.body_proportions;
      if (bp.height_to_sitting != null) doc.fontSize(8.5).fillColor('#232520').text(`  Height-to-sitting ratio: ${bp.height_to_sitting}`);
      if (bp.leg_length_to_height != null) doc.fontSize(8.5).fillColor('#232520').text(`  Leg length / height: ${bp.leg_length_to_height}`);
      if (bp.sitting_to_leg != null) doc.fontSize(8.5).fillColor('#232520').text(`  Sitting-to-leg ratio: ${bp.sitting_to_leg}`);
    }
    if (anthro.confidence) {
      doc.moveDown(0.2);
      doc.fontSize(8).fillColor('#5A5D55').text(`Measurement confidence: ${anthro.confidence}${anthro.confidence_note ? ' — ' + anthro.confidence_note : ''}`, { width: 495 });
    }
  }

  // ---- muscles ----
  doc.moveDown(0.4);
  doc.fontSize(13).fillColor('#1E3C82').text('Muscle Involvement Map');
  doc.moveDown(0.4);
  doc.fontSize(9).fillColor('#B3452F').text('Overactive / overworked:');
  (r.muscles.overactive || []).forEach(m => doc.fontSize(9).fillColor('#232520').text(`• ${m.name} — ${m.role}`, { width: 495 }));
  doc.moveDown(0.2);
  doc.fontSize(9).fillColor('#46B4DC').text('Weak / under-active:');
  (r.muscles.weak || []).forEach(m => doc.fontSize(9).fillColor('#232520').text(`• ${m.name} — ${m.role}`, { width: 495 }));
  doc.moveDown(0.2);
  doc.fontSize(9).fillColor('#2F7A4D').text('Deformity ↔ muscle linkage:');
  (r.muscles.anomaly_links || []).forEach(l => {
    doc.fontSize(8.5).fillColor('#232520').text(`• ${l.anomaly}${l.matched ? '' : ' (pattern context)'}`, { width: 495 });
    (l.muscles || []).forEach(mu => doc.fontSize(8).fillColor(mu.status === 'overactive' ? '#B3452F' : '#258DC1')
      .text(`    ${mu.name} [${mu.status}] — ${mu.role}. ${mu.implication}`, { width: 495 }));
    if (l.compensation) doc.fontSize(8).fillColor('#5A5D55').text(`    Compensation: ${l.compensation}`, { width: 495 });
    if (l.localized_damage) doc.fontSize(8).fillColor('#5A5D55').text(`    Localized structural burden: ${l.localized_damage}`, { width: 495 });
  });
  if ((r.muscles.structural_weaknesses || []).length) {
    doc.moveDown(0.2);
    doc.fontSize(9).fillColor('#1E3C82').text('Structural weaknesses implicated:');
    r.muscles.structural_weaknesses.forEach(w => doc.fontSize(8.5).fillColor('#232520').text(`• ${w.structure} (${w.category}) — linked to ${w.related_deformity}. ${w.note}`, { width: 495 }));
  }
  if ((r.muscles.notes || []).length) {
    doc.moveDown(0.2);
    (r.muscles.notes || []).forEach(n => doc.fontSize(7.5).fillColor('#5A5D55').text(`- ${n}`));
  }

  // ---- prescriptions ----
  doc.moveDown(0.6);
  doc.fontSize(13).fillColor('#1E3C82').text('Targeted Clinical Prescriptions');
  doc.moveDown(0.4);
  if (r.prescriptions.rationale) {
    doc.fontSize(8.5).fillColor('#2F7A4D').text(r.prescriptions.rationale, { width: 495 });
    doc.moveDown(0.3);
  }
  doc.fontSize(10).fillColor('#232520').text('Exercise routine');
  const exRows = r.prescriptions.exercises.map(e => {
    const detailParts = [];
    if (e.sets) detailParts.push(`${e.sets} sets`);
    if (e.reps) detailParts.push(`${e.reps} reps`);
    if (e.hold_seconds) detailParts.push(`${e.hold_seconds}s hold`);
    if (e.rest_seconds) detailParts.push(`${e.rest_seconds}s rest`);
    const detail = detailParts.length ? detailParts.join(', ') : e.frequency;
    return [e.name, detail, e.reason];
  });
  y = drawTable(doc, ['Exercise', 'Details', 'Rationale'], exRows, [200, 110, 195], doc.y);
  doc.y = y;
  (r.prescriptions.exercises || []).forEach(e => {
    if (e.references && e.references.length) {
      doc.fontSize(7.5).fillColor('#258DC1').text(`  Evidence: ${e.references.map(refShort).join('; ')}`, { width: 495, align: 'right' });
    }
  });
  if (r.prescriptions.orthotics && r.prescriptions.orthotics.length) {
    doc.moveDown(0.4);
    doc.fontSize(10).fillColor('#232520').text('Orthotic recommendations');
    r.prescriptions.orthotics.forEach(o => {
      doc.fontSize(9).fillColor('#232520').text(`• ${o.component} — ${o.reason}`, { width: 495 });
      if (o.references && o.references.length) {
        doc.fontSize(7.5).fillColor('#258DC1').text(`  Evidence: ${o.references.map(refShort).join('; ')}`, { width: 495, align: 'right' });
      }
    });
  }
  if (r.prescriptions.prosthetics && r.prescriptions.prosthetics.length) {
    doc.moveDown(0.4);
    doc.fontSize(10).fillColor('#232520').text('Prosthetic component recommendations');
    r.prescriptions.prosthetics.forEach(o => {
      doc.fontSize(9).fillColor('#232520').text(`• ${o.component} — ${o.reason}`, { width: 495 });
      if (o.references && o.references.length) {
        doc.fontSize(7.5).fillColor('#258DC1').text(`  Evidence: ${o.references.map(refShort).join('; ')}`, { width: 495, align: 'right' });
      }
    });
  }
  doc.moveDown(0.3);
  (r.prescriptions.guidance || []).forEach(g => doc.fontSize(8.5).fillColor('#5A5D55').text(`- ${g}`));

  // ---- predictive progression & prognosis (item 4) ----
  if (r.prediction) {
    const pr = r.prediction;
    doc.moveDown(0.6);
    doc.fontSize(13).fillColor('#1E3C82').text('Predictive Progression & Prognostic Model');
    doc.moveDown(0.4);
    doc.fontSize(9).fillColor(pr.severity === 'elevated' ? '#B3452F' : (pr.severity === 'moderately elevated' ? '#C99436' : '#2F7A4D')).text(`Projected risk severity: ${pr.severity}${(pr.patterns || []).length ? '  ·  Patterns: ' + pr.patterns.join(', ') : ''}`);
    if (pr.measured_note) { doc.moveDown(0.2); doc.fontSize(8).fillColor('#5A5D55').text(`Measurements: ${pr.measured_note}`, { width: 495 }); }
    doc.moveDown(0.3);
    doc.fontSize(9).fillColor('#232520').text('Joint degeneration risk projections:');
    (pr.joint_degeneration_risk || []).forEach(item => doc.fontSize(8.5).fillColor('#232520').text(`• ${item.joint} — ${item.risk_level} (${item.horizon}) — ${item.mechanism}`, { width: 495 }));
    if ((pr.compensatory_pathologies || []).length) {
      doc.moveDown(0.25);
      doc.fontSize(9).fillColor('#232520').text('Projected secondary / compensatory pathologies:');
      pr.compensatory_pathologies.forEach(p => doc.fontSize(8.5).fillColor('#232520').text(`• ${p.pathology} — ${p.likelihood} (${p.timeline}) — ${p.mechanism}`, { width: 495 }));
    }
    if (pr.summary) { doc.moveDown(0.25); doc.fontSize(8.5).fillColor('#232520').text(pr.summary, { width: 495 }); }
    if (pr.recommendation) { doc.moveDown(0.2); doc.fontSize(8.5).fillColor('#2F7A4D').text(pr.recommendation, { width: 495 }); }
    if (pr.disclaimer) { doc.moveDown(0.2); doc.fontSize(7.5).fillColor('#5A5D55').text(pr.disclaimer, { width: 495 }); }

    // ---- Recovery Timeframe (run.txt section 4) ----
    if (pr.recovery_timeframe) {
      const rt = pr.recovery_timeframe;
      doc.moveDown(0.6);
      doc.fontSize(13).fillColor('#1E3C82').text('Recovery Timeframe & Rehabilitation Pathway');
      doc.moveDown(0.4);
      doc.fontSize(10).fillColor('#1E3C82').text(rt.phase_label);
      doc.moveDown(0.2);
      doc.fontSize(9).fillColor('#232520').text(`Estimated duration: ${rt.estimated_weeks_low}–${rt.estimated_weeks_high} weeks`);
      doc.moveDown(0.2);
      doc.fontSize(9).fillColor('#232520').text('Milestone targets:');
      (rt.milestones || []).forEach(m => {
        doc.fontSize(8.5).fillColor('#232520').text(`  Week ${m.week}: ${m.target}`, { width: 495 });
        doc.fontSize(8).fillColor('#5A5D55').text(`    Metric: ${m.metric}`, { width: 495 });
      });
      doc.moveDown(0.2);
      doc.fontSize(8).fillColor('#5A5D55').text(rt.reassessment_schedule, { width: 495 });
      if (rt.note) { doc.moveDown(0.15); doc.fontSize(7.5).fillColor('#5A5D55').text(rt.note, { width: 495 }); }
    }

    // ---- Prognostic KPIs (run.txt section 4) ----
    if (pr.prognostic_kpis && pr.prognostic_kpis.length) {
      doc.moveDown(0.6);
      doc.fontSize(13).fillColor('#1E3C82').text('Prognostic KPIs — Therapy Progression Targets');
      doc.moveDown(0.4);
      pr.prognostic_kpis.forEach(cat => {
        doc.fontSize(10).fillColor('#1E3C82').text(cat.category);
        doc.moveDown(0.2);
        cat.targets.forEach(t => {
          doc.fontSize(8.5).fillColor('#232520').text(`• ${t.metric}`, { width: 495 });
          doc.fontSize(8).fillColor('#258DC1').text(`  Baseline target: ${t.baseline_target}`, { width: 495 });
          doc.fontSize(8).fillColor('#2F7A4D').text(`  Milestone: ${t.milestone_target}`, { width: 495 });
        });
        doc.moveDown(0.2);
      });
    }
  }

  // ---- multi-view 3D kinematics (2e.txt items 1 & 4) ----
  if (r.cv3d && r.cv3d.status === 'ok') {
    const c3 = r.cv3d;
    const tri = Boolean((c3.calibration || {}).third_view_used);
    doc.moveDown(0.6);
    doc.fontSize(13).fillColor('#1E3C82').text(tri ? 'Multi-View 3D Kinematics (Tri-View Triangulation)' : 'Multi-View 3D Kinematics (Dual-Plane Triangulation)');
    doc.moveDown(0.4);
    doc.fontSize(8.5).fillColor('#5A5D55').text(
      `Engine: ${c3.engine === 'brc-multiview-3d' ? 'BRC multi-view 3D (calibrated)' : 'BRC orthographic least-squares triangulation'}  ·  ${tri ? 'tri-view' : 'dual-view'}  ·  Samples: ${c3.samples}  ·  Units: ${(c3.calibration || {}).units || 'normalized'}  ·  Cameras: ${tri ? 'frontal + sagittal + third (Coronal)' : 'frontal + sagittal'}`, { width: 495 });
    doc.moveDown(0.3);
    const angleNames = { hip_flex: 'Hip flexion', knee_flex: 'Knee flexion', ankle_angle: 'Ankle angle', shoulder_flex: 'Shoulder flexion', elbow_flex: 'Elbow flexion', knee_valgus: 'Knee frontal deviation' };
    const angleRows = Object.keys(angleNames).filter(k => c3.joint_angles_3d && c3.joint_angles_3d[k]).map(k => [
      angleNames[k], c3.joint_angles_3d[k].L == null ? '—' : `${c3.joint_angles_3d[k].L}°`,
      c3.joint_angles_3d[k].R == null ? '—' : `${c3.joint_angles_3d[k].R}°` ]);
    if (angleRows.length) { y = drawTable(doc, ['3D Joint Angle', 'Left (median)', 'Right (median)'], angleRows, [220, 130, 130], doc.y); doc.y = y; }
    if (c3.segment_lengths) {
      doc.moveDown(0.3);
      doc.fontSize(9).fillColor('#232520').text('Normalized segment lengths (torso heights):');
      const segRows = Object.keys(c3.segment_lengths).map(k => [k.replace(/_/g, ' '), c3.segment_lengths[k]]);
      y = drawTable(doc, ['Segment', 'Length'], segRows, [240, 120], doc.y);
      doc.y = y;
    }
    if (c3.symmetry) {
      doc.moveDown(0.2);
      const si = (v) => (v == null ? 'n/a' : v + '%');
      doc.fontSize(8.5).fillColor('#232520').text(
        `Symmetry indices — knee flexion ${si(c3.symmetry.knee_flex_si)} · hip flexion ${si(c3.symmetry.hip_flex_si)} · thigh length ${si(c3.symmetry.thigh_si)} · shank length ${si(c3.symmetry.shank_si)}`, { width: 495 });
    }
    const embed3d = (rel, height, label) => {
      if (!rel) return;
      const abs = resolveUploadRel(rel);
      if (!abs || !fs.existsSync(abs)) { doc.fontSize(7.5).fillColor('#5A5D55').text(`(3D graph not embedded — artifact missing: ${label})`, { width: 495 }); return; }
      if (doc.y + height > doc.page.height - 60) doc.addPage();
      doc.image(abs, 50, doc.y, { width: 495 });
      doc.y += height + 6;
    };
    if (c3.plots && c3.plots.sim3d_anatomy) {
      doc.moveDown(0.4);
      doc.fontSize(9).fillColor('#232520').text(`Reconstructed anatomy (${tri ? 'frontal + sagittal + third (Coronal)' : 'frontal + sagittal'} projections):`);
      embed3d(c3.plots.sim3d_anatomy, 235, 'anatomy');
    }
    if (c3.plots && c3.plots.sim3d_angles) {
      doc.moveDown(0.3);
      doc.fontSize(9).fillColor('#232520').text('3D joint-angle kinematics curves (multi-view reconstruction):');
      embed3d(c3.plots.sim3d_angles, 218, 'angles');
    }
    if (c3.anatomical_note) { doc.moveDown(0.2); doc.fontSize(7.5).fillColor('#5A5D55').text(c3.anatomical_note, { width: 495 }); }
  }

  // ---- clinical sign-off block (run.txt section 5) ----
  doc.moveDown(0.8);
  doc.rect(50, doc.y, 495, 2).fill('#1E3C82');
  doc.moveDown(0.4);
  doc.fontSize(13).fillColor('#1E3C82').text('Clinical Sign-Off');
  doc.moveDown(0.4);
  doc.fontSize(9).fillColor('#232520').text(`Patient: ${user.child_name}`);
  if (row.age_years != null || row.gender) {
    doc.fontSize(8.5).fillColor('#232520').text(`Demographics: ${[row.age_years != null ? `${row.age_years} years` : '', row.gender || '', row.body_mass_kg != null ? `${row.body_mass_kg} kg` : ''].filter(Boolean).join('  ·  ')}`);
  }
  doc.text(`Session: #${row.id}   ·   Analysis: ${r.mode === 'rejected' ? 'Blocked' : 'BRC Biomechanical Engine'}`);
  doc.moveDown(0.3);
  doc.fontSize(9).fillColor('#232520').text('Assessing clinician: ___________________________');
  doc.moveDown(0.3);
  doc.text('Signature: ___________________________   Date: ____________');
  doc.moveDown(0.2);
  doc.fontSize(8).fillColor('#5A5D55').text('This report is generated by the BRC Biomechanical Engine and must be reviewed and signed by a qualified clinician.', { width: 495 });

  // ---- references (core + per-category evidence, 1e.txt item 5) ----
  doc.moveDown(0.6);
  doc.fontSize(13).fillColor('#1E3C82').text('References');
  doc.moveDown(0.4);
  const refSections = r.reference_sections || { core: r.references || [], supporting: [] };
  const REF_CATEGORIES = [
    ['core', 'Core gait-analysis references'],
    ['deformity', 'Evidence — deformity & alignment detection'],
    ['exercise', 'Evidence — exercise rehabilitation'],
    ['orthotic_prosthetic', 'Evidence — orthotic / prosthetic intervention'],
    ['prognosis', 'Evidence — progression & prognosis'],
    ['supporting', 'Supporting literature matched to findings'],
  ];
  REF_CATEGORIES.forEach(([key, heading]) => {
    const list = key === 'core' ? (refSections.core || []) : (refSections[key] || []);
    if (!list.length) return;
    doc.moveDown(0.45);
    doc.fontSize(10).fillColor('#1E3C82').text(heading);
    doc.moveDown(0.2);
    list.forEach(ref => {
      doc.fontSize(8).fillColor('#232520').text(`${ref.id}. ${ref.authors} (${ref.year}). ${ref.title}. ${ref.venue}.`, { width: 495 });
      if (ref.topics && ref.topics.length) doc.fontSize(7.5).fillColor('#258DC1').text(`   Relevant to: ${ref.topics.map(t => t.replace(/-/g, ' ')).join(', ')}`, { width: 495 });
    });
  });

  // ---- functional assessment appendix (clinical scales × gait) ----
  const reportScales = loadScalesForReport(row.user_id);
  const reportCrosscheck = crosscheckBbsGait(reportScales, r);
  addFunctionalAssessmentPdf(doc, reportScales, reportCrosscheck);

  addFooters(doc);
  doc.end();
});

router.get('/sessions/:id/report.docx', requireAuth, async (req, res) => {
  const ctx = needReportData(req, res);
  if (!ctx) return;
  const { row, user } = ctx;
  const r = row.results;
  const clinic = getClinic();

  // run.txt §1 — name overlay verification runs ONLY here, on export. OCR is
  // deliberately not part of analysis; it happens when the clinician clicks
  // "Export PDF" / "Export Word". The result is attached in-memory (not stored).
  r.name_metadata = await runOcrAtExport(row);

  const gxTitle = clinic.clinic_name;
  const gxAddress = clinic.clinic_address;
  const gxContact = `${clinic.clinic_email}  ·  ${clinic.clinic_phone}`;

  const children = [
    new Paragraph({ text: gxTitle, heading: HeadingLevel.TITLE }),
    new Paragraph({ text: gxAddress }),
    new Paragraph({ text: gxContact, spacing: { after: 200 } }),
    new Paragraph({ text: 'Gait Laboratory Report', heading: HeadingLevel.HEADING_2 }),
    new Paragraph({ text: `Generated ${new Date().toLocaleString()}  ·  Confidential — for clinical use only`, spacing: { after: 300 } }),

    new Paragraph({ text: 'Patient', heading: HeadingLevel.HEADING_1 }),
    new Paragraph({ text: `Child: ${user.child_name}` }),
    new Paragraph({ text: `Guardian: ${user.guardian_name}` }),
    new Paragraph({ text: `Diagnosis: ${user.diagnosis || 'Not specified'}` }),
    new Paragraph({ text: `Session #${row.id}  ·  Status: ${row.status}` }),
    new Paragraph({ text: `Pediatric target: ${r.patient || user.child_name}`, spacing: { after: 200 } }),
  ];

  // Demographics block (run.txt section 1)
  const demoParts = [];
  if (row.age_years != null) demoParts.push(`Age: ${row.age_years} years`);
  if (row.gender) demoParts.push(`Gender: ${row.gender}`);
  if (row.body_mass_kg != null) demoParts.push(`Body mass: ${row.body_mass_kg} kg`);
  if (row.height_cm != null) demoParts.push(`Height: ${row.height_cm} cm`);
  if (demoParts.length) children.push(new Paragraph({ text: `Demographics: ${demoParts.join('  ·  ')}`, color: '333333', size: 18 }));
  if (row.clinician_name) children.push(new Paragraph({ text: `Assessing clinician: ${row.clinician_name}`, color: '333333', size: 18, spacing: { after: 120 } }));

  // run.txt §1 — patient-name overlay verification result (on-demand OCR).
  if (r.name_metadata && r.name_metadata.status) {
    const nm = r.name_metadata;
    const ok = nm.status === 'verified';
    const stateLabel = ok
      ? `VERIFIED — "${nm.matched_name || ''}" read from the recording overlay`
      : (nm.status === 'deferred'
          ? 'PENDING — name overlay is verified when the report is exported'
          : (nm.status === 'ocr_unavailable' ? 'OCR UNAVAILABLE on this server' : 'UNVERIFIED — OCR mismatch'));
    children.push(new Paragraph({
      text: `Patient name overlay (OCR): ${stateLabel}. ${nm.reason || ''}`,
      bold: true,
      color: ok ? '2F7A4D' : (nm.status === 'deferred' ? '8a5a00' : 'CC0000'),
      size: 18,
      spacing: { after: 200 }
    }));
  }

  children.push(
    new Paragraph({ text: `Capture mode: ${(((r && r.input && r.input.routing) || 'single-plane') === 'combined-dual-view') ? 'Combined Dual-Plane Video (simultaneous frontal & sagittal capture)' : (((r && r.input && r.input.routing) || 'single-plane') === 'dual-view-3d' ? 'Separate Frontal + Sagittal recordings' : 'Single-plane recording')}`, color: '666666', size: 18 }),
    new Paragraph({ text: `Analysis engine: ${r.mode === 'rejected' ? 'Blocked — no metrics generated' : 'BRC Biomechanical Engine'} — ${r.diagnostic_note}`, color: 'CC0000', size: 18 }),
  );

  // ---- Beginner-Friendly Summary (Easy Read) — plain language, first ----
  if (r.beginner_summary) {
    const bs = r.beginner_summary || {};
    children.push(
      new Paragraph({ text: 'Beginner-Friendly Summary (Easy Read)', heading: HeadingLevel.HEADING_1 }),
      new Paragraph({ text: bs.headline || '', bold: true, color: '1E3C82', spacing: { after: 120 } }),
    );
    if (bs.walking) children.push(new Paragraph({ text: bs.walking, spacing: { after: 160 } }));
    (bs.what_we_found || []).forEach(f => {
      children.push(new Paragraph({ text: `• ${f.title}`, bold: true, color: '258DC1', spacing: { after: 40 } }));
      if (f.text) children.push(new Paragraph({ text: f.text, indent: { left: 360 }, spacing: { after: 120 } }));
    });
    (bs.measurements || []).forEach(m => children.push(new Paragraph({ text: `• ${m}`, bullet: { level: 0 } })));
    if ((bs.recommended_next || []).length) {
      children.push(new Paragraph({ text: 'What to do next:', bold: true, color: '2F7A4D', spacing: { before: 160, after: 80 } }));
      (bs.recommended_next || []).forEach(m => children.push(new Paragraph({ text: `• ${m}`, bullet: { level: 0 } })));
    }
    if (bs.confidence_note) children.push(new Paragraph({ text: bs.confidence_note, italics: true, color: '666666', size: 16, spacing: { before: 160, after: 300 } }));
  }

  // 2e.txt — strict rejection: emit a clean notice document instead of empty tables.
  if (r.mode === 'rejected') {
    children.push(
      new Paragraph({ text: 'Analysis Blocked — No Metrics Generated', heading: HeadingLevel.HEADING_1, spacing: { before: 300 } }),
      new Paragraph({ text: (r.gait_validation && r.gait_validation.message) || NO_GENUINE_GAIT_MSG, bold: true, color: 'CC0000', spacing: { after: 200 } }),
      new Paragraph({ text: 'No clinical metrics (phases, deformities, ROM, prescriptions) were produced from this capture. To proceed, please re-upload a clear video of the patient walking straight in the specified plane and re-run the analysis.', spacing: { after: 120 } }),
      ...((r.gait_validation && r.gait_validation.reasons) || []).map(rs => new Paragraph({ text: `• ${rs}`, bullet: { level: 0 } }))
    );
    const docxRej = new Document({
      sections: [{
        children,
        footers: {
          default: new Footer({
            children: [new Paragraph({
              alignment: AlignmentType.CENTER,
              children: [new TextRun({ text: `${gxTitle}  ·  ${gxAddress}`, size: 16, color: '9FC3E0' })]
            })]
          })
        }
      }]
    });
    const bufR = await Packer.toBuffer(docxRej);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="gait-report-${row.id}.docx"`);
    res.send(bufR);
    return;
  }

  // Gait Cycle Summary is only emitted for genuinely analyzed (non-rejected) reports.
  children.push(
    new Paragraph({ text: 'Gait Cycle Summary', heading: HeadingLevel.HEADING_1 })
  );
  if (typeof r.cycle.stance_pct === 'number' && Number.isFinite(r.cycle.stance_pct)) {
    children.push(new Paragraph({ text: `Stance: ${r.cycle.stance_pct}%   Swing: ${r.cycle.swing_pct}%` }));
    children.push(new Paragraph({ text: `Gait type: ${r.cycle.running ? 'Running' : 'Walking'}${r.cycle.running && typeof r.cycle.flight_phase_frac === 'number' ? `  ·  Flight phase (double float) ${Math.round(r.cycle.flight_phase_frac * 100)}% of cycle` : ''}`, color: '1E3C82', size: 20, spacing: { after: 120 } }));
    children.push(new Paragraph({ text: `${r.cycle.running ? 'Running cadence' : 'Cadence'}: ${r.cycle.cadence_cycles_per_second} cycles/sec  ·  Cycle duration: ${r.cycle.cycle_seconds}s  ·  Stance/Swing: ${r.cycle.stance_pct}% / ${r.cycle.swing_pct}%` }));
    children.push(new Paragraph({ text: `Normative stance reference band: ${(r.cycle.stance_norm_band || [58, 62]).join('–')}%. ${r.summary && r.summary.stance_status ? `Stance is ${r.summary.stance_status}.` : ''}`, color: '666666', size: 16, spacing: { after: 300 } }));
  } else {
    children.push(new Paragraph({ text: (r.summary && r.summary.stance_status) || 'Temporal gait timing was not measured — no valid sagittal-plane cycle was captured.', color: '666666', size: 16, spacing: { after: 300 } }));
  }
  if (r.cycle && r.cycle.playback_note) {
    children.push(new Paragraph({ text: r.cycle.playback_note, color: '258DC1', size: 16, spacing: { after: 300 } }));
  }

  if (r.summary) {
    children.push(new Paragraph({ text: 'Clinical Impression', heading: HeadingLevel.HEADING_1 }));
    children.push(new Paragraph({ text: r.summary.headline, bold: true, color: '1E3C82' }));
    children.push(new Paragraph({ text: r.summary.narrative, spacing: { after: 120 } }));
    children.push(new Paragraph({ text: 'Priority focus areas:', bold: true, color: '258DC1' }));
    (r.focus_areas || []).forEach(f => children.push(new Paragraph({ text: `• ${f}`, bullet: { level: 0 } })));
    if (r.summary.recommendation) {
      children.push(new Paragraph({ text: r.summary.recommendation, color: '2F7A4D', spacing: { before: 120 } }));
    }
  }

  const phaseRows = [new TableRow({ children: ['Phase', 'Type', '% of cycle', 'Δ vs norm', 'Norm range', 'Duration', 'Status'].map(h => new TableCell({ children: [new Paragraph({ text: h, bold: true })] })) })];
  r.cycle.phases.forEach(p => phaseRows.push(new TableRow({
    children: [p.name, p.type, `${p.pct_of_cycle}%`, `${p.pct_delta > 0 ? '+' : ''}${p.pct_delta}%`,
      Array.isArray(p.norm_range_pct) ? `${p.norm_range_pct[0]}–${p.norm_range_pct[1]}%` : '',
      `${p.duration_ms} ms`, p.flag === 'none' ? 'Normal' : `${p.classification || p.flag}${p.severity ? ' · ' + p.severity : ''}`]
      .map(v => new TableCell({ children: [new Paragraph(String(v))] }))
  })));
  children.push(new Paragraph({ text: 'Stance & Swing Sub-Phases', heading: HeadingLevel.HEADING_1 }));
  children.push(new Table({ rows: phaseRows, width: { size: 100, type: WidthType.PERCENTAGE } }));

  if (r.cycle.anomalies.length) {
    children.push(new Paragraph({ text: 'Detected Anomalies', heading: HeadingLevel.HEADING_1 }));
    r.cycle.anomalies.forEach(a => children.push(new Paragraph({
      text: `[${a.severity.toUpperCase()}] ${a.phase_name} — ${a.type}: ${a.description}`,
      color: a.severity === 'major' ? 'CC0000' : 'AA7C00'
    })));
  }

  children.push(new Paragraph({ text: 'Multi-Planar Deformity & Biomechanical Analysis', heading: HeadingLevel.HEADING_1 }));
  children.push(new Paragraph({ text: 'Frontal plane:', bold: true }));
  (r.profile.frontal.deformities || []).forEach(d => children.push(new Paragraph({ text: `• ${d.name} (${d.magnitude}${d.category ? ' · ' + d.category : ''}) — ${d.description}`, bullet: { level: 0 } })));
  children.push(new Paragraph({ text: 'Sagittal plane:', bold: true, spacing: { before: 200 } }));
  (r.profile.sagittal.deformities || []).forEach(d => children.push(new Paragraph({ text: `• ${d.name} (${d.magnitude}${d.category ? ' · ' + d.category : ''}) — ${d.description}`, bullet: { level: 0 } })));
  children.push(new Paragraph({ text: 'Rotational / transverse plane:', bold: true, spacing: { before: 200 } }));
  (r.profile.rotational ? r.profile.rotational.deformities || [] : []).forEach(d => children.push(new Paragraph({ text: `• ${d.name} (${d.magnitude}${d.category ? ' · ' + d.category : ''}) — ${d.description}`, bullet: { level: 0 } })));
  children.push(new Paragraph({ text: 'Findings classified as structural (bony/alignment), functional (timing/muscle-driven) or rotational (transverse-plane torsion).', color: '666666', size: 16 }));

  children.push(new Paragraph({ text: 'Joint Kinematics (Range of Motion)', heading: HeadingLevel.HEADING_1 }));
  const romRows = [new TableRow({ children: ['Joint', 'Movement', 'Reference ROM', 'Observed'].map(h => new TableCell({ children: [new Paragraph({ text: h, bold: true })] })) })];
  r.kinematics.rom.forEach(x => romRows.push(new TableRow({ children: [x.joint, x.movement, x.normal, x.observed].map(v => new TableCell({ children: [new Paragraph(String(v))] })) })));
  children.push(new Table({ rows: romRows, width: { size: 100, type: WidthType.PERCENTAGE } }));

  // Anthropometry (run.txt section 2)
  if (r.anthropometry) {
    children.push(new Paragraph({ text: 'Anthropometric Measurements', heading: HeadingLevel.HEADING_1, spacing: { before: 300 } }));
    const anthro = r.anthropometry;
    if (anthro.estimated_segments) {
      children.push(new Paragraph({ text: 'Estimated segment lengths (from video):', bold: true }));
      const segRows = [new TableRow({ children: ['Segment', 'Left', 'Right', 'SI'].map(h => new TableCell({ children: [new Paragraph({ text: h, bold: true })] })) })];
      Object.entries(anthro.estimated_segments).forEach(([k, v]) => {
        if (v && typeof v === 'object') {
          segRows.push(new TableRow({ children: [k.replace(/_/g, ' '), v.left != null ? `${v.left} cm` : '—', v.right != null ? `${v.right} cm` : '—', v.symmetry_index != null ? `${v.symmetry_index}%` : '—'].map(v => new TableCell({ children: [new Paragraph(String(v))] })) }));
        }
      });
      if (segRows.length > 1) children.push(new Table({ rows: segRows, width: { size: 100, type: WidthType.PERCENTAGE } }));
    }
    if (anthro.body_proportions) {
      const bp = anthro.body_proportions;
      if (bp.height_to_sitting != null) children.push(new Paragraph({ text: `Height-to-sitting ratio: ${bp.height_to_sitting}`, size: 18 }));
      if (bp.leg_length_to_height != null) children.push(new Paragraph({ text: `Leg length / height: ${bp.leg_length_to_height}`, size: 18 }));
    }
    if (anthro.confidence) {
      children.push(new Paragraph({ text: `Measurement confidence: ${anthro.confidence}${anthro.confidence_note ? ' — ' + anthro.confidence_note : ''}`, color: '666666', size: 16, spacing: { before: 120 } }));
    }
  }

  children.push(new Paragraph({ text: 'Muscle Involvement Map', heading: HeadingLevel.HEADING_1 }));
  children.push(new Paragraph({ text: 'Overactive / overworked:', bold: true, color: 'CC0000' }));
  (r.muscles.overactive || []).forEach(m => children.push(new Paragraph({ text: `• ${m.name} — ${m.role}`, bullet: { level: 0 } })));
  children.push(new Paragraph({ text: 'Weak / under-active:', bold: true, color: '1E3C82', spacing: { before: 200 } }));
  (r.muscles.weak || []).forEach(m => children.push(new Paragraph({ text: `• ${m.name} — ${m.role}`, bullet: { level: 0 } })));
  children.push(new Paragraph({ text: 'Deformity ↔ muscle linkage:', bold: true, color: '2F7A4D', spacing: { before: 200 } }));
  (r.muscles.anomaly_links || []).forEach(l => {
    children.push(new Paragraph({ text: `• ${l.anomaly}${l.matched ? '' : ' (pattern context)'}`, bold: true, bullet: { level: 0 } }));
    (l.muscles || []).forEach(mu => children.push(new Paragraph({
      text: `   ${mu.name} [${mu.status}] — ${mu.role}. ${mu.implication}`,
      color: mu.status === 'overactive' ? 'CC0000' : '1E3C82', size: 18, indent: { left: 360 }
    })));
    if (l.compensation) children.push(new Paragraph({ text: `   Compensation: ${l.compensation}`, color: '666666', size: 16, indent: { left: 360 } }));
    if (l.localized_damage) children.push(new Paragraph({ text: `   Localized structural burden: ${l.localized_damage}`, color: '666666', size: 16, indent: { left: 360 } }));
  });
  (r.muscles.structural_weaknesses || []).forEach(w => children.push(new Paragraph({
    text: `• Structural weakness — ${w.structure} (${w.category}), linked to ${w.related_deformity}. ${w.note}`,
    bullet: { level: 0 }, size: 18
  })));
  (r.muscles.notes || []).forEach(n => children.push(new Paragraph({ text: `- ${n}`, color: '666666', size: 16 })));

  children.push(new Paragraph({ text: 'Targeted Clinical Prescriptions', heading: HeadingLevel.HEADING_1 }));
  if (r.prescriptions.rationale) {
    children.push(new Paragraph({ text: r.prescriptions.rationale, color: '2F7A4D', spacing: { after: 120 } }));
  }
  children.push(new Paragraph({ text: 'Exercise routine', bold: true }));
  const exRows = [new TableRow({ children: ['Exercise', 'Details', 'Rationale'].map(h => new TableCell({ children: [new Paragraph({ text: h, bold: true })] })) })];
  r.prescriptions.exercises.forEach(e => {
    const detailParts = [];
    if (e.sets) detailParts.push(`${e.sets} sets`);
    if (e.reps) detailParts.push(`${e.reps} reps`);
    if (e.hold_seconds) detailParts.push(`${e.hold_seconds}s hold`);
    if (e.rest_seconds) detailParts.push(`${e.rest_seconds}s rest`);
    const detail = detailParts.length ? detailParts.join(', ') : e.frequency;
    exRows.push(new TableRow({ children: [e.name, detail, e.reason].map(v => new TableCell({ children: [new Paragraph(String(v))] })) }));
  });
  children.push(new Table({ rows: exRows, width: { size: 100, type: WidthType.PERCENTAGE } }));
  (r.prescriptions.exercises || []).forEach(e => {
    if (e.references && e.references.length) {
      children.push(new Paragraph({ text: `Evidence: ${e.references.map(refShort).join('; ')}`, color: '258DC1', size: 16, align: AlignmentType.RIGHT }));
    }
  });
  if (r.prescriptions.orthotics && r.prescriptions.orthotics.length) {
    children.push(new Paragraph({ text: 'Orthotic recommendations', bold: true, spacing: { before: 200 } }));
    r.prescriptions.orthotics.forEach(o => {
      children.push(new Paragraph({ text: `• ${o.component} — ${o.reason}`, bullet: { level: 0 } }));
      if (o.references && o.references.length) {
        children.push(new Paragraph({ text: `Evidence: ${o.references.map(refShort).join('; ')}`, color: '258DC1', size: 16, align: AlignmentType.RIGHT }));
      }
    });
  }
  if (r.prescriptions.prosthetics && r.prescriptions.prosthetics.length) {
    children.push(new Paragraph({ text: 'Prosthetic component recommendations', bold: true, spacing: { before: 200 } }));
    r.prescriptions.prosthetics.forEach(o => {
      children.push(new Paragraph({ text: `• ${o.component} — ${o.reason}`, bullet: { level: 0 } }));
      if (o.references && o.references.length) {
        children.push(new Paragraph({ text: `Evidence: ${o.references.map(refShort).join('; ')}`, color: '258DC1', size: 16, align: AlignmentType.RIGHT }));
      }
    });
  }
  (r.prescriptions.guidance || []).forEach(g => children.push(new Paragraph({ text: `- ${g}`, color: '666666' })));

  if (r.prediction) {
    const pr = r.prediction;
    children.push(new Paragraph({ text: 'Predictive Progression & Prognostic Model', heading: HeadingLevel.HEADING_1 }));
    children.push(new Paragraph({ text: `Projected risk severity: ${pr.severity}${(pr.patterns || []).length ? '  ·  Patterns: ' + pr.patterns.join(', ') : ''}`, bold: true, color: pr.severity === 'elevated' ? 'CC0000' : (pr.severity === 'moderately elevated' ? 'AA7C00' : '2F7A4D') }));
    if (pr.measured_note) children.push(new Paragraph({ text: `Measurements: ${pr.measured_note}`, color: '666666', size: 18 }));
    children.push(new Paragraph({ text: 'Joint degeneration risk projections:', bold: true, spacing: { before: 200 } }));
    (pr.joint_degeneration_risk || []).forEach(item => children.push(new Paragraph({ text: `• ${item.joint} — ${item.risk_level} (${item.horizon}) — ${item.mechanism}`, bullet: { level: 0 }, size: 18 })));
    if ((pr.compensatory_pathologies || []).length) {
      children.push(new Paragraph({ text: 'Projected secondary / compensatory pathologies:', bold: true, spacing: { before: 200 } }));
      pr.compensatory_pathologies.forEach(p => children.push(new Paragraph({ text: `• ${p.pathology} — ${p.likelihood} (${p.timeline}) — ${p.mechanism}`, bullet: { level: 0 }, size: 18 })));
    }
    if (pr.summary) children.push(new Paragraph({ text: pr.summary, size: 18, spacing: { before: 200 } }));
    if (pr.recommendation) children.push(new Paragraph({ text: pr.recommendation, color: '2F7A4D', size: 18 }));
    if (pr.disclaimer) children.push(new Paragraph({ text: pr.disclaimer, color: '666666', italics: true, size: 16 }));

    // Recovery Timeframe (run.txt section 4)
    if (pr.recovery_timeframe) {
      const rt = pr.recovery_timeframe;
      children.push(new Paragraph({ text: 'Recovery Timeframe & Rehabilitation Pathway', heading: HeadingLevel.HEADING_1, spacing: { before: 300 } }));
      children.push(new Paragraph({ text: rt.phase_label, bold: true, color: '1E3C82' }));
      children.push(new Paragraph({ text: `Estimated duration: ${rt.estimated_weeks_low}–${rt.estimated_weeks_high} weeks`, spacing: { before: 120 } }));
      children.push(new Paragraph({ text: 'Milestone targets:', bold: true, color: '258DC1', spacing: { before: 120 } }));
      (rt.milestones || []).forEach(m => {
        children.push(new Paragraph({ text: `Week ${m.week}: ${m.target}`, bullet: { level: 0 }, size: 18 }));
        children.push(new Paragraph({ text: `  Metric: ${m.metric}`, indent: { left: 360 }, color: '666666', size: 16 }));
      });
      children.push(new Paragraph({ text: rt.reassessment_schedule, color: '666666', size: 16, spacing: { before: 120 } }));
      if (rt.note) children.push(new Paragraph({ text: rt.note, italics: true, color: '666666', size: 16, spacing: { before: 80 } }));
    }

    // Prognostic KPIs (run.txt section 4)
    if (pr.prognostic_kpis && pr.prognostic_kpis.length) {
      children.push(new Paragraph({ text: 'Prognostic KPIs — Therapy Progression Targets', heading: HeadingLevel.HEADING_1, spacing: { before: 300 } }));
      pr.prognostic_kpis.forEach(cat => {
        children.push(new Paragraph({ text: cat.category, bold: true, color: '1E3C82', spacing: { before: 160 } }));
        cat.targets.forEach(t => {
          children.push(new Paragraph({ text: `• ${t.metric}`, bullet: { level: 0 }, bold: true, size: 18 }));
          children.push(new Paragraph({ text: `  Baseline target: ${t.baseline_target}`, indent: { left: 360 }, color: '258DC1', size: 16 }));
          children.push(new Paragraph({ text: `  Milestone: ${t.milestone_target}`, indent: { left: 360 }, color: '2F7A4D', size: 16 }));
        });
      });
    }
  }

  if (r.cv3d && r.cv3d.status === 'ok') {
    const c3 = r.cv3d;
    const tri = Boolean((c3.calibration || {}).third_view_used);
    children.push(new Paragraph({ text: tri ? 'Multi-View 3D Kinematics (Tri-View Triangulation)' : 'Multi-View 3D Kinematics (Dual-Plane Triangulation)', heading: HeadingLevel.HEADING_1 }));
    children.push(new Paragraph({ text: `Engine: ${c3.engine === 'brc-multiview-3d' ? 'BRC multi-view 3D (calibrated)' : 'BRC orthographic least-squares triangulation'}  ·  ${tri ? 'tri-view' : 'dual-view'}  ·  Samples: ${c3.samples}  ·  Units: ${(c3.calibration || {}).units || 'normalized'}  ·  Cameras: ${tri ? 'frontal + sagittal + third (Coronal)' : 'frontal + sagittal'}`, color: '666666', size: 16, spacing: { after: 200 } }));
    const angleNames3d = { hip_flex: 'Hip flexion', knee_flex: 'Knee flexion', ankle_angle: 'Ankle angle', shoulder_flex: 'Shoulder flexion', elbow_flex: 'Elbow flexion', knee_valgus: 'Knee frontal deviation' };
    const a3Rows = [new TableRow({ children: ['3D Joint Angle', 'Left (median)', 'Right (median)'].map(h => new TableCell({ children: [new Paragraph({ text: h, bold: true })] })) })];
    Object.keys(angleNames3d).forEach(k => {
      if (c3.joint_angles_3d && c3.joint_angles_3d[k]) {
        a3Rows.push(new TableRow({ children: [angleNames3d[k], c3.joint_angles_3d[k].L == null ? '—' : `${c3.joint_angles_3d[k].L}°`, c3.joint_angles_3d[k].R == null ? '—' : `${c3.joint_angles_3d[k].R}°`].map(v => new TableCell({ children: [new Paragraph(String(v))] })) }));
      }
    });
    children.push(new Table({ rows: a3Rows, width: { size: 100, type: WidthType.PERCENTAGE } }));
    if (c3.segment_lengths) {
      children.push(new Paragraph({ text: 'Normalized segment lengths (torso heights):', bold: true, spacing: { before: 200 } }));
      const segRows3d = [new TableRow({ children: ['Segment', 'Length'].map(h => new TableCell({ children: [new Paragraph({ text: h, bold: true })] })) })];
      Object.keys(c3.segment_lengths).forEach(k => segRows3d.push(new TableRow({ children: [k.replace(/_/g, ' '), String(c3.segment_lengths[k])].map(v => new TableCell({ children: [new Paragraph(v)] })) })));
      children.push(new Table({ rows: segRows3d, width: { size: 60, type: WidthType.PERCENTAGE } }));
    }
    if (c3.symmetry) {
      const si = (v) => (v == null ? 'n/a' : v + '%');
      children.push(new Paragraph({ text: `Symmetry indices — knee flexion ${si(c3.symmetry.knee_flex_si)} · hip flexion ${si(c3.symmetry.hip_flex_si)} · thigh length ${si(c3.symmetry.thigh_si)} · shank length ${si(c3.symmetry.shank_si)}`, color: '666666', size: 16, spacing: { before: 120 } }));
    }
    const imgRun = (rel, maxW) => {
      if (!rel) return null;
      const abs = resolveUploadRel(rel);
      if (!abs || !fs.existsSync(abs)) return null;
      try {
        const buf = fs.readFileSync(abs);
        let type = 'png', w = null, h = null;
        if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50) { // PNG signature
          w = buf.readUInt32BE(16);
          h = buf.readUInt32BE(20);
        } else if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
          type = 'jpg';
        }
        const naturalW = w || maxW;
        const naturalH = h || Math.round(maxW * 0.6);
        const scale = Math.min(1, maxW / naturalW);
        return new ImageRun({
          data: buf, type,
          transformation: { width: Math.round(naturalW * scale), height: Math.round(naturalH * scale) }
        });
      } catch (e) { return null; }
    };
    if (c3.plots && c3.plots.sim3d_anatomy) {
      children.push(new Paragraph({ text: `Reconstructed anatomy (${tri ? 'frontal + sagittal + third (Coronal)' : 'frontal + sagittal'} projections):`, bold: true, spacing: { before: 240 } }));
      const img = imgRun(c3.plots.sim3d_anatomy, 620);
      if (img) children.push(new Paragraph({ children: [img] }));
      else children.push(new Paragraph({ text: '(3D anatomy graph unavailable for embedding)', color: '666666', size: 16 }));
    }
    if (c3.plots && c3.plots.sim3d_angles) {
      children.push(new Paragraph({ text: '3D joint-angle kinematics curves (multi-view reconstruction):', bold: true, spacing: { before: 240 } }));
      const img = imgRun(c3.plots.sim3d_angles, 620);
      if (img) children.push(new Paragraph({ children: [img] }));
      else children.push(new Paragraph({ text: '(3D angle graph unavailable for embedding)', color: '666666', size: 16 }));
    }
    if (c3.anatomical_note) children.push(new Paragraph({ text: c3.anatomical_note, color: '666666', italics: true, size: 16, spacing: { before: 120 } }));
  }

  // Clinical sign-off block (run.txt section 5)
  children.push(new Paragraph({ text: 'Clinical Sign-Off', heading: HeadingLevel.HEADING_1, spacing: { before: 400 } }));
  children.push(new Paragraph({ text: `Patient: ${user.child_name}`, bold: true }));
  if (row.age_years != null || row.gender) {
    children.push(new Paragraph({ text: `Demographics: ${[row.age_years != null ? `${row.age_years} years` : '', row.gender || '', row.body_mass_kg != null ? `${row.body_mass_kg} kg` : ''].filter(Boolean).join('  ·  ')}`, size: 18 }));
  }
  children.push(new Paragraph({ text: `Session: #${row.id}  ·  Analysis: ${r.mode === 'rejected' ? 'Blocked' : 'BRC Biomechanical Engine'}`, size: 18, spacing: { after: 200 } }));
  children.push(new Paragraph({ text: 'Assessing clinician: ___________________________', spacing: { before: 120 } }));
  children.push(new Paragraph({ text: 'Signature: ___________________________   Date: ____________', spacing: { before: 120, after: 200 } }));
  children.push(new Paragraph({ text: 'This report is generated by the BRC Biomechanical Engine and must be reviewed and signed by a qualified clinician.', italics: true, color: '666666', size: 16 }));

  const refSections = r.reference_sections || { core: r.references || [], supporting: [] };
  children.push(new Paragraph({ text: 'References', heading: HeadingLevel.HEADING_1 }));
  [
    ['core', 'Core gait-analysis references'],
    ['deformity', 'Evidence — deformity & alignment detection'],
    ['exercise', 'Evidence — exercise rehabilitation'],
    ['orthotic_prosthetic', 'Evidence — orthotic / prosthetic intervention'],
    ['prognosis', 'Evidence — progression & prognosis'],
    ['supporting', 'Supporting literature matched to findings'],
  ].forEach(([key, heading]) => {
    const list = key === 'core' ? (refSections.core || []) : (refSections[key] || []);
    if (!list.length) return;
    children.push(new Paragraph({ text: heading, heading: HeadingLevel.HEADING_2, spacing: { before: 200 } }));
    list.forEach(ref => {
      children.push(new Paragraph({
        text: `${ref.id}. ${ref.authors} (${ref.year}). ${ref.title}. ${ref.venue}.`,
        size: 18
      }));
      if (ref.topics && ref.topics.length) {
        children.push(new Paragraph({
          text: `Relevant to: ${ref.topics.map(t => t.replace(/-/g, ' ')).join(', ')}`,
          color: '258DC1', size: 16, indent: { left: 360 }
        }));
      }
    });
  });

  // Functional assessment appendix (clinical scales × gait)
  const reportScales = loadScalesForReport(row.user_id);
  const reportCrosscheck = crosscheckBbsGait(reportScales, r);
  if (reportScales.bbs || reportScales.tug || reportScales.gmfcs || reportScales.oga || reportCrosscheck.length) {
    children.push(new Paragraph({ text: 'Functional Assessment (Clinical Scales)', heading: HeadingLevel.HEADING_1, spacing: { before: 400 } }));
    children.push(new Paragraph({ text: 'Scores by the offline BRC scale engines. Interpretations carry their evidence citations from docs/references/SOURCES.md. Screening indicators only — not diagnoses.', italics: true, color: '666666', size: 16 }));
    if (reportScales.bbs && reportScales.bbs.payload) {
      const p = (reportScales.bbs.payload);
      const converted = [new Paragraph({ text: `Berg Balance Scale — ${p.total_score}/56 (${p.items_recorded}/${p.items_expected} items scored)`, heading: HeadingLevel.HEADING_2, spacing: { before: 200 } })];
      if (p.mobility_band) {
        converted.push(new Paragraph({ text: `Mobility band: ${p.mobility_band.level} — ${p.mobility_band.recommendation}`, size: 18 }));
      }
      if (p.fall_screen) {
        converted.push(new Paragraph({ text: `Fall screen (${p.fall_screen.population_label}): ${p.fall_screen.risk_flagged ? 'FLAGGED' : 'not flagged'} at cutoff ${p.fall_screen.cutoff}.`, size: 18, color: p.fall_screen.risk_flagged ? 'B3452F' : '2F7A4D' }));
        converted.push(new Paragraph({ text: p.fall_screen.text, color: '666666', size: 16 }));
      }
      children.push(...converted);
    }
    if (reportScales.tug && reportScales.tug.payload) {
      const p = reportScales.tug.payload;
      children.push(new Paragraph({ text: `Timed Up & Go — ${p.seconds} s (${p.population_label})`, heading: HeadingLevel.HEADING_2, spacing: { before: 200 } }));
      if (p.interpretation) {
        children.push(new Paragraph({ text: p.interpretation.text, size: 18, color: p.fallback_risk ? 'B3452F' : '2F7A4D' }));
      }
      if ((p.observations || []).length) children.push(new Paragraph({ text: `Observations: ${p.observations.join(', ')}`, color: '666666', size: 16 }));
    }
    if (reportScales.gmfcs && reportScales.gmfcs.payload && reportScales.gmfcs.payload.level) {
      const p = reportScales.gmfcs.payload;
      children.push(new Paragraph({ text: `GMFCS-E&R — Level ${p.level} (${p.age_label || 'age band not recorded'})`, heading: HeadingLevel.HEADING_2, spacing: { before: 200 } }));
      children.push(new Paragraph({ text: String(p.interpretation.text), size: 18 }));
      children.push(new Paragraph({ text: 'Classification of usual performance — distinguishes functional limitation, not diagnosis; not a change-over-time outcome measure (Palisano 1997/2007, CanChild McMaster).', color: '666666', size: 16 }));
    }
    if (reportScales.oga && reportScales.oga.payload) {
      const p = reportScales.oga.payload;
      const n = (p.entries || []).length;
      children.push(new Paragraph({ text: `Observational Gait Analysis (Rancho Los Amigos) — ${n} deviation${n === 1 ? '' : 's'} recorded`, heading: HeadingLevel.HEADING_2, spacing: { before: 200 } }));
      (p.entries || []).slice(0, 12).forEach(e => {
        children.push(new Paragraph({ text: `• ${e.segment} — ${e.deviation} (${e.phase}, ${e.side})`, size: 18, indent: { left: 240 } }));
      });
      if (n > 12) children.push(new Paragraph({ text: `…and ${n - 12} more.`, color: '666666', size: 16 }));
    }
    if (reportCrosscheck.length) {
      children.push(new Paragraph({ text: 'BBS × Gait Analysis Cross-Validation', heading: HeadingLevel.HEADING_2, spacing: { before: 240 } }));
      children.push(new Paragraph({ text: 'Predicted deficits from low-scoring BBS items (≤2) are checked against objective engine measurements for this session. A cross-check is assessed only when both sides exist; otherwise it is withheld (zero-assumption protocol).', italics: true, color: '666666', size: 16 }));
      reportCrosscheck.forEach(c => {
        children.push(new Paragraph({ text: `Item ${c.bbs_item} — ${c.task} (${c.bbs_score}/4): ${c.predicted_deficit}`, bold: true, spacing: { before: 120 } }));
        if (c.status === 'assessed') {
          c.observed_params.forEach(o => {
            children.push(new Paragraph({ text: `${o.param} = ${o.value != null ? o.value : 'unmeasured'}`, color: o.value != null ? '2F7A4D' : '666666', size: 16, indent: { left: 360 } }));
          });
        } else {
          children.push(new Paragraph({ text: `UNASSESSED — ${c.reason}`, color: 'B3452F', size: 16, indent: { left: 360 } }));
        }
      });
    }
  }
  const doc = new Document({
    sections: [{
      children,
      footers: {
        default: new Footer({
          children: [new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [new TextRun({ text: `${gxTitle}  ·  ${gxAddress}`, size: 16, color: '9FC3E0' })]
          })]
        })
      }
    }]
  });

  const buffer = await Packer.toBuffer(doc);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.setHeader('Content-Disposition', `attachment; filename="gait-report-${row.id}.docx"`);
  res.send(buffer);
});

// ---- PDF drawing helpers ----
// Compact per-prescription citation string, e.g. "[S12] Fukuda (2010)".
function refShort(ref) {
  if (!ref) return '';
  const first = String(ref.authors || '').replace(/ et al.*$/, '').split(' ').slice(0, 2).join(' ');
  return `[${ref.id}] ${first} (${ref.year})`;
}

function drawTable(doc, headers, rows, colWidths, startY) {
  const startX = 50;
  const totalWidth = colWidths.reduce((a, b) => a + b, 0);
  let y = startY;
  const rowH = 20;

  if (y + 22 > doc.page.height - 60) { doc.addPage(); y = 50; }
  doc.rect(startX, y, totalWidth, 22).fill('#1E3C82');
  let x = startX;
  headers.forEach((h, i) => {
    doc.fillColor('#FFFFFF').fontSize(8.5).text(h, x + 5, y + 6, { width: colWidths[i] - 10, height: 14, ellipsis: true, lineBreak: false });
    x += colWidths[i];
  });
  y += 22;

  rows.forEach((row, rIdx) => {
    if (y + rowH > doc.page.height - 60) { doc.addPage(); y = 50; }
    doc.rect(startX, y, totalWidth, rowH).fill(rIdx % 2 === 0 ? '#FBF8F2' : '#F0F7FC');
    x = startX;
    row.forEach((cell, i) => {
      doc.fillColor('#232520').fontSize(8).text(String(cell == null || cell === '' ? '—' : cell), x + 5, y + 6, {
        width: colWidths[i] - 10, height: 14, ellipsis: true, lineBreak: false
      });
      x += colWidths[i];
    });
    y += rowH;
  });
  doc.x = startX;
  return y + 12;
}

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

module.exports = router;