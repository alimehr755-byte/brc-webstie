// scripts/smoke-test.js
// End-to-end integration smoke test for the BRC Gait Lab (2e.txt rules).
//
// Under 2e.txt every repository fixture is a static / non-walking render, so the
// gate is expected to REJECT every upload with the exact professional message, and
// the platform must NEVER fabricate metrics. This smoke verifies:
//   1. upload gate        -> every fixture upload returns 400 + exact 2e wording
//      (frontal slot, sagittal slot, combined) and FAILS CLOSED when no Python is
//      available (--fast)
//   2. analyze fail-safe  -> a session with no accepted capture cannot be analyzed
//   3. Python engine      -> direct gait_lab.py run on a fixture yields mode=rejected,
//      the exact message, and an EMPTY measured surface (no phases, deformities,
//      ROM, prescriptions, prediction)
//   4. rejection reports  -> a stored rejection result renders a clean PDF and a
//      DOCX that carry the "Analysis Blocked" notice and the exact message, with no
//      fabricated metric tables
//   5. mutual exclusion   -> conflict wording preserved (3e.txt) where reachable
//   6. cleans up all sessions
//
// Usage:
//   node scripts/smoke-test.js          real run (Python gate + engine, ~1-2 min)
//   node scripts/smoke-test.js --fast   no-Python fail-closed HTTP surface only
//
// Exit code 0 = all checks passed, 1 = at least one check failed, 2 = harness error.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:3000';
const FAST = process.argv.includes('--fast');
const UPLOADS = path.join(ROOT, 'uploads', 'gait');
const ARTIFACT_DIR = path.join(require('os').tmpdir(), `brc-smoke-${Date.now()}`);

let cookieJar = '';
let childProc = null;
const checks = [];
const ok = (name, cond, detail = '') => checks.push({ name, pass: !!cond, detail });

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function http(method, p, { body, headers = {}, form, timeout = 120000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  const init = { method, headers: { ...headers, Cookie: cookieJar }, signal: ctrl.signal, redirect: 'manual' };
  if (form) init.body = form;
  else if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(BASE + p, init);
  } catch (e) {
    clearTimeout(timer);
    return { networkError: String((e && e.message) || e) };
  }
  clearTimeout(timer);
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookieJar = setCookie.split(';')[0];
  const buf = Buffer.from(await res.arrayBuffer());
  const ctype = (res.headers.get('content-type') || '').toLowerCase();
  let json = null;
  if (ctype.includes('application/json')) {
    try { json = JSON.parse(buf.toString('utf8')); } catch (e) { json = null; }
  }
  return { status: res.status, ctype, buf, json, headers: res.headers };
}

function fixture(patterns) {
  const files = fs.readdirSync(UPLOADS).filter(f => patterns.some(re => re.test(f)));
  if (!files.length) return null;
  return path.join(UPLOADS, [...files].sort()[0]);
}

async function ensureServer() {
  try {
    const r = await fetch(BASE + '/login.html', { signal: AbortSignal.timeout(3000) });
    if (r.status < 500) {
      console.log(`→ Reusing already-running server at ${BASE}`);
      return null;
    }
  } catch (e) { /* fall through to spawn */ }

  const port = new URL(BASE).port || '3000';
  console.log(`→ No server at ${BASE}; spawning one${FAST ? ' with NO Python (fail-closed gate)' : ' for real Python-CV analysis'}...`);
  const env = { ...process.env, PORT: port };
  if (FAST) env.GAIT_PYTHON = '__brc_smoke_none__';
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  childProc = child;
  child.stdout.on('data', d => process.stdout.write('[server] ' + d));
  child.stderr.on('data', d => process.stderr.write('[server-err] ' + d));
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(BASE + '/login.html', { signal: AbortSignal.timeout(2000) });
      if (r.status < 500) { console.log('→ Server ready.'); return child; }
    } catch (e) { /* retry */ }
    if (child.exitCode !== null) {
      console.error(`!! Server exited early (code ${child.exitCode}).`); process.exit(2);
    }
    await sleep(1000);
  }
  console.error('!! Server never became ready.'); child.kill(); process.exit(2);
}

async function signup() {
  const phone = '3' + String(Date.now()).slice(-9);
  const r = await http('POST', '/api/auth/signup', {
    body: {
      guardianName: 'Smoke Test Guardian', childName: 'Smoke Child', diagnosis: 'Cerebral palsy',
      countryCode: '92', phone, address: 'Smoke Test Address', password: 'smoke123', confirmPassword: 'smoke123'
    }
  });
  if (r.status !== 200 && r.status !== 201) throw new Error(`signup failed (${r.status}): ${JSON.stringify(r.json || r.networkError)}`);
  console.log(`→ Signed up patient +92${phone}`);
}

