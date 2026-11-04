// Golden export test: PDF + DOCX report generation for a real analyzed session,
// including the Functional Assessment (clinical scales × gait) appendix.
// Spawns the server in-process, seeds a temp staff account via the DB, drives
// the API over HTTP, then tears everything down (zero permanent side effects).
const http = require('http');
const { execSync, spawn } = require('child_process');
const path = require('path');
const zlib = require('zlib');

const DB = require(path.join(__dirname, '..', 'db', 'database'));
const bcryptjs = require('bcryptjs');

const BASE = 'http://localhost:3000';
const SESSION_ID = 135; // pre-existing analyzed session (user_id = 1)
const TMP_USER = '+999999990001';
const TMP_PASS = 'TemporaryGolden2026';

let serverProc;
let cookieJar = '';

function req(pathname, method, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const u = new URL(pathname, BASE);
    const r = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname, method,
      headers: {
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        ...(cookieJar ? { Cookie: cookieJar } : {}),
      },
    }, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (res.headers['set-cookie']) cookieJar = res.headers['set-cookie'].map(c => c.split(';')[0]).join('; ');
        resolve({ status: res.statusCode, headers: res.headers, body: buf.toString('utf8'), bodyBuffer: buf });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function waitForServer(ms = 20000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tryOnce = () => {
      req('/api/auth/me', 'GET').then(() => resolve()).catch(() => {
        if (Date.now() - start > ms) reject(new Error('server did not become ready'));
        else setTimeout(tryOnce, 250);
      });
    };
    tryOnce();
  });
}

function unzipDocumentXml(buffer) {
  // Minimal ZIP central-directory reader to extract 'word/document.xml'.
  const sig = 0x04034b50; // local file header
  const files = {};
  let i = 0;
  // scan local headers
  while (i + 30 <= buffer.length) {
    const s = buffer.readUInt32LE(i);
    if (s !== sig) break;
    const nameLen = buffer.readUInt16LE(i + 26);
    const extraLen = buffer.readUInt16LE(i + 28);
    const compMethod = buffer.readUInt16LE(i + 8);
    const name = buffer.slice(i + 30, i + 30 + nameLen).toString('utf8');
    const compSize = buffer.readUInt32LE(i + 18);
    const uncompSize = buffer.readUInt32LE(i + 22);
    const dataStart = i + 30 + nameLen + extraLen;
    if (name === 'word/document.xml') {
      const raw = buffer.slice(dataStart, dataStart + compSize);
      const inflated = compMethod === 8 ? zlib.inflateRawSync(raw) : raw;
      return inflated.toString('utf8');
    }
    i = dataStart + compSize;
  }
  throw new Error('word/document.xml not found in docx');
}

(async () => {
  // Seed a temp staff account directly in SQLite.
  const hash = bcryptjs.hashSync(TMP_PASS, 10);
  DB.prepare(
    `INSERT INTO users (guardian_name, child_name, diagnosis, country_code, phone, username, address, password_hash, role)
     VALUES ('Golden Temp','—','','+92',?,?, '', ?,'admin')`
  ).run(TMP_USER, TMP_USER, hash);
  console.log('seeded temp staff user');

  // Ensure port 3000 is free so we always test fresh code.
  try {
    execSync('powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"', { shell: true });
  } catch (e) { /* no listener to kill */ }
  await new Promise(r => setTimeout(r, 1200));

  // Start the server fresh.
  let started = false;
  try {
    serverProc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PORT: '3000' },
    });
    started = true;
    serverProc.stdout.resume();
    const errChunks = [];
    serverProc.stderr.on('data', d => errChunks.push(d));
    serverProc.on('error', () => { started = false; });
  } catch (e) { /* port likely in use; reuse existing server */ }

  try {
    await waitForServer();
    console.log('server ready');

    const login = await req('/api/auth/login', 'POST', { username: TMP_USER, password: TMP_PASS });
    if (login.status !== 200) throw new Error('login failed: ' + login.status);

    // Create clinical-scale records for the patient owning session 135 (user 1).
    const bbs = await req(`/api/scales/1/bbs`, 'POST', {
      items: { '1': 4, '2': 4, '3': 3, '4': 4, '5': 2, '6': 4, '7': 4, '8': 2, '9': 2, '10': 4, '11': 2, '12': 2, '13': 2, '14': 2 },
      population: 'stroke', notes: 'golden BBS',
    });
    if (bbs.status !== 201) throw new Error('bbs POST failed: ' + bbs.status);

    await req(`/api/scales/1/gmfcs`, 'POST', { data: { level: 'II', age_years: 8, reported_via: 'self' } });
    await req(`/api/scales/1/tug`, 'POST', { data: { seconds: 11.5, population: 'frail', assistive_device: 'cane', observations: ['arms used'] } });

    // ---- PDF ----
    const pdfRes = await req(`/api/gait/sessions/${SESSION_ID}/report.pdf`, 'GET');
    if (pdfRes.status !== 200) throw new Error('PDF status ' + pdfRes.status + ': ' + pdfRes.body.slice(0, 200));
    if (!/application\/pdf/.test(pdfRes.headers['content-type'] || '')) throw new Error('PDF content-type: ' + pdfRes.headers['content-type']);
    const pdfBuf = pdfRes.bodyBuffer;
    if (pdfBuf.slice(0, 5).toString('ascii') !== '%PDF-') throw new Error('PDF does not start with %PDF-');
    console.log('PDF golden OK:', pdfBuf.length, 'bytes');

    // ---- DOCX ----
    console.log('DOCX request starting...');
    const docxRes = await req(`/api/gait/sessions/${SESSION_ID}/report.docx`, 'GET');
    if (docxRes.status !== 200) throw new Error('DOCX status ' + docxRes.status + ': ' + docxRes.body.slice(0, 200));
    if (!/wordprocessingml/.test(docxRes.headers['content-type'] || '')) throw new Error('DOCX content-type: ' + docxRes.headers['content-type']);
    const docxBuf = docxRes.bodyBuffer;
    let docXml = unzipDocumentXml(docxBuf);
    docXml = docXml.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    for (const token of ['Functional Assessment', 'Berg Balance Scale', 'Timed Up & Go', 'GMFCS-E&R', 'Cross-Validation']) {
      if (!docXml.includes(token)) throw new Error('DOCX missing appendix token: ' + token);
    }
    console.log('DOCX golden OK:', docxBuf.length, 'bytes, appendix tokens present');

    console.log('GOLDEN EXPORT TEST PASSED');
    return true;
  } finally {
    // Teardown: remove temp user + their scale records.
    try {
      const u = DB.prepare('SELECT id FROM users WHERE username = ?').get(TMP_USER);
      if (u) {
        DB.prepare('DELETE FROM clinical_scales WHERE created_by = ?').run(u.id);
        DB.prepare('DELETE FROM users WHERE id = ?').run(u.id);
      }
      console.log('temp staff user removed');
    } catch (e) { console.warn('teardown warn:', e.message); }
    if (started && serverProc) serverProc.kill();
  }
})().then(ok => {
  process.exit(ok ? 0 : 1);
}).catch(e => {
  console.error('GOLDEN EXPORT TEST FAILED:', e.message);
  if (serverProc) serverProc.kill();
  process.exit(1);
});