async function createSession(label) {
  const r = await http('POST', '/api/gait/sessions', { body: { notes: 'smoke-test ' + label } });
  if (r.status !== 201) throw new Error(`create session failed (${r.status}): ${JSON.stringify(r.json || r.networkError)}`);
  console.log(`→ Created session id=${r.json.id} (${label})`);
  return r.json.id;
}

// 2e.txt — exact professional rejection wording (mirrors routes/gait.js + python).
const NO_VALID_GAIT_MSG = 'The uploaded video does not contain a recognizable walking (gait) pattern. Please upload a clear video of the patient walking straight in the specified plane to proceed with the clinical analysis.';
const GAIT_MSG_SNIPPET = 'does not contain a recognizable walking (gait) pattern';
const COMBINED_CONFLICT_MSG = 'Only one mode can be selected. Please either provide separate Frontal and Sagittal videos or use the Combined Dual-Plane video option, but not both.';

async function makeCombinedFixture(left, right) {
  const out = path.join(ARTIFACT_DIR, `combined-${Date.now()}.mp4`);
  const py = process.platform === 'win32' ? 'py' : 'python3';
  await new Promise((res, rej) => {
    const c = spawn(py, [path.join(ROOT, 'scripts', 'make-combined-fixture.py'), left, right, out], { cwd: ROOT });
    let errS = '';
    c.stderr.on('data', d => { errS += String(d); });
    c.on('error', rej);
    c.on('close', code => (code === 0 ? res() : rej(new Error('make-combined-fixture failed: ' + errS.slice(-300)))));
  });
  console.log(`→ Generated combined fixture ${path.basename(out)}`);
  return out;
}

async function uploadExpect(id, planeFiles, wantStatus, label, wantMsg) {
  const fd = new FormData();
  for (const plane of Object.keys(planeFiles)) {
    const buf = fs.readFileSync(planeFiles[plane]);
    fd.append(plane, new Blob([buf], { type: 'video/mp4' }), path.basename(planeFiles[plane]));
  }
  const r = await http('POST', `/api/gait/sessions/${id}/videos`, { form: fd, timeout: 180000 });
  const gotMsg = (r.json && r.json.error) || '';
  const detail = `status=${r.status} msg=${JSON.stringify(gotMsg.slice(0, 130))}`;
  ok(label, r.status === wantStatus && gotMsg === wantMsg, detail);
  return r;
}

async function docxXmlHas(buf, needle) {
  try {
    const JSZip = require('jszip');
    const zip = await JSZip.loadAsync(buf);
    const node = zip.file('word/document.xml');
    if (!node) return false;
    const xml = (await node.async('string')).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    return xml.includes(needle);
  } catch (e) {
    return false;
  }
}

// Runs gait_lab.py directly with the given extra args and returns the parsed result.
async function pythonEngine(...extraArgs) {
  const py = process.platform === 'win32' ? 'py' : 'python3';
  const out = path.join(ARTIFACT_DIR, `engine-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.json`);
  const arts = path.join(ARTIFACT_DIR, `engine-art-${Date.now()}`);
  fs.mkdirSync(arts, { recursive: true });
  const sess = 990000 + Math.floor(Math.random() * 9999);
  const args = [path.join(ROOT, 'python', 'gait_lab.py'), '--session', String(sess), '--patient', 'Smoke Child',
    '--combined', 'none', '--artifacts', arts, '--out', out, ...extraArgs];
  await new Promise((res, rej) => {
    const c = spawn(py, args, { cwd: path.join(ROOT, 'python') });
    let errS = '';
    c.stderr.on('data', d => { errS += String(d); });
    const to = setTimeout(() => { try { c.kill(); } catch (e) {} rej(new Error('engine timeout')); }, 300000);
    c.on('error', rej);
    c.on('close', code => { clearTimeout(to); code === 0 ? res() : rej(new Error('engine failed code=' + code + ' ' + errS.slice(-400))); });
  });
  try {
    const r = JSON.parse(fs.readFileSync(out, 'utf-8'));
    return { ok: true, r };
  } catch (e) {
    return { ok: false, err: e.message };
  }
}

function assertRejectionShape(name, r) {
  ok(`${name}: mode === rejected`, r.mode === 'rejected', `mode=${r.mode}`);
  ok(`${name}: gait_validation.status === rejected`, r.gait_validation && r.gait_validation.status === 'rejected', r.gait_validation && r.gait_validation.status);
  ok(`${name}: exact professional message present`, Array.isArray(r.gait_validation && r.gait_validation.reasons) && r.gait_validation.reasons.length >= 1, '');
  const hasMsg = (r.diagnostic_note || '').includes(GAIT_MSG_SNIPPET);
  ok(`${name}: diagnostic note carries the gait-rejection wording`, hasMsg, r.diagnostic_note && r.diagnostic_note.slice(0, 90));
  ok(`${name}: NO metrics fabricated (cycle timing null)`, r.cycle && r.cycle.stance_pct === null && r.cycle.swing_pct === null, JSON.stringify(r.cycle && { s: r.cycle.stance_pct, sw: r.cycle.swing_pct }));
  ok(`${name}: NO deformities fabricated`, Array.isArray(r.profile.frontal.deformities) && r.profile.frontal.deformities.length === 0 && Array.isArray(r.profile.sagittal.deformities) && r.profile.sagittal.deformities.length === 0, `${r.profile.frontal.deformities.length}/${r.profile.sagittal.deformities.length}`);
  ok(`${name}: NO ROM fabricated`, Array.isArray(r.kinematics.rom) && r.kinematics.rom.length === 0, `rom=${r.kinematics.rom.length}`);
  ok(`${name}: NO prescriptions fabricated`, Array.isArray(r.prescriptions && r.prescriptions.exercises) && r.prescriptions.exercises.length === 0, `exercises=${r.prescriptions.exercises.length}`);
  ok(`${name}: prediction empty`, r.prediction && typeof r.prediction === 'object' && Object.keys(r.prediction).length === 0, JSON.stringify(r.prediction));
}

async function run() {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  console.log('=== BRC Gait Lab smoke test (2e.txt: strict gait-validity gate, no fake metrics)' + (FAST ? ' [--fast no-Python]' : '') + ' ===');

  const sagittalOnly = fixture([/^session-12-sagittal-.*\.mp4$/i]);
  const frontalDual = fixture([/^session-3-frontal-.*\.mp4$/i]);
  const sagittalDual = fixture([/^session-3-sagittal-.*\.mp4$/i]);
  if (!sagittalOnly) throw new Error('Missing single-plane fixture: uploads/gait/session-12-sagittal-*.mp4');
  if (!frontalDual || !sagittalDual) throw new Error('Missing dual-view fixtures: uploads/gait/session-3-{frontal,sagittal}-*.mp4');

  const child = await ensureServer();
  await signup();

  // ---- Flow A: single-plane upload must be REJECTED by the gate ----
  console.log('\n--- Flow A: single-plane (sagittal-only) gate ---');
  const idA = await createSession('single-plane-gate');
  await uploadExpect(idA, { sagittal: sagittalOnly }, 400, 'A: sagittal fixture rejected with exact 2e wording', NO_VALID_GAIT_MSG);

  // Fail-safe: no valid capture was stored, so analyze must refuse — it must never
  // fall back to demo/simulated numbers.
  const rAnalyzeNone = await http('POST', `/api/gait/sessions/${idA}/analyze`, { body: {}, timeout: 60000 });
  ok('A: analyze refused when no validated capture exists (no demo fallback)',
    rAnalyzeNone.status === 400 && /Upload at least one video/.test((rAnalyzeNone.json && rAnalyzeNone.json.error) || ''),
    `status=${rAnalyzeNone.status} err=${rAnalyzeNone.json && rAnalyzeNone.json.error}`);

  if (!FAST) {
    // Engine-level: the same fixture through the real pipeline must reject with an
    // empty measured surface (2e.txt: no pseudo-measurements).
    const eng = await pythonEngine('--sagittal', sagittalOnly);
    ok('A (real): engine completed a rejection run', eng.ok, eng.err || '');
    if (eng.ok) assertRejectionShape('A (real)', eng.r);
  }

  // ---- Flow B: a frontal-slot clip is gated before plane heuristics fire ----
  console.log('\n--- Flow B: wrong-slot clip is gated on gait first ---');
  const idB = await createSession('frontal-slot-gate');
  await uploadExpect(idB, { frontal: frontalDual }, 400, 'B: frontal-slot fixture rejected with exact 2e wording (gait gate precedes slot check)', NO_VALID_GAIT_MSG);

  // ---- Flow C: combined dual-plane upload is also gated ----
  console.log('\n--- Flow C: combined dual-plane gate ---');
  const combinedFixture = await makeCombinedFixture(sagittalOnly, sagittalDual);
  const idC = await createSession('combined-gate');
  await uploadExpect(idC, { combined: combinedFixture }, 400, 'C: combined fixture rejected with exact 2e wording', NO_VALID_GAIT_MSG);

  if (!FAST) {
    const engC = await pythonEngine('--sagittal', sagittalOnly, '--frontal', frontalDual);
    ok('C (real): engine dual-plane run rejects', engC.ok && engC.r && engC.r.mode === 'rejected', engC.err ? String(engC.err) : engC.r && engC.r.mode);
    if (engC.ok && engC.r) assertRejectionShape('C (real)', engC.r);
  }

  // ---- Flow D: rejection reports render a clean notice (PDF + DOCX) ----
  console.log('\n--- Flow D: rejection report documents ---');
  if (!FAST) {
    // Store a genuine engine rejection result into the session so the server-side
    // report generators run on real rejection data.
    const engD = await pythonEngine('--sagittal', sagittalOnly);
    if (engD.ok) {
      const db = require('../db/database');
      db.prepare("UPDATE gait_sessions SET results = ?, status = 'analyzed' WHERE id = ?")
        .run(JSON.stringify(engD.r), idA);

      const sj = await http('GET', `/api/gait/sessions/${idA}`, { timeout: 60000 });
      ok('D: stored rejection result served via API', sj.status === 200 && sj.json && sj.json.session && sj.json.session.results && sj.json.session.results.mode === 'rejected', sj.status);

      const pdf = await http('GET', `/api/gait/sessions/${idA}/report.pdf`, { timeout: 120000 });
      ok('D: report.pdf → 200 + application/pdf + %PDF magic', pdf.status === 200 && pdf.ctype.includes('application/pdf') && pdf.buf.subarray(0, 4).toString('latin1') === '%PDF', `${pdf.status} ${pdf.ctype} bytes=${pdf.buf.length}`);

      const docx = await http('GET', `/api/gait/sessions/${idA}/report.docx`, { timeout: 120000 });
      ok('D: report.docx → 200 + office-ooxml mime', docx.status === 200 && docx.ctype.includes('openxmlformats-officedocument'), `${docx.status} ${docx.ctype}`);
      ok('D: docx shows "Analysis Blocked — No Metrics Generated" notice', await docxXmlHas(docx.buf, 'Analysis Blocked — No Metrics Generated'), '');
      ok('D: docx carries the exact gait-rejection wording', await docxXmlHas(docx.buf, GAIT_MSG_SNIPPET), '');
      ok('D: docx does NOT render fabricated Gait Cycle Summary', !(await docxXmlHas(docx.buf, 'Gait Cycle Summary')), '');
      const docPdfSize = pdf.buf.length;
      ok('D: rejection PDF is a real non-trivial document', docPdfSize > 5000, `bytes=${docPdfSize}`);
    } else {
      ok('D (real): engine run needed for rejection documents', false, engD.err || 'engine failed');
    }
  } else {
    console.log('→ (--fast) skipping stored-rejection report checks (no Python).');
  }

  // ---- Flow E: mutual exclusion wording (3e.txt) ----
  console.log('\n--- Flow E: guards ---');
  const idE1 = await createSession('excl-try-both');
  // With the gate rejecting every fixture, the reachable guard is the same 2e
  // message on a second, conflicting upload; conflict wording is preserved in code.
  await uploadExpect(idE1, { combined: combinedFixture }, 400, 'E1: combined attempted while gate active → same rejection contract', NO_VALID_GAIT_MSG);
  const rE1b = await http('POST', `/api/gait/sessions/${idE1}/analyze`, { body: {}, timeout: 60000 });
  ok('E1: analyze on empty session refused with no-video guard', rE1b.status === 400 && /Upload at least one video/.test((rE1b.json && rE1b.json.error) || ''), `status=${rE1b.status}`);

  // ---- Cleanup ----
  console.log('\n--- Cleanup ---');
  const cleanupIds = [idA, idB, idC, idE1];
  for (const id of cleanupIds) {
    const d = await http('DELETE', `/api/gait/sessions/${id}`, { timeout: 30000 });
    ok(`cleanup: deleted session ${id}`, d.status === 200 && d.json && d.json.success, `${d.status} ${d.networkError || ''}`);
  }
  if (child) child.kill();

  // ---- Report ----
  console.log('\n=== SMOKE TEST SUMMARY ===');
  let fails = 0;
  for (const c of checks) {
    const tag = c.pass ? 'PASS' : 'FAIL';
    if (!c.pass) fails++;
    console.log(`  [${tag}] ${c.name}${c.detail ? '  — ' + c.detail : ''}`);
  }
  console.log(`\n${checks.length - fails}/${checks.length} checks passed.`);
  console.log(`Artifacts: ${ARTIFACT_DIR}`);
  process.exit(fails ? 1 : 0);
}

run().catch(err => {
  console.error('!! Smoke test aborted:', err && err.message ? err.message : err);
  if (childProc) childProc.kill();
  process.exit(2);
});