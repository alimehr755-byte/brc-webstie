// public/js/gait.js
// Powers the Gait Lab page: dual-view upload, session management, analysis
// trigger and the clinical report renderer (phases, anomalies, deformities,
// ROM, muscles, prescriptions, references).

const MAX_VIDEO_BYTES = 200 * 1024 * 1024;

// Client-side fetch timeout: prevents the UI from hanging indefinitely if the
// server is slow (e.g. MediaPipe processing takes longer than expected).
function fetchWithTimeout(url, opts = {}, timeoutMs = 180000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...opts, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

let currentUser = null;
let viewMatrix = null;
let activeViewId = null;
let _gaitCharts = [];
let _progressionCache = {};

document.addEventListener('DOMContentLoaded', async () => {
  try {
    const res = await fetch('/api/auth/me');
    if (!res.ok) throw new Error();
    const { user } = await res.json();
    currentUser = user;
  } catch (err) {
    window.location.href = '/login.html';
    return;
  }

  try {
    const vres = await fetch('/api/gait/view-matrix');
    if (vres.ok) {
      viewMatrix = await vres.json();
      activeViewId = viewMatrix.user.defaultView || 'v1';
      window.__viewMatrix = viewMatrix;
    }
  } catch (e) { /* non-fatal: falls back to a single full report */ }

  setupUploadInputs();
  setupCreateBtn();
  loadSessions();
});

const VIDEO_EXT = /\.(mp4|mov|webm|avi|mkv|m4v)$/i;

// 3e.txt — exact user-facing strings (mirror the server's copy in routes/gait.js).
const COMBINED_CONFLICT_MSG = 'Only one mode can be selected. Please either provide separate Frontal and Sagittal videos or use the Combined Dual-Plane video option, but not both.';
const WRONG_FRONTAL_SLOT_MSG = 'The uploaded video appears to be a sagittal plane recording. Please browse and upload the correct frontal plane video.';
const WRONG_SAGGITTAL_SLOT_MSG = 'The uploaded video appears to be a frontal plane recording. Please browse and upload the correct sagittal plane video.';
// 2e.txt — professional rejection message (mirrors routes/gait.js NO_GENUINE_GAIT_MSG
// and python/gait_validity.py NO_VALID_GAIT_MSG).
const NO_VALID_GAIT_MSG = 'The uploaded video does not contain a recognizable walking (gait) pattern. Please upload a clear video of the patient walking straight in the specified plane to proceed with the clinical analysis.';

// 2e.txt — professional modal notification for recordings cleared of a walking pattern.
function showGaitRejectionModal(message) {
  const overlay = document.getElementById('gait-rejection-modal');
  if (!overlay) {
    window.alert(message);
    return;
  }
  const txt = document.getElementById('gait-rejection-modal-text');
  if (txt) txt.textContent = message;
  overlay.hidden = false;
  document.body.style.overflow = 'hidden';
}
function hideGaitRejectionModal() {
  const overlay = document.getElementById('gait-rejection-modal');
  if (!overlay) return;
  overlay.hidden = true;
  document.body.style.overflow = '';
}
document.addEventListener('DOMContentLoaded', () => {
  const close = document.getElementById('gait-rejection-modal-close');
  if (close) close.addEventListener('click', hideGaitRejectionModal);
  const overlay = document.getElementById('gait-rejection-modal');
  if (overlay) overlay.addEventListener('click', e => { if (e.target === overlay) hideGaitRejectionModal(); });
});

const PLANE_EL = { 'frontal-input': 'frontal-name', 'sagittal-input': 'sagittal-name', 'combined-input': 'combined-name' };

function validateVideoFile(input, msg) {
  const file = input.files && input.files[0];
  if (!file) return true;
  if (!VIDEO_EXT.test(file.name)) {
    showFormMsg(msg, `${file.name} is not a supported video. Use MP4, MOV, WebM, AVI, MKV or M4V.`, 'error');
    input.value = '';
    document.getElementById(PLANE_EL[input.id]).textContent = '';
    return false;
  }
  if (file.size > MAX_VIDEO_BYTES) {
    showFormMsg(msg, `${file.name} is ${(file.size / 1048576).toFixed(1)} MB — each video must be 200 MB or smaller.`, 'error');
    input.value = '';
    document.getElementById(PLANE_EL[input.id]).textContent = '';
    return false;
  }
  return true;
}

// ---- 3e.txt — best-effort client-side plane verification ----
// Loads MediaPipe PoseLandmarker (tasks-vision) from the CDN lazily and mirrors
// the server's frontal-ratio heuristic (ratio < 0.12 -> sagittal, >= 0.30 ->
// frontal). Returns 'frontal' | 'sagittal' | 'ambiguous' | null (null means the
// probe couldn't run — upload still proceeds; the server remains the authority).
let _poseRunnerPromise = null;

function ensurePoseRunner() {
  if (!_poseRunnerPromise) {
    _poseRunnerPromise = (async () => {
      try {
        const { FilesetResolver, PoseLandmarker } = await import(
          'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/vision_bundle.mjs'
        );
        const vision = await FilesetResolver.forVisionTasks(
          'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/wasm'
        );
        const landmarker = await PoseLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
            delegate: 'GPU'
          },
          runningMode: 'VIDEO',
          numPoses: 1
        });
        return { landmarker };
      } catch (e) {
        return null;
      }
    })();
  }
  return _poseRunnerPromise;
}

async function classifyPlaneClient(file) {
  let url = null;
  try {
    const lib = await ensurePoseRunner();
    if (!lib || !lib.landmarker) return null;
    url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'auto';
    await new Promise((res, rej) => {
      video.onloadedmetadata = res;
      video.onerror = () => rej(new Error('video load failed'));
      video.src = url;
    });
    const dur = video.duration || 0;
    const canvas = document.createElement('canvas');
    canvas.width = 240;
    canvas.height = Math.max(160, Math.round((video.videoHeight || 240) / (video.videoWidth || 320) * 240));
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const ratios = [];
    const marks = dur > 0 ? [0.2, 0.4, 0.6, 0.8] : [0];
    const tsBase = 1000;
    for (let i = 0; i < marks.length; i++) {
      video.currentTime = dur * marks[i];
      await new Promise(res => {
        const to = setTimeout(() => res(), 4000);
        video.onseeked = () => { clearTimeout(to); res(); };
        video.onerror = () => { clearTimeout(to); res(); };
      });
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const det = lib.landmarker.detectForVideo(canvas, tsBase + i * 1000);
      const lms = det && det.poseLandmarks && det.poseLandmarks[0];
      if (!lms) continue;
      const pt = j => ({ x: lms[j].x * canvas.width, y: lms[j].y * canvas.height, v: lms[j].visibility });
      const LH = pt(23), RH = pt(24), LA = pt(27), RA = pt(28);
      if (LH.v > 0.35 && RH.v > 0.35 && LA.v > 0.35 && RA.v > 0.35) {
        const hipW = Math.hypot(RH.x - LH.x, RH.y - LH.y);
        const bodyH = Math.abs((LH.y + RH.y) / 2 - (LA.y + RA.y) / 2);
        if (bodyH > 1e-6) ratios.push(hipW / bodyH);
      }
    }
    if (url) { URL.revokeObjectURL(url); url = null; }
    if (!ratios.length) return 'ambiguous';
    ratios.sort((a, b) => a - b);
    const med = ratios[Math.floor(ratios.length / 2)];
    return med < 0.12 ? 'sagittal' : (med >= 0.30 ? 'frontal' : 'ambiguous');
  } catch (e) {
    if (url) { try { URL.revokeObjectURL(url); } catch (e2) { /* noop */ } }
    return null;
  }
}

async function verifyPlaneOnInput(input, msg) {
  // Returns true if the file is acceptable (or the probe couldn't run — fail-open).
  const file = input.files && input.files[0];
  if (!file || input.id === 'combined-input') return true;
  const el = document.getElementById(PLANE_EL[input.id]);
  el.textContent = `${file.name} — verifying plane orientation…`;
  const detected = await classifyPlaneClient(file);
  if (detected === null) {
    el.textContent = `${file.name} (${(file.size / 1048576).toFixed(1)} MB)`;
    input.dataset.planeOk = 'na';
    return true;
  }
  const slot = input.id === 'frontal-input' ? 'frontal' : 'sagittal';
  const mismatch = slot === 'frontal' ? detected === 'sagittal' : detected === 'frontal';
  if (mismatch) {
    showFormMsg(msg, slot === 'frontal' ? WRONG_FRONTAL_SLOT_MSG : WRONG_SAGGITTAL_SLOT_MSG, 'error');
    input.value = '';
    el.textContent = '';
    delete input.dataset.planeOk;
    return false;
  }
  el.textContent = `${file.name} (${(file.size / 1048576).toFixed(1)} MB)`;
  input.dataset.planeOk = 'ok';
  return true;
}

function mutualExclusionHolds(pickedInput) {
  const frontal = document.getElementById('frontal-input');
  const sagittal = document.getElementById('sagittal-input');
  const combined = document.getElementById('combined-input');
  const isCombined = pickedInput.id === 'combined-input';
  const individualPicked = [frontal, sagittal];
  if (isCombined && individualPicked.some(i => i.files.length > 0)) return false;
  if (!isCombined && combined.files.length > 0) return false;
  return true;
}

function setupUploadInputs() {
  const msg = document.getElementById('gait-msg');
  ['frontal-input', 'sagittal-input', 'combined-input'].forEach(id => {
    const input = document.getElementById(id);
    input.addEventListener('change', async () => {
      if (!validateVideoFile(input, msg)) return;
      const file = input.files && input.files[0];
      const el = document.getElementById(PLANE_EL[input.id]);
      if (!file) { el.textContent = ''; return; }

      if (!mutualExclusionHolds(input)) {
        showFormMsg(msg, COMBINED_CONFLICT_MSG, 'error');
        input.value = '';
        el.textContent = '';
        return;
      }

      el.textContent = `${file.name} (${(file.size / 1048576).toFixed(1)} MB)`;
      if (input.id === 'combined-input') { input.dataset.planeOk = 'ok'; return; }
      await verifyPlaneOnInput(input, msg);
    });
  });
}

function setupCreateBtn() {
  const btn = document.getElementById('create-session-btn');
  const msg = document.getElementById('gait-msg');
  btn.addEventListener('click', async () => {
    const frontalInput = document.getElementById('frontal-input');
    const sagittalInput = document.getElementById('sagittal-input');
    const combinedInput = document.getElementById('combined-input');
    const frontal = frontalInput.files[0];
    const sagittal = sagittalInput.files[0];
    const combined = combinedInput.files[0];
    const notes = document.getElementById('gait-notes').value.trim();

    if (frontal && !validateVideoFile(frontalInput, msg)) return;
    if (sagittal && !validateVideoFile(sagittalInput, msg)) return;
    if (combined && !validateVideoFile(combinedInput, msg)) return;

    // 3e.txt — mutual exclusion is enforced once more at submit time.
    if ((frontal || sagittal) && combined) {
      showFormMsg(msg, COMBINED_CONFLICT_MSG, 'error');
      return;
    }
    if (!frontal && !sagittal && !combined) {
      showFormMsg(msg, 'Please attach at least one video (Frontal, Sagittal, and/or Combined Dual-Plane).', 'error');
      return;
    }

    // Re-run client verification if a file was picked but never verified (e.g. the
    // pose library loaded later). Fail-open if the probe is unavailable.
    if (frontal && frontalInput.dataset.planeOk !== 'ok' && frontalInput.dataset.planeOk !== 'na') {
      if (!(await verifyPlaneOnInput(frontalInput, msg))) return;
    }
    if (sagittal && sagittalInput.dataset.planeOk !== 'ok' && sagittalInput.dataset.planeOk !== 'na') {
      if (!(await verifyPlaneOnInput(sagittalInput, msg))) return;
    }

    btn.disabled = true;
    btn.textContent = 'Creating...';
    try {
      showFormMsg(msg, 'Creating session...', 'success');
      const res1 = await fetch('/api/gait/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          notes,
          speedHint: document.getElementById('gait-speed-hint')?.value || 'auto',
          heightCm: document.getElementById('gait-height-cm')?.value || '',
          ageYears: document.getElementById('gait-age')?.value || '',
          gender: document.getElementById('gait-gender')?.value || '',
          bodyMassKg: document.getElementById('gait-body-mass')?.value || '',
          clinicianName: document.getElementById('gait-clinician')?.value || ''
        })
      });
      const data1 = await res1.json();
      if (!res1.ok) throw new Error(data1.error);

      if (frontal || sagittal || combined) {
        const fd = new FormData();
        if (frontal) fd.append('frontal', frontal);
        if (sagittal) fd.append('sagittal', sagittal);
        if (combined) fd.append('combined', combined);
        showFormMsg(msg, 'Uploading & validating videos (this may take a moment)...', 'success');
        const res2 = await fetchWithTimeout(`/api/gait/sessions/${data1.id}/videos`, { method: 'POST', body: fd }, 300000);
        const data2 = await res2.json();
        if (!res2.ok) throw new Error(data2.error);
        showFormMsg(msg, `${data2.message} You can run the analysis from the list below.`, 'success');
      } else {
        showFormMsg(msg, 'Session created. Add a Frontal, Sagittal, and/or Combined video from the session card below, then run the analysis.', 'success');
      }

      document.getElementById('gait-notes').value = '';
      const hInput = document.getElementById('gait-height-cm');
      if (hInput) hInput.value = '';
      [frontalInput, sagittalInput, combinedInput].forEach(i => { i.value = ''; });
      ['frontal-name', 'sagittal-name', 'combined-name'].forEach(id => document.getElementById(id).textContent = '');
      loadSessions();
    } catch (err) {
      const errMsg = (err.name === 'AbortError')
        ? 'Upload timed out. Please try with a shorter video or check your connection.'
        : (err.message || 'Create failed. Please try again.');
      showFormMsg(msg, errMsg, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Create Session & Upload Videos';
    }
  });
}

async function loadSessions() {
  const listEl = document.getElementById('gait-sessions-list');
  try {
    const res = await fetch('/api/gait/sessions');
    if (!res.ok) throw new Error();
    const { sessions } = await res.json();
    if (sessions.length === 0) {
      listEl.innerHTML = '<p class="empty-state">No gait sessions yet. Create your first one above.</p>';
      return;
    }
    listEl.innerHTML = sessions.map(sessionCardHtml).join('');
    bindSessionActions();
  } catch (err) {
    listEl.innerHTML = '<p class="empty-state">Could not load sessions. Please refresh.</p>';
  }
}

function sessionCardHtml(s) {
  const hasVideo = !!s.frontal_name || !!s.sagittal_name || !!s.combined_name;
  const combinedMode = !!s.combined_name;
  const analyzed = s.status === 'analyzed' || s.status === 'reviewed';
  const videoNames = [s.frontal_name, s.sagittal_name, s.combined_name].filter(Boolean).join('  ·  ');
  const frontalBtn = s.frontal_name
    ? `<a class="btn btn-ghost btn-sm" href="/api/gait/sessions/${s.id}/video/frontal" target="_blank">Frontal</a>`
    : `<button class="btn btn-ghost btn-sm" data-action="add" data-id="${s.id}" data-plane="frontal">Add Frontal</button>`;
  const sagittalBtn = s.sagittal_name
    ? `<a class="btn btn-ghost btn-sm" href="/api/gait/sessions/${s.id}/video/sagittal" target="_blank">Sagittal</a>`
    : `<button class="btn btn-ghost btn-sm" data-action="add" data-id="${s.id}" data-plane="sagittal">Add Sagittal</button>`;
  const combinedBtn = s.combined_name
    ? `<a class="btn btn-ghost btn-sm" href="/api/gait/sessions/${s.id}/video/combined" target="_blank">Combined</a>`
    : `<button class="btn btn-ghost btn-sm" data-action="add" data-id="${s.id}" data-plane="combined">Add Combined</button>`;
  return `
    <div class="appt-item" data-id="${s.id}">
      <input type="file" accept="video/*,.mp4,.mov,.webm,.avi,.mkv,.m4v" style="display:none;" data-upload="${s.id}" data-plane="frontal">
      <input type="file" accept="video/*,.mp4,.mov,.webm,.avi,.mkv,.m4v" style="display:none;" data-upload="${s.id}" data-plane="sagittal">
      <input type="file" accept="video/*,.mp4,.mov,.webm,.avi,.mkv,.m4v" style="display:none;" data-upload="${s.id}" data-plane="combined">
      <div style="flex:1; min-width:0;">
        <div class="tags">
          <span class="status-badge status-${analyzed ? 'confirmed' : (hasVideo ? 'pending' : '')}">${s.status}</span>
          <span>Session #${s.id}</span>
          <span>${formatDate(s.created_at)}</span>
        </div>
        <div style="margin-top:6px; font-size:.88rem;">
          ${videoNames ? `Videos: <strong>${escapeHtml(videoNames)}</strong>` : '<span style="color:var(--ink-500);">No videos uploaded yet — add a Frontal, Sagittal, and/or Combined clip below.</span>'}
          ${combinedMode ? '<span style="color:var(--ink-500);"> Combined dual-plane capture mode in use.</span>' : ''}
          ${s.notes ? `<div style="color:var(--ink-600); margin-top:2px;">${escapeHtml(s.notes)}</div>` : ''}
          ${(() => {
            const parts = [];
            if (s.age_years != null) parts.push(`Age: ${s.age_years}y`);
            if (s.gender) parts.push(s.gender);
            if (s.body_mass_kg != null) parts.push(`${s.body_mass_kg} kg`);
            if (s.clinician_name) parts.push(`Clinician: ${s.clinician_name}`);
            return parts.length ? `<div style="color:var(--ink-500); margin-top:2px; font-size:.82rem;">${escapeHtml(parts.join('  ·  '))}</div>` : '';
          })()}
          ${s.reviewed_at ? `<div style="color:var(--sage-700); margin-top:2px;">Reviewed by ${escapeHtml(s.reviewed_by || 'staff')}</div>` : ''}
        </div>
      </div>
      <div class="tags" style="flex-wrap:wrap; justify-content:flex-end;">
        ${hasVideo ? `
        <label style="display:inline-flex; align-items:center; gap:4px; font-size:.78rem; color:var(--ink-600);">
          Height (cm) — metric calibration
          <input type="number" min="50" max="260" step="0.5" data-height="${s.id}" value="${s.height_cm != null ? escapeHtml(String(s.height_cm)) : ''}" placeholder="auto" style="width:72px; font-size:.78rem; padding:2px 4px; border:1px solid #CBD5E1; border-radius:6px; background:#fff; color:#232520;">
        </label>
        <label style="display:inline-flex; align-items:center; gap:4px; font-size:.78rem; color:var(--ink-600);">
          Playback speed
          <select data-speed="${s.id}" class="speed-hint-select" style="font-size:.78rem; padding:2px 4px; border:1px solid #CBD5E1; border-radius:6px; background:#fff; color:#232520;">
            ${['auto', 'normal', 'running', 'slowmo_120', 'slowmo_240'].map(v => `<option value="${v}" ${(s.speed_hint || 'auto') === v ? 'selected' : ''}>${speedHintLabel(v)}</option>`).join('')}
          </select>
        </label>` : ''}
        ${combinedMode ? combinedBtn : `${frontalBtn}${sagittalBtn}`}
        ${hasVideo && !analyzed ? `<button class="btn btn-outline btn-sm" data-action="analyze" data-id="${s.id}">Run Analysis</button>` : ''}
        ${analyzed ? `
        <button class="btn btn-primary btn-sm" data-action="view" data-id="${s.id}">View Report</button>
        <a class="btn btn-outline btn-sm" href="/api/gait/sessions/${s.id}/report.pdf" target="_blank">PDF</a>
        <a class="btn btn-outline btn-sm" href="/api/gait/sessions/${s.id}/report.docx" target="_blank">Word</a>` : ''}
        <button class="btn btn-ghost btn-sm" data-action="delete" data-id="${s.id}">Delete</button>
      </div>
    </div>
  `;
}

function bindSessionActions() {
  const listEl = document.getElementById('gait-sessions-list');

  listEl.querySelectorAll('input[data-upload]').forEach(input => {
    input.addEventListener('change', () => {
      const file = input.files && input.files[0];
      if (!file) return;
      const id = input.dataset.upload;
      const plane = input.dataset.plane;
      const msg = document.getElementById('gait-msg');
      if (file.size > MAX_VIDEO_BYTES) {
        showFormMsg(msg, `${file.name} is ${(file.size / 1048576).toFixed(1)} MB — each video must be 200 MB or smaller.`, 'error');
        input.value = '';
        return;
      }
      uploadSingleVideo(id, plane, file, msg, input);
    });
  });

  listEl.querySelectorAll('select[data-speed]').forEach(sel => {
    sel.addEventListener('change', async () => {
      const id = sel.dataset.speed;
      const msg = document.getElementById('gait-msg');
      try {
        const res = await fetch(`/api/gait/sessions/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ speedHint: sel.value })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not update playback speed.');
        showFormMsg(msg, 'Playback speed updated. Re-run analysis to apply it.', 'success');
      } catch (err) {
        showFormMsg(msg, err.message || 'Could not update playback speed.', 'error');
        sel.value = sel.dataset.prev || 'auto';
      }
      sel.dataset.prev = sel.value;
    });
  });

  listEl.querySelectorAll('input[data-height]').forEach(inp => {
    const commit = async () => {
      const id = inp.dataset.height;
      const msg = document.getElementById('gait-msg');
      const val = inp.value.trim();
      if (val !== '' && (isNaN(Number(val)) || Number(val) < 50 || Number(val) > 260)) {
        showFormMsg(msg, 'Height must be between 50 and 260 cm (or empty).', 'error');
        return;
      }
      try {
        const res = await fetch(`/api/gait/sessions/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ heightCm: val })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not update height.');
        showFormMsg(msg, 'Height calibration updated. Re-run analysis to apply it.', 'success');
      } catch (err) {
        showFormMsg(msg, err.message || 'Could not update height.', 'error');
      }
    };
    inp.addEventListener('change', commit);
    inp.addEventListener('blur', commit);
  });

  listEl.querySelectorAll('button[data-action]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const action = btn.dataset.action;
      const id = btn.dataset.id;
      if (action === 'add') {
        const plane = btn.dataset.plane;
        const input = listEl.querySelector(`input[data-upload="${id}"][data-plane="${plane}"]`);
        if (input) input.click();
        return;
      }
      if (action === 'delete') {
        if (!window.confirm('Delete this session and its videos? This cannot be undone.')) return;
        await fetch(`/api/gait/sessions/${id}`, { method: 'DELETE' });
        loadSessions();
        return;
      }
      if (action === 'analyze') {
        btn.disabled = true;
        btn.textContent = 'Analyzing...';
        const overlay = ensureAnalysisOverlay();
        overlay.classList.add('active');
        setAnalysisProgress(0, 'Starting analysis...');
        brcStartTimer();
        let poll = null;
        let sessionId = id;
        let pollCount = 0;
        const MAX_POLL_COUNT = 800; // ~20 minutes at 1.5s intervals
        try {
          poll = setInterval(async () => {
            pollCount++;
            if (pollCount > MAX_POLL_COUNT) {
              clearInterval(poll);
              brcStopTimer();
              setAnalysisError('Analysis is taking longer than expected. The server may still be processing — check the sessions list in a few minutes.');
              return;
            }
            try {
              const pr = await fetch(`/api/gait/sessions/${id}/analyze-progress`);
              const pd = await pr.json();
              if (pd && pd.running) {
                setAnalysisProgress(pd.pct || 0, pd.phase || 'Processing frames...');
              } else if (pd && pd.state === 'error') {
                setAnalysisError(pd.error || 'Analysis encountered an error.');
                brcStopTimer();
              } else if (pd && pd.state === 'done') {
                clearInterval(poll);
                setAnalysisProgress(100, 'Complete!');
              }
            } catch (e) { /* ignore transient network errors while polling */ }
          }, 1500);
          const res = await fetchWithTimeout(`/api/gait/sessions/${id}/analyze`, { method: 'POST' }, 900000);
          const data = await res.json();
          if (!res.ok) throw new Error(data.error);
          setAnalysisProgress(100, 'Analysis complete!');
          setAnalysisComplete(`/api/gait/sessions/${id}/report.pdf`, `/api/gait/sessions/${id}/report.docx`);
        } catch (err) {
          brcStopTimer();
          const errMsg = (err.name === 'AbortError')
            ? 'Analysis timed out. The server is processing a large video — try again with a shorter clip, or check back in a few minutes.'
            : (err.message || 'Analysis failed.');
          setAnalysisError(errMsg);
        } finally {
          if (poll) clearInterval(poll);
          loadSessions();
        }
        return;
      }
      if (action === 'view') {
        await openReport(id);
      }
    });
  });
}

async function uploadSingleVideo(id, plane, file, msg, input) {
  const btn = document.querySelector(`button[data-action="add"][data-id="${id}"][data-plane="${plane}"]`);
  if (btn) { btn.disabled = true; }
  try {
    showFormMsg(msg, `Uploading ${plane} video (validating, please wait)...`, 'success');
    const fd = new FormData();
    fd.append(plane, file);
    const res = await fetchWithTimeout(`/api/gait/sessions/${id}/videos`, { method: 'POST', body: fd }, 300000);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    showFormMsg(msg, data.message || `${plane.charAt(0).toUpperCase() + plane.slice(1)} video uploaded.`, 'success');
    input.value = '';
    loadSessions();
  } catch (err) {
    const errMsg = (err.name === 'AbortError')
      ? 'Upload timed out. Please try with a shorter video.'
      : (err.message || 'Upload failed. Please try again.');
    showFormMsg(msg, errMsg, 'error');
    if (input) input.value = '';
    // 2e.txt — professional pop-up when the recording fails the gait-validity gate.
    if ((err.message || '').indexOf('does not contain a recognizable walking (gait) pattern') !== -1) {
      showGaitRejectionModal(NO_VALID_GAIT_MSG);
    }
  } finally {
    if (btn) { btn.disabled = false; }
  }
}

// ---- Analysis loading overlay (live progress while CPU processes frames) ----
function ensureAnalysisOverlay() {
  let el = document.getElementById('analysis-overlay');
  if (!el) {
    el = document.createElement('div');
    el.id = 'analysis-overlay';
    el.className = 'analysis-overlay';
    el.innerHTML = `
      <div class="brc-gait-card" id="brc-gait-card">
        <!-- Close button -->
        <button id="brc-overlay-close" style="position:absolute;top:10px;right:12px;z-index:10;background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.2);color:#fff;width:28px;height:28px;border-radius:50%;cursor:pointer;font-size:16px;line-height:1;display:flex;align-items:center;justify-content:center;" title="Close">&times;</button>
        <!-- Animation Panel -->
        <div class="brc-anim-panel">
          <!-- Walking Human Silhouette -->
          <div class="brc-walk-figure">
            <svg viewBox="0 0 130 180" xmlns="http://www.w3.org/2000/svg">
              <defs>
                <linearGradient id="brc-body-grad" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stop-color="#0072CE"/>
                  <stop offset="100%" stop-color="#5EB12A"/>
                </linearGradient>
                <linearGradient id="brc-limb-grad" x1="0%" y1="0%" x2="0%" y2="100%">
                  <stop offset="0%" stop-color="#0072CE"/>
                  <stop offset="100%" stop-color="#3a9ae0"/>
                </linearGradient>
              </defs>
              <!-- Head -->
              <circle cx="65" cy="18" r="12" fill="url(#brc-body-grad)" opacity="0.9"/>
              <!-- Neck -->
              <rect x="61" y="30" width="8" height="8" rx="3" fill="url(#brc-body-grad)" opacity="0.8"/>
              <!-- Torso -->
              <path d="M52 38 Q65 35 78 38 L75 85 Q65 88 55 85 Z" fill="url(#brc-body-grad)" opacity="0.85"/>
              <!-- Left arm -->
              <g class="brc-arm-l">
                <path d="M52 42 L38 65 L35 62" stroke="url(#brc-limb-grad)" stroke-width="5" stroke-linecap="round" fill="none" opacity="0.8"/>
              </g>
              <!-- Right arm -->
              <g class="brc-arm-r">
                <path d="M78 42 L92 65 L95 62" stroke="url(#brc-limb-grad)" stroke-width="5" stroke-linecap="round" fill="none" opacity="0.8"/>
              </g>
              <!-- Left leg -->
              <g class="brc-leg-l">
                <path d="M58 85 L48 130 L44 160" stroke="url(#brc-limb-grad)" stroke-width="6" stroke-linecap="round" fill="none" opacity="0.85"/>
                <!-- Foot -->
                <ellipse cx="42" cy="163" rx="10" ry="4" fill="#0072CE" opacity="0.7"/>
              </g>
              <!-- Right leg -->
              <g class="brc-leg-r">
                <path d="M72 85 L82 130 L86 160" stroke="url(#brc-limb-grad)" stroke-width="6" stroke-linecap="round" fill="none" opacity="0.85"/>
                <!-- Foot -->
                <ellipse cx="88" cy="163" rx="10" ry="4" fill="#0072CE" opacity="0.7"/>
              </g>
              <!-- Joint highlights -->
              <circle cx="52" cy="42" r="3" fill="#5EB12A" opacity="0.9"/>
              <circle cx="78" cy="42" r="3" fill="#5EB12A" opacity="0.9"/>
              <circle cx="58" cy="85" r="3.5" fill="#FFB800" opacity="0.9"/>
              <circle cx="72" cy="85" r="3.5" fill="#FFB800" opacity="0.9"/>
              <circle cx="48" cy="130" r="3" fill="#5EB12A" opacity="0.8"/>
              <circle cx="82" cy="130" r="3" fill="#5EB12A" opacity="0.8"/>
            </svg>
            <!-- Scanning Beam -->
            <div class="brc-scan-beam"></div>
          </div>

          <!-- Ground Grid -->
          <svg class="brc-ground-grid" viewBox="0 0 200 50" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">
            <defs>
              <linearGradient id="brc-grid-grad" x1="0%" y1="0%" x2="0%" y2="100%">
                <stop offset="0%" stop-color="#5EB12A" stop-opacity="0.4"/>
                <stop offset="100%" stop-color="#5EB12A" stop-opacity="0"/>
              </linearGradient>
            </defs>
            <line x1="0" y1="10" x2="200" y2="10" stroke="url(#brc-grid-grad)" stroke-width="0.5"/>
            <line x1="0" y1="20" x2="200" y2="20" stroke="url(#brc-grid-grad)" stroke-width="0.5"/>
            <line x1="0" y1="30" x2="200" y2="30" stroke="url(#brc-grid-grad)" stroke-width="0.5"/>
            <line x1="0" y1="40" x2="200" y2="40" stroke="url(#brc-grid-grad)" stroke-width="0.5"/>
            <line x1="20" y1="0" x2="10" y2="50" stroke="url(#brc-grid-grad)" stroke-width="0.4"/>
            <line x1="50" y1="0" x2="40" y2="50" stroke="url(#brc-grid-grad)" stroke-width="0.4"/>
            <line x1="80" y1="0" x2="70" y2="50" stroke="url(#brc-grid-grad)" stroke-width="0.4"/>
            <line x1="100" y1="0" x2="100" y2="50" stroke="url(#brc-grid-grad)" stroke-width="0.4"/>
            <line x1="120" y1="0" x2="130" y2="50" stroke="url(#brc-grid-grad)" stroke-width="0.4"/>
            <line x1="150" y1="0" x2="160" y2="50" stroke="url(#brc-grid-grad)" stroke-width="0.4"/>
            <line x1="180" y1="0" x2="190" y2="50" stroke="url(#brc-grid-grad)" stroke-width="0.4"/>
          </svg>

          <!-- Clipboard Report -->
          <div class="brc-clipboard">
            <svg viewBox="0 0 120 170" xmlns="http://www.w3.org/2000/svg">
              <!-- Clipboard body -->
              <rect x="10" y="20" width="100" height="140" rx="6" fill="#D9822B" opacity="0.9"/>
              <!-- Metal clip -->
              <rect x="35" y="10" width="50" height="20" rx="4" fill="#B0B8C4"/>
              <rect x="40" y="14" width="40" height="12" rx="3" fill="#D0D6DE"/>
              <!-- Paper -->
              <rect x="16" y="28" width="88" height="125" rx="3" fill="#FAFBFD"/>
              <!-- Pie chart -->
              <circle cx="60" cy="72" r="22" fill="none" stroke="#E8EDF3" stroke-width="8"/>
              <circle cx="60" cy="72" r="22" fill="none" stroke="#0072CE" stroke-width="8"
                stroke-dasharray="50 88" stroke-dashoffset="0" transform="rotate(-90 60 72)" class="brc-pie-blue"/>
              <circle cx="60" cy="72" r="22" fill="none" stroke="#5EB12A" stroke-width="8"
                stroke-dasharray="38 100" stroke-dashoffset="-50" transform="rotate(-90 60 72)" class="brc-pie-green"/>
              <circle cx="60" cy="72" r="22" fill="none" stroke="#FFB800" stroke-width="8"
                stroke-dasharray="25 113" stroke-dashoffset="-88" transform="rotate(-90 60 72)" class="brc-pie-gold"/>
              <!-- Text lines -->
              <rect x="24" y="102" width="52" height="4" rx="2" fill="#CBD5E1" class="brc-clip-line"/>
              <rect x="24" y="112" width="68" height="4" rx="2" fill="#CBD5E1" class="brc-clip-line"/>
              <rect x="24" y="122" width="40" height="4" rx="2" fill="#CBD5E1" class="brc-clip-line"/>
              <rect x="24" y="132" width="56" height="4" rx="2" fill="#CBD5E1" class="brc-clip-line"/>
              <!-- Checkmarks -->
              <g opacity="0" class="brc-clip-check" data-idx="0">
                <circle cx="96" cy="104" r="4" fill="#5EB12A"/>
                <path d="M94 104 L95.5 106 L98.5 102" stroke="#fff" stroke-width="1.2" fill="none" stroke-linecap="round"/>
              </g>
              <g opacity="0" class="brc-clip-check" data-idx="1">
                <circle cx="96" cy="114" r="4" fill="#5EB12A"/>
                <path d="M94 114 L95.5 116 L98.5 112" stroke="#fff" stroke-width="1.2" fill="none" stroke-linecap="round"/>
              </g>
              <g opacity="0" class="brc-clip-check" data-idx="2">
                <circle cx="96" cy="124" r="4" fill="#5EB12A"/>
                <path d="M94 124 L95.5 126 L98.5 122" stroke="#fff" stroke-width="1.2" fill="none" stroke-linecap="round"/>
              </g>
              <g opacity="0" class="brc-clip-check" data-idx="3">
                <circle cx="96" cy="134" r="4" fill="#5EB12A"/>
                <path d="M94 134 L95.5 136 L98.5 132" stroke="#fff" stroke-width="1.2" fill="none" stroke-linecap="round"/>
              </g>
            </svg>
          </div>
        </div>

        <!-- Counter & Progress -->
        <div class="brc-counter-area">
          <div class="brc-counter-row">
            <span class="brc-counter-pct pulsing" id="brc-counter-pct">0%</span>
            <span class="brc-counter-timer" id="brc-counter-timer">Estimating...</span>
          </div>
          <div class="brc-progress-track">
            <div class="brc-progress-fill" id="brc-progress-fill">
              <div class="brc-progress-flare"></div>
            </div>
          </div>
          <div class="brc-phase-msg" id="brc-phase-msg">Initializing BRC Gait Algorithm &amp; Calibrating Spatial Vectors...</div>
        </div>

        <!-- Clinical Benefits -->
        <div class="brc-benefits">
          <div class="brc-benefits-inner">
            <div class="brc-benefits-title">Why BRC Gait Analysis Matters</div>
            <div class="brc-benefits-text">Dynamic motion tracking captures micro-instabilities invisible to the human eye. By precisely mapping joint angles and biomechanical coordination during movement, our system pinpoints the root cause of functional compensation. This data empowers our clinical team to formulate targeted rehabilitation plans, correct postural deformities, and optimize recovery timelines.</div>
          </div>
        </div>

        <!-- Error state (hidden by default) -->
        <div class="brc-error-msg" id="brc-error-msg">
          <div class="brc-error-inner">
            <div class="brc-error-title">Analysis Error</div>
            <div class="brc-error-text" id="brc-error-text"></div>
          </div>
        </div>

        <!-- Completion overlay (hidden by default) -->
        <div class="brc-complete-overlay" id="brc-complete-overlay">
          <div class="brc-complete-check">
            <svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path class="brc-check-mark" d="M8 16 L14 22 L24 10" stroke="#5EB12A" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </div>
          <div class="brc-complete-title">Gait Analysis Complete!</div>
          <div class="brc-complete-sub">Your clinical report is ready for review.</div>
          <a class="brc-cta-btn" id="brc-cta-btn" href="#" target="_blank">
            <svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M4 16V4h8l4 4v8H4z" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/>
              <path d="M12 4v4h4" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/>
              <path d="M7 11l2 2 4-4" stroke="#fff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            View &amp; Download Clinical Gait Report
          </a>
          <button class="brc-cta-btn" id="brc-close-btn" style="background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.2);margin-top:10px;">Close</button>
        </div>
      </div>`;
    document.body.appendChild(el);
  }
  // Reset state for a fresh run
  const card = el.querySelector('#brc-gait-card');
  if (card) {
    card.classList.remove('brc-complete');
    const errEl = card.querySelector('#brc-error-msg');
    if (errEl) errEl.classList.remove('visible');
  }

  // Wire up dismiss handlers (only once)
  if (!el._brcDismissWired) {
    el._brcDismissWired = true;
    // Close button
    const closeBtn = el.querySelector('#brc-overlay-close');
    if (closeBtn) closeBtn.addEventListener('click', () => el.classList.remove('active'));
    // Click outside card to dismiss
    el.addEventListener('click', (e) => {
      if (e.target === el) el.classList.remove('active');
    });
    // Escape key to dismiss
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && el.classList.contains('active')) el.classList.remove('active');
    });
    // CTA button also dismisses
    const ctaBtn = el.querySelector('#brc-cta-btn');
    if (ctaBtn) ctaBtn.addEventListener('click', () => {
      setTimeout(() => el.classList.remove('active'), 300);
    });
    // Close button in completion overlay
    const closeBtn2 = el.querySelector('#brc-close-btn');
    if (closeBtn2) closeBtn2.addEventListener('click', () => el.classList.remove('active'));
  }

  return el;
}

/* ---- Phase messages (runn.txt no-jargon policy) ---- */
const BRC_PHASE_MESSAGES = [
  { max: 30, msg: 'Initializing BRC Gait Algorithm & Calibrating Spatial Vectors...' },
  { max: 70, msg: 'Analyzing Multi-Planar Joint Kinematics & Postural Alignment...' },
  { max: 99, msg: 'Evaluating Biomechanical Kinetics & Generating Clinical Prescription...' },
  { max: 100, msg: 'Finalizing Clinical Report...' },
];

function brcPhaseForPct(pct) {
  for (const p of BRC_PHASE_MESSAGES) {
    if (pct <= p.max) return p.msg;
  }
  return BRC_PHASE_MESSAGES[BRC_PHASE_MESSAGES.length - 1].msg;
}

/* ---- Countdown timer state ---- */
let _brcTimerInterval = null;
let _brcStartTime = 0;
let _brcLastPct = 0;

function brcStartTimer() {
  _brcStartTime = Date.now();
  _brcLastPct = 0;
  if (_brcTimerInterval) clearInterval(_brcTimerInterval);
  _brcTimerInterval = setInterval(() => {
    const timerEl = document.getElementById('brc-counter-timer');
    if (!timerEl) return;
    const elapsed = (Date.now() - _brcStartTime) / 1000;
    if (_brcLastPct > 5 && _brcLastPct < 100) {
      const rate = _brcLastPct / elapsed;
      const remaining = Math.max(0, (100 - _brcLastPct) / rate);
      const mins = Math.floor(remaining / 60);
      const secs = Math.floor(remaining % 60);
      timerEl.textContent = mins > 0 ? `${mins}m ${secs}s remaining` : `~${secs}s remaining`;
    } else if (_brcLastPct >= 100) {
      timerEl.textContent = '';
    } else {
      timerEl.textContent = 'Estimating...';
    }
  }, 1000);
}

function brcStopTimer() {
  if (_brcTimerInterval) { clearInterval(_brcTimerInterval); _brcTimerInterval = null; }
}

function setAnalysisProgress(pct, status) {
  const p = Math.max(0, Math.min(100, pct));
  const fill = document.getElementById('brc-progress-fill');
  const counter = document.getElementById('brc-counter-pct');
  const phaseMsg = document.getElementById('brc-phase-msg');
  const timerEl = document.getElementById('brc-counter-timer');
  const card = document.getElementById('brc-gait-card');

  // Update progress bar
  if (fill) {
    fill.style.width = `${p}%`;
    fill.classList.toggle('active', p > 0 && p < 100);
  }

  // Update counter
  if (counter) counter.textContent = `${p}%`;

  // Update phase message
  if (phaseMsg) phaseMsg.textContent = brcPhaseForPct(p);

  // Track for timer
  _brcLastPct = p;

  // Show checkmarks on clipboard at milestones
  if (p >= 25) showClipCheck(0);
  if (p >= 50) showClipCheck(1);
  if (p >= 75) showClipCheck(2);
  if (p >= 95) showClipCheck(3);

  // Completion state
  if (p >= 100 && card) {
    brcStopTimer();
    if (timerEl) timerEl.textContent = '';
    if (counter) { counter.textContent = '100%'; counter.classList.remove('pulsing'); }
    if (phaseMsg) phaseMsg.textContent = '';
    // Delayed completion reveal
    setTimeout(() => {
      card.classList.add('brc-complete');
    }, 600);
  }
}

function showClipCheck(idx) {
  const checks = document.querySelectorAll('.brc-clip-check');
  if (checks[idx]) checks[idx].style.opacity = '1';
}

function setAnalysisError(msg) {
  const errEl = document.getElementById('brc-error-msg');
  const errText = document.getElementById('brc-error-text');
  if (errText) errText.textContent = msg || 'An unexpected error occurred.';
  if (errEl) errEl.classList.add('visible');
  // Auto-show close button in error state
  const closeBtn = document.getElementById('brc-overlay-close');
  if (closeBtn) closeBtn.style.display = 'flex';
}

function setAnalysisComplete(pdfUrl, docxUrl) {
  const cta = document.getElementById('brc-cta-btn');
  if (cta && pdfUrl) {
    cta.href = pdfUrl;
  }
}

async function openReport(id) {
  const panel = document.getElementById('report-panel');
  const body = document.getElementById('report-body');
  body.innerHTML = '<p class="empty-state">Loading report...</p>';
  panel.style.display = 'block';
  const res = await fetch(`/api/gait/sessions/${id}`);
  if (!res.ok) {
    body.innerHTML = '<p class="empty-state">Could not load the report.</p>';
    return;
  }
  const { session } = await res.json();
  if (!session.results) {
    body.innerHTML = '<p class="empty-state">No analysis results for this session.</p>';
    return;
  }
  window.__lastSession = session;
  renderCurrentView();
}

function bindReportTabs() {
  const panels = document.querySelectorAll('.gait-tab-panel');
  const activeMarkers = {};
  panels.forEach(p => { activeMarkers[p.id] = p.getAttribute('data-default') === '1'; });
  document.querySelectorAll('button[data-gait-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('button[data-gait-tab]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const targetId = btn.getAttribute('data-panel');
      panels.forEach(p => {
        const show = p.id === targetId;
        p.style.display = show ? 'block' : 'none';
        if (show && window.Chart) {
          buildPanelCharts(p.id);
        }
      });
      if (window.Chart) window.dispatchEvent(new Event('resize'));
    });
  });
  panels.forEach(p => { p.style.display = activeMarkers[p.id] ? 'block' : 'none'; });
  document.querySelectorAll('button[data-gait-tab]').forEach(b => {
    if (activeMarkers[b.getAttribute('data-panel')]) b.classList.add('active');
  });
}

// ---- run.txt — beginner-friendly easy-read summary (shown FIRST) ----
function beginnerSummaryHtml(r) {
  const bs = r.beginner_summary;
  if (!bs) return '';
  const found = (bs.what_we_found || []).map(f => `
    <li style="margin-bottom:8px;">
      <strong style="color:#258DC1;">${escapeHtml(f.title)}:</strong>
      ${f.text ? `<span style="color:var(--ink-700);">${escapeHtml(f.text)}</span>` : ''}
    </li>`).join('');
  const measures = (bs.measurements || []).map(m => `<li>${escapeHtml(m)}</li>`).join('');
  const next = (bs.recommended_next || []).map(m => `<li>${escapeHtml(m)}</li>`).join('');
  return `
    <div class="mt-16" style="background:linear-gradient(90deg,#F0F7FC,#FBFDFE); border:1px solid #C99436; border-radius:12px; padding:16px 18px;">
      <h4 style="margin:0; color:#1E3C82;">Beginner-Friendly Summary (Easy Read)</h4>
      <div style="height:2px; background:#C99436; width:160px; margin:8px 0 12px;"></div>
      <p style="font-size:1rem; font-weight:600; color:#1E3C82; margin:0 0 8px;">${escapeHtml(bs.headline)}</p>
      ${bs.walking ? `<p style="font-size:.92rem; color:var(--ink-700); margin:0 0 10px;">${escapeHtml(bs.walking)}</p>` : ''}
      ${found ? `<p style="font-weight:600; font-size:.92rem; margin:8px 0 4px;">What we could see:</p><ul style="margin:0 0 8px 18px; display:grid; gap:4px;">${found}</ul>` : ''}
      ${measures ? `<p style="font-weight:600; font-size:.92rem; margin:8px 0 4px;">Body measurements:</p><ul style="margin:0 0 8px 18px; display:grid; gap:4px; font-size:.9rem; color:var(--ink-700);">${measures}</ul>` : ''}
      ${next ? `<p style="font-weight:600; font-size:.92rem; margin:8px 0 4px; color:#2F7A4D;">What to do next:</p><ul style="margin:0 0 8px 18px; display:grid; gap:4px; font-size:.9rem; color:var(--ink-700);">${next}</ul>` : ''}
      ${bs.confidence_note ? `<p style="font-size:.78rem; color:var(--ink-500); font-style:italic; margin:8px 0 0; border-top:1px dashed #E1EEF8; padding-top:8px;">${escapeHtml(bs.confidence_note)}</p>` : ''}
    </div>`;
}

// ---- run.txt §1/§2/§5 — name verification, anthropometry, integrity ledger ----
function nameVerificationHtml(r) {
  const nm = r.name_metadata || {};
  if (!nm.status) return '';
  const verified = nm.status === 'verified';
  const deferred = nm.status === 'deferred';
  const badge = verified
    ? '<span class="status-badge status-confirmed">Name verified</span>'
    : `<span class="status-badge" style="background:#FDF3E3; color:#8a5a00;">${deferred ? 'Name check pending (runs at export)' : 'Unverified Name Metadata'}</span>`;
  const detail = verified
    ? `The patient name in the video overlay (${escapeHtml(nm.matched_name || '')}) matched the session patient.`
    : deferred
      ? escapeHtml(nm.reason || 'The name overlay is read by OCR when you export the PDF/Word report.')
      : escapeHtml(nm.reason || 'The recorded name overlay could not be confirmed against the session patient.');
  return `
    <div class="mt-16" style="background:#FBFDFE; border:1px solid #E1EEF8; border-radius:10px; padding:10px 12px;">
      <div class="tags" style="gap:8px;">${badge}</div>
      <p style="font-size:.82rem; color:var(--ink-600); margin-top:6px;">${detail}</p>
    </div>`;
}

function amber(text) {
  return `<span style="color:#8a5a00;">${text}</span>`;
}

const ANTHRO_LABELS = {
  femur: 'Femur length', tibia: 'Tibia length', foot: 'Foot length',
  upper_arm: 'Upper arm length', forearm: 'Forearm length',
  shoulder_width: 'Shoulder width', wrist_width: 'Wrist width'
};
function anthropometryHtml(r) {
  const a = r.anthropometry;
  if (!a || !a.segments || !a.segments.length) return '';
  const calib = a.calibration || {};
  const calibBadge = calib.status === 'calibrated'
    ? `<span class="status-badge status-confirmed">Calibrated with physician height ${escapeHtml(calib.height_cm)} cm</span>`
    : `<span class="status-badge" style="background:#FDF3E3; color:#8a5a00;">UNCONVERTED — pixel-only (no physician height provided)</span>`;
  const rows = a.segments.map(seg => {
    const name = ANTHRO_LABELS[seg.code] || seg.code.replace(/_/g, ' ');
    const side = seg.side === 'L' ? 'Left' : (seg.side === 'R' ? 'Right' : '');
    const val = seg.status === 'assessed'
      ? (seg.unit === 'cm' ? `${seg.value} cm` : (seg.unit === 'fraction_of_stature' ? `${(seg.value * 100).toFixed(1)}% of stature` : seg.value))
      : amber(`Unassessed — ${escapeHtml(seg.reason || 'insufficient confidence')}`);
    return `<tr>
      <td><strong>${escapeHtml(name)}</strong>${side ? ` <span style="color:var(--ink-500); font-size:.78rem;">(${side})</span>` : ''}</td>
      <td style="color:var(--ink-600);">${val}</td>
      <td style="color:var(--ink-500); font-size:.78rem;">confidence ${(seg.confidence * 100).toFixed(0)}%</td>
    </tr>`;
  }).join('');
  return `
    <h4 class="mt-24">Anthropometric Measurements</h4>
    <div class="mt-8 tags" style="gap:8px;">${calibBadge}</div>
    <p style="font-size:.82rem; color:var(--ink-500); margin-top:6px;">${escapeHtml(a.notes || '')}</p>
    <div class="mt-8" style="overflow-x:auto;">
      <table class="admin-table"><thead><tr><th>Segment</th><th>Length</th><th>Confidence</th></tr></thead><tbody>${rows}</tbody></table>
    </div>`;
}

function integrityHtml(r) {
  const it = r.integrity;
  if (!it) return '';
  const unassessed = it.unassessed || [];
  const total = (it.parameters || []).length;
  const rows = (it.parameters || []).map(p => {
    const cell = p.status === 'assessed'
      ? '<span class="status-badge status-confirmed">Assessed</span>'
      : '<span class="status-badge" style="background:#FDF3E3; color:#8a5a00;">Unassessed</span>';
    return `<tr>
      <td><code style="font-size:.78rem;">${escapeHtml(p.parameter)}</code></td>
      <td>${p.status === 'assessed' ? '✓' : '—'}</td>
      <td>${cell}</td>
      <td style="font-size:.78rem; color:var(--ink-500);">${(p.confidence * 100).toFixed(0)}%</td>
    </tr>`;
  }).join('');
  const unassessedBlock = unassessed.length ? `
    <div class="mt-8" style="background:#FDF6ED; border-left:4px solid #B3452F; border-radius:6px; padding:8px 12px; font-size:.84rem;">
      <p style="font-weight:600;">Parameters reported as Unassessed (never interpolated):</p>
      <ul style="margin:4px 0 0 18px; display:grid; gap:4px; color:var(--ink-700);">
        ${unassessed.map(u => `<li><strong>${escapeHtml(u.parameter)}</strong> — ${escapeHtml(u.reason)}</li>`).join('')}
      </ul>
    </div>` : '';
  return `
    <details class="gait-details mt-24">
      <summary>
        <span style="font-weight:700; color:#1E3C82; font-size:1rem;">Data Integrity &amp; Confidence (Zero-Assumption Protocol)</span>
        <span class="tags" style="gap:6px; flex-wrap:wrap;">
          <span class="status-badge ${it.status === 'assessed' ? 'status-confirmed' : ''}">${it.status === 'assessed' ? 'All parameters assessed' : 'Partial assessment'}</span>
          <span class="status-badge">${total} parameters</span>
          <span class="status-badge">gate ≥ 60% keypoint confidence</span>
        </span>
      </summary>
      <div class="mt-8">
        <p style="font-size:.82rem; color:var(--ink-600);">${escapeHtml(it.summary || '')}</p>
        <div class="mt-8" style="overflow-x:auto; max-height:320px; overflow-y:auto;">
          <table class="admin-table"><thead><tr><th>Parameter</th><th>Reported</th><th>Status</th><th>Confidence</th></tr></thead><tbody>${rows}</tbody></table>
        </div>
        ${unassessedBlock}
      </div>
    </details>`;
}

// ---- rules.md — patient/session metadata bar + executive KPI cards ----
function genderLabel(g) {
  if (!g) return '';
  const map = { male: 'Male', female: 'Female', other: 'Other' };
  return map[String(g).toLowerCase()] || g;
}

function metadataBarHtml(s, r) {
  const badges = [`Session #${s.id}`];
  const meta = [];
  if (s.age_years != null) meta.push(`${escapeHtml(String(s.age_years))}y`);
  if (s.gender) meta.push(escapeHtml(genderLabel(s.gender)));
  if (s.body_mass_kg != null) meta.push(`${escapeHtml(String(s.body_mass_kg))} kg`);
  if (s.height_cm != null) meta.push(`Ht ${escapeHtml(String(s.height_cm))} cm`);
  if (meta.length) badges.push(meta.join(' · '));
  if (s.clinician_name) badges.push(`Clinician: ${escapeHtml(s.clinician_name)}`);
  if (s.created_at) badges.push(`Date: ${escapeHtml(formatDate(s.created_at))}`);
  const engineBadge = `<span class="status-badge" style="background:${r.mode === 'video' ? '#EAF6EE' : '#FDF3E3'}; color:${r.mode === 'video' ? '#2F7A4D' : '#8a5a00'};">Analysis engine: ${r.mode === 'video' ? 'BRC Biomechanical Engine' : 'Demo simulation'}</span>`;
  const reviewedBadge = s.status === 'reviewed'
    ? `<span class="status-badge status-confirmed">Reviewed by ${escapeHtml(s.reviewed_by || 'staff')}</span>` : '';
  return `
    <div class="mt-8 gait-meta">
      <div class="tags" style="gap:8px; flex-wrap:wrap;">
        ${badges.map((b, i) => `<span class="status-badge" style="font-size:.82rem;">${b}</span>`).join('')}
      </div>
      <div class="mt-8 tags" style="gap:8px; flex-wrap:wrap;">
        ${engineBadge}
        ${routingBadgeHtml(r)}
        ${reviewedBadge}
      </div>
      ${s.notes ? `<p class="mt-8" style="font-size:.82rem; color:var(--ink-600);"><strong>Session notes:</strong> ${escapeHtml(s.notes)}</p>` : ''}
    </div>`;
}

function kpiCardsHtml(r, cycle) {
  const stancePct = cycle.stance_pct;
  const swingPct = cycle.swing_pct;
  const cadence = cycle.cadence_cycles_per_second;
  const cycleS = cycle.cycle_seconds;
  const running = cycle.running ? '<span class="status-badge" style="background:#B3452F; color:#fff;">Running</span>' : '';
  const findings = (r.focus_areas || []).map(f => `<span class="status-badge status-confirmed" style="cursor:default;">${escapeHtml(f)}</span>`).join('');
  return `
    <div class="gait-kpis">
      <div class="gait-kpi">
        <p class="gait-kpi-label">Gait Cycle Split</p>
        <div class="gait-bar mt-8"><div class="gait-stance" style="width:${Math.max(2, stancePct)}%;"></div><div class="gait-swing" style="width:${Math.max(2, 100 - stancePct)}%;"></div></div>
        <p class="mt-8" style="font-size:.85rem; color:var(--ink-600);">Stance <strong>${stancePct}%</strong> / Swing <strong>${swingPct}%</strong></p>
      </div>
      <div class="gait-kpi">
        <p class="gait-kpi-label">Cadence</p>
        <p class="gait-kpi-value">${cadence != null ? cadence + ' cycles/sec' : '—'}</p>
        <p class="mt-8" style="font-size:.85rem; color:var(--ink-600);">${cycleS != null ? cycleS + ' s per cycle' : ''} ${running}</p>
      </div>
      <div class="gait-kpi">
        <p class="gait-kpi-label">Primary Findings</p>
        <div class="mt-8 tags" style="gap:6px; flex-wrap:wrap;">${findings || '<span style="font-size:.85rem; color:var(--ink-500);">See clinical impression below.</span>'}</div>
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Multi-view system: role-driven preview switcher + dynamic SVG/Chart visuals
// ---------------------------------------------------------------------------

function formatShortDate(ds) {
  const d = new Date(ds);
  if (isNaN(d)) return String(ds || '').slice(0, 10);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function viewSwitcherHtml(vm) {
  if (!vm || !vm.user || !vm.user.canPreview) return '';
  const open = activeViewId || vm.user.defaultView || 'v1';
  const btns = vm.views.map(v => `
    <button type="button" class="gait-tab view-switch ${v.id === open ? 'active' : ''}" data-view="${v.id}"
      title="${escapeHtml(v.description)}" style="border-left:3px solid ${escapeHtml(v.accent || '#1E3C82')};">${escapeHtml(v.label)}</button>`).join('');
  return `
    <div class="view-switch-row" role="group" aria-label="Preview this report as a different role">
      <span class="view-switch-label">Preview as:</span>
      <div class="gait-tabs view-switch-tabs" role="tablist" aria-label="Report views">${btns}</div>
    </div>`;
}

// ---- C2: SVG radial symmetry gauges ----
function gPt(a, r, cx, cy) {
  return { x: cx + r * Math.cos(a), y: cy - r * Math.sin(a) };
}
function gArc(a1, r, cx, cy) {
  const p0 = gPt(Math.PI, r, cx, cy);
  const p1 = gPt(a1, r, cx, cy);
  const large = (a1 - Math.PI) > Math.PI ? 1 : 0;
  return `M ${p0.x.toFixed(2)} ${p0.y.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${p1.x.toFixed(2)} ${p1.y.toFixed(2)}`;
}
function symDialHtml(pct, opts) {
  const o = opts || {};
  if (pct == null || !Number.isFinite(pct)) return '';
  const v = Math.max(0, Math.min(100, pct));
  const cx = 70, cy = 72, R = 54, rInner = R - 8;
  const good = o.good != null ? o.good : 95;
  const warn = o.warn != null ? o.warn : 90;
  const start = Math.PI;
  const end = 2 * Math.PI;
  const valA = start + (end - start) * (v / 100);
  const warnA = start + (end - start) * (warn / 100);
  const goodA = start + (end - start) * (good / 100);
  const band = v >= good ? '#2E8540' : (v >= warn ? '#C99436' : '#B3452F');
  const needleP = gPt(valA, R - 14, cx, cy);
  const label = o.label || 'Symmetry';
  return `
    <div class="dial" title="${escapeHtml(o.title || label)}: ${v}% (higher = more symmetrical)">
      <svg viewBox="0 0 140 104" role="img" aria-label="${escapeHtml(label)}: ${v}%">
        <path d="${gArc(end + 0.001, rInner, cx, cy)}" fill="none" stroke="#E8EDF3" stroke-width="11" stroke-linecap="round"/>
        <path d="${gArc(warnA, rInner, cx, cy)}" fill="none" stroke="#F3C1B0" stroke-width="11" stroke-linecap="round"/>
        <path d="${gArc(goodA, rInner, cx, cy)}" fill="none" stroke="#EBD7A8" stroke-width="11" stroke-linecap="round"/>
        <path d="${gArc(valA, rInner, cx, cy)}" fill="none" stroke="${band}" stroke-width="11" stroke-linecap="round"/>
        <path d="M ${cx} ${cy} L ${needleP.x.toFixed(2)} ${needleP.y.toFixed(2)}" stroke="#232520" stroke-width="2.5" stroke-linecap="round"/>
        <circle cx="${cx}" cy="${cy}" r="4.5" fill="#232520"/>
        <text x="${cx}" y="${cy + 22}" text-anchor="middle" font-size="18" font-weight="700" fill="${band}">${v}%</text>
      </svg>
      <div class="dial-label">${escapeHtml(label)}</div>
      ${o.sub ? `<div class="dial-sub">${escapeHtml(o.sub)}</div>` : ''}
    </div>`;
}
function symmetryDialsHtml(r) {
  const dials = [];
  const sag = r.cv && r.cv.sagittal;
  const fro = r.cv && r.cv.frontal;
  if (sag && sag.status === 'ok') {
    dials.push(symDialHtml(sag.stride_symmetry, { label: 'Stride symmetry', sub: 'sagittal · cycle timing' }));
    if (sag.specific) {
      dials.push(symDialHtml(sag.specific.shoulder_flex_si, { label: 'Shoulder flexion SI', sub: 'sagittal' }));
      dials.push(symDialHtml(sag.specific.elbow_flex_si, { label: 'Elbow flexion SI', sub: 'sagittal' }));
    }
  }
  if (fro && fro.metrics && fro.metrics.coronal_load && fro.metrics.coronal_load.symmetry_pct != null) {
    dials.push(symDialHtml(fro.metrics.coronal_load.symmetry_pct, { label: 'Coronal load symmetry', sub: 'frontal · weight distribution' }));
  }
  const c3 = r.cv3d;
  if (c3 && c3.symmetry) {
    dials.push(symDialHtml(c3.symmetry.knee_flex_si, { label: '3D knee flexion SI', sub: 'dual-plane' }));
    dials.push(symDialHtml(c3.symmetry.hip_flex_si, { label: '3D hip flexion SI', sub: 'dual-plane' }));
  }
  if (!dials.length) return '';
  return `
    <h4 class="mt-24">Symmetry Gauges (Left ↔ Right)</h4>
    <div class="dial-grid">${dials.join('')}</div>`;
}

// ---- C1: interactive SVG stride timeline ----
function strideTimelineHtml(cycle, r) {
  const phases = (cycle && cycle.phases) || [];
  if (!phases.length) return '';
  const W = 960, X0 = 40, SW = W - 40;
  let acc = 0;
  const segs = phases.map((p, i) => {
    const w = Math.max(6, (p.pct_of_cycle / 100) * SW);
    const x = X0 + acc;
    acc += (p.pct_of_cycle / 100) * SW;
    const flagged = p.flag != null && p.flag !== 'none';
    const status = p.flag === 'none' ? 'Normal timing' : `${p.classification || p.flag}${p.severity ? ' · ' + p.severity : ''}`;
    return `
      <g class="stride-seg${flagged ? ' flagged' : ''}" data-phase="${i}" role="button" tabindex="0"
         aria-label="${escapeHtml(p.name)}: ${p.pct_of_cycle}% of cycle, ${status}">
        <rect x="${x.toFixed(1)}" y="16" width="${w.toFixed(1)}" height="38" rx="7"
          fill="${p.type === 'stance' ? '#46B4DC' : '#9fc3e0'}" stroke="${flagged ? '#B3452F' : 'transparent'}" stroke-width="1.5"/>
        ${p.pct_of_cycle >= 7 ? `<text x="${(x + w / 2).toFixed(1)}" y="40" text-anchor="middle" font-size="11" font-weight="700" fill="#0e1b14">${p.pct_of_cycle}%</text>` : ''}
        <title>${escapeHtml(p.name)} — ${p.pct_of_cycle}% of cycle (norm ${p.norm_pct_of_cycle}%) · ${Math.round(p.duration_ms)} ms · ${status}</title>
        <line x1="${(x + w / 2).toFixed(1)}" y1="58" x2="${(x + w / 2).toFixed(1)}" y2="72" stroke="#AEBCC9" stroke-width="1"/>
      </g>`;
  }).join('');
  const stanceNorm = cycle.stance_norm_band || [58, 62];
  const normX0 = X0 + (stanceNorm[0] / 100) * SW;
  const normX1 = X0 + (stanceNorm[1] / 100) * SW;
  return `
    <div class="stride-timeline mt-8">
      <svg viewBox="0 0 1000 96" role="group" aria-label="One gait cycle. Stance phases are blue, swing phases pink. Longer segments mean a phase takes more time; flagged (red-outlined) phases fall outside the normative bandwidth.">
        <line x1="40" y1="93" x2="1000" y2="93" stroke="#E1EEF8" stroke-width="2"/>
        <g>
          <line x1="${normX0.toFixed(1)}" y1="4" x2="${normX0.toFixed(1)}" y2="16" stroke="#2E8540" stroke-width="2" stroke-dasharray="3 3"/>
          <line x1="${normX1.toFixed(1)}" y1="4" x2="${normX1.toFixed(1)}" y2="16" stroke="#2E8540" stroke-width="2" stroke-dasharray="3 3"/>
          <text x="${((normX0 + normX1) / 2).toFixed(1)}" y="12" text-anchor="middle" font-size="9" fill="#2E8540">normative stance band ${stanceNorm[0]}–${stanceNorm[1]}%</text>
        </g>
        ${segs}
      </svg>
      <div class="gait-legend">
        <span><span class="dot" style="background:#46B4DC;"></span>Stance</span>
        <span><span class="dot" style="background:#9fc3e0;"></span>Swing</span>
        <span style="color:#B3452F;">&#9650; longer than normative</span>
        <span style="color:#258DC1;">&#9660; shorter than normative</span>
        <span><span class="dot" style="border:1.5px solid #B3452F; width:8px; height:8px;"></span>flagged phase</span>
      </div>
    </div>`;
}

// ---- C3: confidence histogram with the 0.60 gate ----
function confidenceHistogramHtml(r) {
  const it = r.integrity;
  const rows = it && it.parameters && it.parameters.length ? it.parameters : null;
  if (!rows) return '';
  const labels = rows.map(p => p.parameter);
  const values = rows.map(p => Math.round((p.confidence == null ? 0 : p.confidence) * 100));
  const colors = rows.map(p => (p.status === 'assessed' ? '#2E8540' : '#C99436'));
  if (!window.__gaitChartData) window.__gaitChartData = {};
  window.__gaitChartData['gait-confidence'] = {
    type: 'bar',
    options: {
      plugins: { legend: { labels: { boxWidth: 14 } } },
      scales: { x: { ticks: { maxRotation: 60, font: { size: 10 } } }, y: { min: 0, max: 100, title: { display: true, text: 'Confidence (%)' } } }
    },
    data: {
      labels,
      datasets: [
        { label: 'Keypoint confidence', data: values, backgroundColor: colors, borderRadius: 4 },
        { label: 'Confidence gate (60%)', data: values.map(() => 60), type: 'line', borderColor: '#B3452F', borderWidth: 2, pointRadius: 0, fill: false }
      ]
    }
  };
  return `
    <h4 class="mt-24">Per-Parameter Confidence (gate ≥ 60%)</h4>
    <div class="mt-8" style="background:#fff; border:1px solid #E1EEF8; border-radius:10px; padding:10px;">
      <div style="position:relative; height:260px;"><canvas data-gait-chart="gait-confidence"></canvas></div>
    </div>`;
}

// ---- V5 audit warnings ----
function warningsHtml(s, r) {
  const items = [];
  const it = r.integrity;
  if (it && it.unassessed && it.unassessed.length) {
    items.push(`<li><strong>${it.unassessed.length} parameter(s) reported unassessed</strong> — never interpolated: ${it.unassessed.map(u => escapeHtml(u.parameter)).join(', ')}.</li>`);
  }
  const nm = r.name_metadata || {};
  if (nm.status && nm.status !== 'verified' && nm.status !== 'deferred') {
    items.push(`<li><strong>Name-overlay OCR</strong> is not verified (status: ${escapeHtml(nm.status)}).</li>`);
  }
  const hasCv = r.cv && (r.cv.sagittal || r.cv.frontal);
  if (!hasCv) items.push(`<li><strong>No tracked CV planes</strong> present for this session.</li>`);
  if (!r.cv3d || r.cv3d.status !== 'ok') items.push('<li>3D triangulation was not produced for this session.</li>');
  if (s.status !== 'reviewed') items.push(`<li>Session <strong>not yet reviewed / signed off</strong> (status: ${escapeHtml(s.status || 'analyzed')}).</li>`);
  if (!items.length) return '';
  return `
    <div class="qa-warnings mt-24">
      <p style="font-weight:700; color:#B3452F; font-size:.9rem;">QA / Audit Warnings</p>
      <ul style="margin:6px 0 0 18px; display:grid; gap:5px; font-size:.84rem; color:var(--ink-700);">${items.join('')}</ul>
    </div>`;
}

// ---- C4: OCR re-scan panel (V5) ----
function nameMetaChips(nm) {
  const badge = nm.status === 'verified'
    ? '<span class="status-badge status-confirmed">Verified</span>'
    : nm.status === 'deferred'
      ? '<span class="status-badge" style="background:#FDF3E3; color:#8a5a00;">Pending — runs at export</span>'
      : '<span class="status-badge" style="background:#FBE9E4; color:#B3452F;">Unverified</span>';
  const seen = (nm.texts_seen || []).slice(0, 6).map(t => `<span class="ocr-chip">${escapeHtml(String(t))}</span>`).join(' ');
  return `
    <div class="tags" style="gap:8px; flex-wrap:wrap;">${badge}${nm.engine ? `<span class="status-badge">engine ${escapeHtml(nm.engine)}</span>` : ''}</div>
    ${nm.reason ? `<p class="mt-8" style="font-size:.82rem; color:var(--ink-600);">${escapeHtml(nm.reason)}</p>` : ''}
    ${nm.matched_name ? `<p class="mt-8" style="font-size:.82rem;"><strong>Read name:</strong> ${escapeHtml(nm.matched_name)} · expected: ${escapeHtml(nm.expected_name || '')}${nm.confidence != null ? ' · confidence ' + Math.round(nm.confidence * 100) + '%' : ''}</p>` : ''}
    ${seen ? `<p class="mt-8 ocr-seen">Texts seen in overlay: ${seen}</p>` : ''}`;
}
function ocrPanelHtml(s, r) {
  const nm = r.name_metadata || {};
  const admin = currentUser && (currentUser.role === 'admin' || currentUser.role === 'super_admin');
  return `
    <h4 class="mt-24">Video-Overlay OCR (Name Provenance)</h4>
    <div class="mt-8 gait-details-card" id="gait-ocr-panel">
      <div id="gait-ocr-status">${nm.status ? nameMetaChips(nm) : '<span class="status-badge">OCR not configured</span>'}</div>
      ${admin ? `<button class="btn btn-outline btn-sm mt-8" id="gait-ocr-rescan-btn">Re-scan overlay (OCR)</button>` : ''}
    </div>`;
}
function setupOCRPanel(s) {
  const btn = document.getElementById('gait-ocr-rescan-btn');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    const orig = btn.textContent;
    btn.textContent = 'Scanning overlay… (may take a few minutes)';
    const status = document.getElementById('gait-ocr-status');
    if (status) status.innerHTML = '<p class="empty-state">Scanning the video overlay for the patient name…</p>';
    try {
      const res = await fetchWithTimeout(`/api/gait/admin/sessions/${s.id}/ocr`, { method: 'POST' }, 360000);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'OCR scan failed.');
      if (status) status.innerHTML = nameMetaChips(data.name_metadata || {});
    } catch (err) {
      if (status) status.innerHTML = `<p class="mt-8" style="color:#B3452F; font-size:.84rem;">OCR scan failed: ${escapeHtml(err.message || 'try again')}</p>`;
    } finally {
      btn.disabled = false;
      btn.textContent = orig;
    }
  });
}

// ---- C5: raw JSON viewer + session diff ----
function highlightJson(obj) {
  let s;
  try { s = JSON.stringify(obj, null, 2); } catch (e) { s = String(obj); }
  s = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  s = s.replace(/("[^"]*")(\s*:)?/g, (m, str, colon) => colon ? `<span class="j-key">${str}</span>${colon}` : `<span class="j-str">${str}</span>`);
  s = s.replace(/\b(\d+(?:\.\d+)?)\b/g, '<span class="j-num">$1</span>');
  s = s.replace(/\b(true|false|null)\b/g, '<span class="j-bool">$1</span>');
  return s;
}
function rawJsonHtml(s, r) {
  if (!r) return '';
  return `
    <details class="gait-details mt-24">
      <summary>
        <span style="font-weight:700; color:#1E3C82; font-size:1rem;">Raw Results JSON &amp; Session Diff</span>
        <span class="tags" style="gap:6px;"><span class="status-badge">QA only</span></span>
      </summary>
      <div class="mt-8">
        <div class="tags" style="gap:8px; flex-wrap:wrap;">
          <select id="json-diff-sel" style="font-size:.82rem; padding:4px 8px; border:1px solid #CBD5E1; border-radius:6px; background:#fff; color:#232520; max-width:280px;">
            <option value="">— compare with a past session —</option>
          </select>
          <button class="btn btn-outline btn-sm" id="json-diff-btn" disabled>Show diff</button>
        </div>
        <pre class="json-view mt-8">${highlightJson(r)}</pre>
      </div>
    </details>`;
}
function flattenMap(obj, prefix, out, depth) {
  if (!obj || typeof obj !== 'object') return out;
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    const key = prefix ? prefix + '.' + k : k;
    if (v == null) continue;
    if (typeof v === 'number' && Number.isFinite(v)) out[key] = v;
    else if (typeof v === 'string' && (prefix === '' || depth < 1)) out[key] = v;
    else if (typeof v === 'object' && depth < 2) flattenMap(v, key, out, depth + 1);
  }
  return out;
}
async function setupRawJsonSection(s) {
  const sel = document.getElementById('json-diff-sel');
  const btn = document.getElementById('json-diff-btn');
  if (!sel || !btn) return;
  let points = (_progressionCache && _progressionCache[s.id]) || [];
  if (!points.length) {
    try {
      const res = await fetch(`/api/gait/sessions/${s.id}/progression`);
      if (res.ok) { const d = await res.json(); points = d.points || []; _progressionCache[s.id] = points; }
    } catch (e) { /* ignore */ }
  }
  const others = points.filter(p => p.id !== s.id);
  if (others.length) {
    others.slice().reverse().forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = `#${p.id} · ${p.created_at ? String(p.created_at).slice(0, 10) : '?'}`;
      sel.appendChild(opt);
    });
  }
  sel.addEventListener('change', () => { btn.disabled = !sel.value; });
  btn.addEventListener('click', () => showJsonDiff(s, sel.value));
}
async function showJsonDiff(s, otherId) {
  if (!otherId) return;
  const body = document.getElementById('report-body');
  if (!body) return;
  let other = null;
  try {
    const res = await fetch(`/api/gait/sessions/${otherId}`);
    if (res.ok) { const d = await res.json(); other = d.session; }
  } catch (e) { /* ignore */ }
  const a = window.__lastSession && window.__lastSession.results;
  const b = other && other.results;
  const overlay = document.createElement('div');
  overlay.id = 'gait-diff-modal';
  overlay.className = 'diff-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  const close = () => { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); document.body.style.overflow = ''; };
  let inner;
  if (!a || !b) {
    inner = `<p style="color:var(--ink-700);">Could not load both result sets for comparison.</p>`;
  } else {
    const am = flattenMap(a, '', {}, 0);
    const bm = flattenMap(b, '', {}, 0);
    const keys = Array.from(new Set(Object.keys(am).concat(Object.keys(bm)))).sort();
    const rows = keys.map(k => {
      const av = am[k];
      const bv = bm[k];
      const deltaMark = (typeof av === 'number' && typeof bv === 'number')
        ? `<span class="j-del">${bv >= av ? '+' : ''}${(bv - av).toFixed(2)}</span>` : '';
      return `<tr><td><code>${escapeHtml(k)}</code></td><td>${av == null ? '—' : escapeHtml(String(av))}</td><td>${bv == null ? '—' : escapeHtml(String(bv))}</td><td>${deltaMark}</td></tr>`;
    }).join('');
    inner = `<div style="max-height:400px; overflow:auto;"><table class="admin-table" style="font-size:.8rem;">
      <thead><tr><th>Metric path</th><th>Current (#${s.id})</th><th>Compared (#${otherId})</th><th>Δ</th></tr></thead><tbody>${rows || '<tr><td colspan="4">No comparable numeric metrics.</td></tr>'}</tbody></table></div>`;
  }
  overlay.innerHTML = `
    <div class="modal-card">
      <h3 style="margin:0 0 10px; color:#1E3C82; font-size:1.05rem;">Session result diff</h3>
      ${inner}
      <div class="modal-actions"><button type="button" class="btn btn-ghost" id="gait-diff-close">Close</button></div>
    </div>`;
  document.body.appendChild(overlay);
  document.body.style.overflow = 'hidden';
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  const cbtn = overlay.querySelector('#gait-diff-close');
  if (cbtn) cbtn.addEventListener('click', close);
  const kd = e => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', kd); } };
  document.addEventListener('keydown', kd);
}

// ---- C6: multi-session progression (V3) ----
function progressionHtml(s) {
  return `
    <details class="gait-details mt-24">
      <summary>
        <span style="font-weight:700; color:#1E3C82; font-size:1rem;">Progression Across Sessions</span>
        <span class="tags" style="gap:6px;"><span class="status-badge">Analyst workspace</span></span>
      </summary>
      <div class="mt-8" id="gait-progression-body"><p class="empty-state">Loading progression data…</p></div>
    </details>`;
}
function progLine(label, color, data) {
  return { label, data, borderColor: color, backgroundColor: color, pointRadius: 3, borderWidth: 2, tension: 0.3, spanGaps: true };
}
async function loadProgression(s) {
  const body = document.getElementById('gait-progression-body');
  if (!body) return;
  try {
    const res = await fetchWithTimeout(`/api/gait/sessions/${s.id}/progression`, {}, 30000);
    if (!res.ok) throw new Error();
    const { points } = await res.json();
    _progressionCache[s.id] = points || [];
    if (!points || points.length < 2) {
      body.innerHTML = '<p class="empty-state">At least two analyzed sessions are needed to chart progress over time.</p>';
      return;
    }
    document.querySelectorAll('#gait-progression-body canvas[data-gait-chart]').forEach(cd => {
      try { const ch = Chart.getChart(cd); if (ch) ch.destroy(); } catch (e) { /* ignore */ }
      delete cd.dataset._built;
    });
    window.__gaitChartData = window.__gaitChartData || {};
    const labels = points.map(p => formatShortDate(p.created_at));
    const items = [];
    const addChart = (id, title, unit, ds) => {
      window.__gaitChartData[id] = {
        type: 'line',
        options: {
          plugins: { legend: { labels: { boxWidth: 14 } } },
          scales: { x: { title: { display: true, text: 'Session' } }, y: { title: { display: true, text: unit } } }
        },
        data: { labels, datasets: ds }
      };
      items.push(`
        <div style="border:1px solid #E1EEF8; border-radius:10px; background:#fff; padding:10px;">
          <p style="font-size:.85rem; font-weight:600; color:#1E3C82; margin-bottom:6px;">${escapeHtml(title)}</p>
          <div style="position:relative; height:220px;"><canvas data-gait-chart="${id}"></canvas></div>
        </div>`);
    };
    addChart('gait-prog-stance', 'Stance share of gait cycle', '% of cycle', [progLine('Stance', '#46B4DC', points.map(p => p.stance_pct))]);
    addChart('gait-prog-cadence', 'Cadence', 'cycles/sec', [progLine('Cadence', '#1E3C82', points.map(p => p.cadence))]);
    const kneeDs = [];
    if (points.some(p => p.knee_max_L != null)) kneeDs.push(progLine('Left knee peak', '#1E3C82', points.map(p => p.knee_max_L)));
    if (points.some(p => p.knee_max_R != null)) kneeDs.push(progLine('Right knee peak', '#C99436', points.map(p => p.knee_max_R)));
    if (kneeDs.length) addChart('gait-prog-knee', 'Peak knee flexion (L/R)', 'degrees', kneeDs);
    const symDs = [];
    if (points.some(p => p.stride_symmetry != null)) symDs.push(progLine('Stride symmetry', '#2E8540', points.map(p => p.stride_symmetry)));
    if (points.some(p => p.knee_flex_si != null)) symDs.push(progLine('Knee flexion SI', '#C99436', points.map(p => p.knee_flex_si)));
    if (symDs.length) addChart('gait-prog-sym', 'Symmetry indices', '%', symDs);
    body.innerHTML = `<div class="prog-grid">${items.join('')}</div>`;
    setTimeout(() => buildPanelCharts('gait-progression-body'), 0);
  } catch (e) {
    body.innerHTML = '<p class="empty-state">Could not load progression data.</p>';
  }
}

// ---- smooth chart lifecycle (no hang, no leaks, reduced-motion aware) ----
function enrichChart(cfg) {
  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const o = cfg.options || {};
  return {
    ...cfg,
    options: {
      ...o,
      responsive: true,
      maintainAspectRatio: false,
      devicePixelRatio: Math.min(window.devicePixelRatio || 1, 2),
      animation: o.animation === false ? false : { duration: reduced ? 0 : 400 }
    }
  };
}
function buildPanelCharts(panelId) {
  if (!window.Chart) return;
  const panel = document.getElementById(panelId);
  if (!panel) return;
  const data = window.__gaitChartData || {};
  panel.querySelectorAll('canvas[data-gait-chart]').forEach(canvas => {
    if (canvas.dataset._built === '1') return;
    const cfg = data[canvas.getAttribute('data-gait-chart')];
    if (!cfg) return;
    try {
      _gaitCharts.push(new Chart(canvas, enrichChart(cfg)));
      canvas.dataset._built = '1';
    } catch (err) {
      console.warn('Gait chart render failed:', err);
    }
  });
}
function destroyPanelCharts(panelId) {
  const panel = document.getElementById(panelId);
  if (!panel) return;
  panel.querySelectorAll('canvas[data-gait-chart]').forEach(canvas => {
    try { const ch = Chart.getChart(canvas); if (ch) ch.destroy(); } catch (e) { /* ignore */ }
    delete canvas.dataset._built;
  });
  _gaitCharts = _gaitCharts.filter(c => {
    try { return !(c && c.canvas && panel.contains(c.canvas)); } catch (e) { return true; }
  });
}
function buildGaitCharts() {
  if (!window.Chart) return;
  destroyGaitCharts();
  document.querySelectorAll('.gait-tab-panel').forEach(p => buildPanelCharts(p.id));
  document.querySelectorAll('canvas[data-gait-chart]').forEach(canvas => {
    if (canvas.dataset._built === '1') return;
    const cfg = (window.__gaitChartData || {})[canvas.getAttribute('data-gait-chart')];
    if (!cfg) return;
    try {
      _gaitCharts.push(new Chart(canvas, enrichChart(cfg)));
      canvas.dataset._built = '1';
    } catch (err) { console.warn('Gait chart render failed:', err); }
  });
}
function destroyGaitCharts() {
  _gaitCharts.forEach(c => { try { if (c && typeof c.destroy === 'function') c.destroy(); } catch (e) { /* ignore */ } });
  _gaitCharts = [];
  document.querySelectorAll('canvas[data-gait-chart]').forEach(cd => delete cd.dataset._built);
}

function bindStrideTimeline() {
  document.addEventListener('click', e => {
    const seg = e.target && e.target.closest ? e.target.closest('.stride-seg') : null;
    if (!seg) return;
    const root = seg.closest('svg');
    if (root) root.querySelectorAll('.stride-seg.selected').forEach(x => x.classList.remove('selected'));
    seg.classList.add('selected');
  });
  document.addEventListener('keydown', e => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target && e.target.classList && e.target.classList.contains('stride-seg')) {
      e.preventDefault();
      e.target.click();
    }
  });
}

function bindViewSwitcher() {
  const vm = window.__viewMatrix;
  if (!vm || !vm.user || !vm.user.canPreview) return;
  document.addEventListener('click', e => {
    const btn = e.target && e.target.closest ? e.target.closest('.view-switch[data-view]') : null;
    if (!btn || !vm.user || !vm.user.allowedViews) return;
    const target = btn.getAttribute('data-view');
    if (vm.user.allowedViews.indexOf(target) === -1) {
      btn.disabled = true;
      setTimeout(() => { btn.disabled = false; }, 600);
      return;
    }
    activeViewId = target;
    document.querySelectorAll('.view-switch[data-view]').forEach(b => b.classList.toggle('active', b === btn));
    const s = window.__lastSession;
    if (s) renderCurrentView();
  });
}

function renderCurrentView() {
  const s = window.__lastSession;
  if (!s) return;
  const panel = document.getElementById('report-panel');
  const body = document.getElementById('report-body');
  if (!panel || !body) return;
  body.innerHTML = renderReport(s);
  bindReportTabs();
  bindStrideTimeline();
  bindViewSwitcher();
  if (window.Chart) window.requestAnimationFrame(() => buildGaitCharts());
  setupOCRPanel(s);
  setupRawJsonSection(s);
  const vm = window.__viewMatrix;
  const secFor = (id) => !vm || !vm.sectionViews || !vm.sectionViews[id] || vm.sectionViews[id].indexOf(activeViewId) !== -1;
  if (secFor('progression')) loadProgression(s);
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderReport(s) {
  const r = s.results;

  // 2e.txt — strict rejection: never render fake/empty metric sections. Show a
  // prominent notice with the exact professional message instead.
  if (r.mode === 'rejected' || (r.gait_validation && r.gait_validation.status && r.gait_validation.status !== 'ok')) {
    const msg = (r.gait_validation && r.gait_validation.message) || NO_VALID_GAIT_MSG;
    const reasonItems = ((r.gait_validation && r.gait_validation.reasons) || []).map(x => `<li>${escapeHtml(x)}</li>`).join('');
    const nm = r.name_metadata || {};
    const nameLine = nm.status ? `
      <p class="mt-8" style="font-size:.78rem; color:var(--ink-600);">
        <strong>Patient-name overlay verification:</strong>
        ${nm.status === 'verified' ? 'Verified against the recording overlay.' : nm.status === 'deferred' ? 'Pending — the name overlay is read by OCR when the PDF/Word report is exported.' : 'Unverified Name Metadata — ' + escapeHtml(nm.reason || 'the recorded name overlay could not be confirmed.')}
        ${nm.status === 'ocr_unavailable' ? ' (OCR unavailable on this server).' : ''}
      </p>` : '';
    return `
      <div class="gait-rejection-banner">
        <div class="alert alert-error" role="alert">
          <h4 style="margin:0 0 8px;">Analysis blocked — no metrics generated</h4>
          <p style="margin:0 0 8px;">${escapeHtml(msg)}</p>
          ${reasonItems ? `<ul style="margin:0 0 8px 18px; color:var(--ink-600); font-size:.85rem;">${reasonItems}</ul>` : ''}
          ${nameLine}
          <p style="margin:0; font-size:.85rem;">Upload a clear video of the patient walking straight in the specified plane and re-run the analysis.</p>
        </div>
      </div>
      <div class="mt-16">${beginnerSummaryHtml(r)}</div>
    `;
  }

  const cycle = r.cycle;
  const stanceW = Math.max(2, cycle.stance_pct);
  const flagClass = f => f === 'prolonged' ? 'flag-prolonged' : f === 'accelerated' ? 'flag-accelerated' : f === 'missing' ? 'flag-missing' : 'flag-normal';
  const flagLabel = f => f === 'none' ? 'Normal' : f;

  const phaseRows = cycle.phases.map(p => {
    const sign = (p.pct_delta < -0.05 ? '&#9660;' : (p.pct_delta > 0.05 ? '&#9650;' : ''));
    const deltaCls = p.pct_delta > 0.05 ? 'delta-pos' : (p.pct_delta < -0.05 ? 'delta-neg' : 'delta-ok');
    const normRange = Array.isArray(p.norm_range_pct) ? `${p.norm_range_pct[0]}–${p.norm_range_pct[1]}%` : `~${p.norm_pct_of_cycle}%`;
    const statusFlag = p.flag !== 'none'
      ? `${p.classification || p.flag}${p.severity ? ' · ' + p.severity : ''}`
      : 'Normal';
    return `
    <div class="phase-row">
      <span title="${escapeHtml(p.flag !== 'none' ? p.note : 'Normal phase timing.')}">${escapeHtml(p.name)}</span>
      <span>${escapeHtml(p.type)}</span>
      <span>${p.pct_of_cycle}%</span>
      <span class="${deltaCls}" title="Deviation from normative ${p.norm_pct_of_cycle}%">${sign}${p.pct_delta > 0 ? '+' : ''}${p.pct_delta}%</span>
      <span title="Normative reference range">${normRange}</span>
      <span>${Math.round(p.duration_ms)} ms</span>
      <span><span class="flag-chip ${flagClass(p.flag)}">${escapeHtml(statusFlag)}</span></span>
    </div>
  `;
  }).join('');

  const anomalyHtml = (cycle.anomalies || []).map(a => `
    <div class="sev-${a.severity} mt-8">
      <strong style="font-size:.9rem;">[${a.severity.toUpperCase()}] ${escapeHtml(a.phase_name)} — ${escapeHtml(a.type)}</strong>
      <div style="font-size:.85rem; color:var(--ink-600);">${escapeHtml(a.description)}</div>
    </div>
  `).join('') || '<p style="color:var(--sage-700); font-size:.9rem;">No anomalies flagged.</p>';

  const deformityList = plane => {
    const prof = r.profile[plane] || {};
    const defs = prof.deformities || [];
    if (defs.length) {
      return defs.map(d => `<li>${escapeHtml(d.name)} <em style="color:var(--ink-500);">(${escapeHtml(d.magnitude)}${d.category ? ' · ' + escapeHtml(d.category) : ''})</em> — ${escapeHtml(d.description)}</li>`).join('');
    }
    if (prof.assessed === false) {
      return `<li style="color:var(--ink-500);">Not assessed. ${escapeHtml(prof.note || 'No valid recording was available for this view.')}</li>`;
    }
    return '<li style="color:var(--sage-700);">None detected.</li>';
  };

  const romRows = r.kinematics.rom.map(x => `
    <tr><td>${escapeHtml(x.joint)}</td><td>${escapeHtml(x.movement)}</td><td>${escapeHtml(x.normal)}</td><td>${escapeHtml(x.observed)}</td></tr>
  `).join('');

  const muscleRows = (list, color) => list.map(m => `<li style="color:${color};"><strong>${escapeHtml(m.name)}</strong> — ${escapeHtml(m.role)}</li>`).join('') || '<li>None flagged.</li>';

  const refShortCite = x => x ? `[${x.id}] ${String(x.authors || '').replace(/ et al.*$/, '').split(' ').slice(0, 2).join(' ')} (${x.year})` : '';
  const evidenceLine = refs => (refs && refs.length) ? `Evidence: ${refs.map(refShortCite).join('; ')}` : '';

  const exRows = r.prescriptions.exercises.map(e => `
    <tr><td><strong>${escapeHtml(e.name)}</strong></td><td>${escapeHtml(e.frequency)}</td><td>${escapeHtml(e.reason)}</td></tr>
    ${(e.references && e.references.length) ? `<tr><td colspan="3" style="font-size:.78rem; color:#258DC1; padding-top:0;">${escapeHtml(evidenceLine(e.references))}</td></tr>` : ''}
  `).join('');

  const orthoHtml = (r.prescriptions.orthotics || []).map(o => `<li>${escapeHtml(o.component)} — ${escapeHtml(o.reason)}${(o.references && o.references.length) ? `<div style="font-size:.78rem; color:#258DC1;">${escapeHtml(evidenceLine(o.references))}</div>` : ''}</li>`).join('');
  const prosthHtml = (r.prescriptions.prosthetics || []).map(o => `<li>${escapeHtml(o.component)} — ${escapeHtml(o.reason)}${(o.references && o.references.length) ? `<div style="font-size:.78rem; color:#258DC1;">${escapeHtml(evidenceLine(o.references))}</div>` : ''}</li>`).join('');
  const guidanceHtml = (r.prescriptions.guidance || []).map(g => `<li>${escapeHtml(g)}</li>`).join('');
  const refSect = r.reference_sections || { core: r.references || [], supporting: [] };
  const refCategoryHtml = ([key, heading]) => {
    const list = key === 'core' ? (refSect.core || []) : (refSect[key] || []);
    if (!list.length) return '';
    return `
      <p style="font-weight:600; font-size:.9rem; margin-top:14px;">${escapeHtml(heading)}</p>
      <ol style="margin-left:18px; display:grid; gap:6px; font-size:.82rem; color:var(--ink-600);">
        ${list.map(x => `
          <li>
            ${x.id}. ${escapeHtml(x.authors)} (${x.year}). ${escapeHtml(x.title)}. <em>${escapeHtml(x.venue)}</em>.
            ${(x.topics || []).length ? `<div style="color:#258DC1; font-size:.72rem;">Relevant to: ${escapeHtml(x.topics.map(t => t.replace(/-/g, ' ')).join(', '))}</div>` : ''}
          </li>`).join('')}
      </ol>`;
  };
  const refsHtml = [
    ['core', 'Core gait-analysis references'],
    ['deformity', 'Evidence — deformity & alignment detection'],
    ['exercise', 'Evidence — exercise rehabilitation'],
    ['orthotic_prosthetic', 'Evidence — orthotic / prosthetic intervention'],
    ['prognosis', 'Evidence — progression & prognosis'],
    ['supporting', 'Supporting literature matched to findings'],
  ].map(refCategoryHtml).join('');

  const riskLevelBadge = level => {
    const lvl = String(level || '').toLowerCase();
    const color = /elevated|high/.test(lvl) ? '#B3452F' : (/moderate/.test(lvl) ? '#C99436' : '#2E8540');
    return `<span class="status-badge" style="background:${color}; color:#fff;">${escapeHtml(level)}</span>`;
  };

  const predictionHtml = r.prediction ? `
    <h4 class="mt-24">Prognostic / Predictive Risk Model</h4>
    <div class="mt-8" style="background:${r.prediction.severity === 'elevated' ? '#FDF0EC' : (r.prediction.severity === 'moderately elevated' ? '#FDF3E3' : '#EAF6EE')}; border-left:4px solid ${r.prediction.severity === 'elevated' ? '#B3452F' : (r.prediction.severity === 'moderately elevated' ? '#C99436' : '#2E8540')}; border-radius:8px; padding:12px 14px; font-size:.9rem;">
      <p style="font-weight:600; color:#1E3C82;">Projected risk severity: <span style="color:${r.prediction.severity === 'elevated' ? '#B3452F' : (r.prediction.severity === 'moderately elevated' ? '#C99436' : '#2E8540')};">${escapeHtml(r.prediction.severity)}</span>${(r.prediction.patterns || []).length ? ` — patterns: <strong>${escapeHtml(r.prediction.patterns.join(', '))}</strong>` : ''}</p>
      ${r.prediction.measured_note ? `<p class="mt-8" style="font-size:.82rem; color:var(--ink-500);">${escapeHtml(r.prediction.measured_note)}</p>` : ''}
    </div>
    <p style="font-weight:600; font-size:.9rem; margin-top:12px;">Joint degeneration risk projections</p>
    <div class="gait-kpis">
      ${(r.prediction.joint_degeneration_risk || []).map(item => `
        <div class="gait-kpi">
          <p class="gait-kpi-label">${escapeHtml(item.joint)}</p>
          <p class="mt-8 tags" style="gap:6px;">${riskLevelBadge(item.risk_level)} <em style="color:var(--ink-500); font-size:.8rem;">(${escapeHtml(item.horizon)})</em></p>
          <p class="mt-8" style="font-size:.82rem; color:var(--ink-500);">${escapeHtml(item.mechanism)}</p>
        </div>`).join('') || '<p class="mt-8" style="font-size:.85rem; color:var(--ink-500);">No joint-risk projections were generated.</p>'}
    </div>
    ${(r.prediction.compensatory_pathologies || []).length ? `
    <p style="font-weight:600; font-size:.9rem; margin-top:12px;">Projected secondary / compensatory pathologies</p>
    <ul style="display:grid; gap:6px; font-size:.85rem; color:var(--ink-700);">
      ${r.prediction.compensatory_pathologies.map(p => `<li><strong>${escapeHtml(p.pathology)}</strong> ${riskLevelBadge(p.likelihood)} <em style="color:var(--ink-500);">(${escapeHtml(p.timeline)})</em><div style="color:var(--ink-500); font-size:.8rem;">${escapeHtml(p.mechanism)}</div></li>`).join('')}
    </ul>` : ''}
    ${r.prediction.summary ? `<p class="mt-8" style="font-size:.85rem; color:var(--ink-600);">${escapeHtml(r.prediction.summary)}</p>` : ''}
    ${r.prediction.recommendation ? `<p class="mt-8" style="font-size:.85rem; color:var(--sage-700);">${escapeHtml(r.prediction.recommendation)}</p>` : ''}
    ${r.prediction.disclaimer ? `<p class="mt-8" style="font-size:.75rem; color:var(--ink-500); font-style:italic;">${escapeHtml(r.prediction.disclaimer)}</p>` : ''}
  ` : '';

  const isVideo = r.mode === 'video';
  const isCV = !!(r.cv && (r.cv.sagittal || r.cv.frontal));
  const artifactUrl = p => { if (!p) return ''; const file = String(p).replace(/\\/g, '/').split('/').pop(); return `/api/gait/sessions/${s.id}/artifacts/${encodeURIComponent(file)}`; };
  const hasArm = p => p && p.status === 'ok';
  const cvPlane = (plane) => {
    const b = r.cv && r.cv[plane];
    if (!hasArm(b)) {
      // Report when a view could not be assessed rather than silently omitting it.
      const prof = r.profile && r.profile[plane];
      const status = b && b.status;
      const reason = (b && b.error) || (prof && prof.note) ||
        `No usable ${plane} recording was available for analysis.`;
      return `<div class="cv-plane">
        <h5 style="text-transform:uppercase; letter-spacing:.5px; color:#1E3C82; font-size:.9rem;">${plane === 'sagittal' ? 'Sagittal' : 'Frontal'} plane — ${status === 'mislabeled' ? 'view mismatch' : 'not analyzed'}</h5>
        <p class="mt-8" style="font-size:.85rem; color:#B3452F; background:#FDF3E3; border-left:4px solid #C99436; border-radius:8px; padding:10px 12px;">${escapeHtml(reason)}</p>
      </div>`;
    }
    const parts = [];
    parts.push(`<div class="cv-plane">`);
    parts.push(`<h5 style="text-transform:uppercase; letter-spacing:.5px; color:#1E3C82; font-size:.9rem;">${plane === 'sagittal' ? 'Sagittal' : 'Frontal'} plane — real tracked kinematics</h5>`);
    if (plane === 'sagittal') {
      parts.push(`<div class="mt-8 tags" style="flex-wrap:wrap;">`);
      parts.push(`<span class="status-badge status-confirmed">Cycle ${b.cycle_seconds}s</span>`);
      parts.push(`<span class="status-badge status-confirmed">Stance ${b.stance_pct}%</span>`);
      if (b.stride_symmetry != null) parts.push(`<span class="status-badge">Stride symmetry ${b.stride_symmetry}%</span>`);
      parts.push(`<span class="status-badge">Samples ${b.samples != null ? b.samples : '—'}</span>`);
      parts.push(`</div>`);
      const rl = b.rom || {};
      const sp = b.specific || {};
      parts.push(`<div class="mt-8" style="overflow-x:auto;">`);
      parts.push(`<table class="admin-table"><thead><tr><th>Limb</th><th>Hip peak flex</th><th>Knee peak flex</th><th>Knee min flex</th><th>Ankle max DF</th><th>Ankle max PF</th><th>Shoulder flex max</th><th>Elbow flex max</th><th>Elbow flex min</th></tr></thead><tbody>`);
      ['L', 'R'].forEach(side => {
        const v = rl[side] || {};
        parts.push(`<tr><td>${side}</td><td>${(v.hip_peak||0).toFixed(1)}°</td><td>${(v.knee_max||0).toFixed(1)}°</td><td>${(v.knee_min||0).toFixed(1)}°</td><td>${(v.ankle_max_df||0).toFixed(1)}°</td><td>${(v.ankle_max_pf||0).toFixed(1)}°</td><td>${(v.shoulder_flex_max||0).toFixed(1)}°</td><td>${(v.elbow_flex_max||0).toFixed(1)}°</td><td>${(v.elbow_flex_min||0).toFixed(1)}°</td></tr>`);
      });
      parts.push(`</tbody></table></div>`);
      parts.push(`<div class="mt-8" style="overflow-x:auto;">`);
      parts.push(`<table class="admin-table"><thead><tr><th>Posture / segment</th><th>Range</th><th>Symmetry index</th></tr></thead><tbody>`);
      parts.push(`<tr><td>Trunk forward lean</td><td>${b.trunk_lean_range != null ? b.trunk_lean_range : '—'}</td><td>—</td></tr>`);
      parts.push(`<tr><td>Head tilt</td><td>${b.head_tilt_range != null ? b.head_tilt_range : '—'}</td><td>—</td></tr>`);
      parts.push(`<tr><td>Shoulder flexion SI</td><td>—</td><td>${sp.shoulder_flex_si != null ? sp.shoulder_flex_si + '%' : '—'}</td></tr>`);
      parts.push(`<tr><td>Elbow flexion SI</td><td>—</td><td>${sp.elbow_flex_si != null ? sp.elbow_flex_si + '%' : '—'}</td></tr>`);
      parts.push(`</tbody></table></div>`);
    } else {
      const m = b.metrics || {};
      const tib = m.tibiofemoral || {};
      const cl = m.coronal_load || {};
      const row = (label, val) => `<tr><td>${label}</td><td>${val}</td></tr>`;
      parts.push(`<div class="mt-8" style="overflow-x:auto;">`);
      parts.push(`<table class="admin-table"><thead><tr><th>Frontal metric</th><th>Measured</th></tr></thead><tbody>`);
      parts.push(row('Pelvic obliquity (95th %ile)', (m.pelvic_obliquity_max||0) + '°'));
      parts.push(row('Lateral trunk lean (95th %ile)', (m.lateral_trunk_lean_max||0) + '°'));
      parts.push(row('In-plane tibiofemoral axis', `L ${(tib.L&&tib.L.angle_deg)||0}° / R ${(tib.R&&tib.R.angle_deg)||0}° (deviation L ${(tib.L&&tib.L.dev_max)||0}° / R ${(tib.R&&tib.R.dev_max)||0}°, ${escapeHtml([tib.L&&tib.L.direction, tib.R&&tib.R.direction].filter(Boolean).join(' / ') || 'neutral')})`));
      parts.push(row('Tibiofemoral deviation (max range)', (m.tibiofemoral_dev_max||0) + '°'));
      parts.push(row('Coronal load symmetry', `symmetry ${(cl.symmetry_pct!=null?cl.symmetry_pct:100)}% — lighter side ${(cl.lighter_side_load_pct!=null?cl.lighter_side_load_pct:50)}% / heavier side ${(cl.heavier_side_load_pct!=null?cl.heavier_side_load_pct:50)}%`));
      parts.push(row('Shoulder height asymmetry index', (m.shoulder_asymmetry_index!=null?m.shoulder_asymmetry_index:0) + ' (× pelvic width)'));
      parts.push(row('Head/neck lateral tilt (95th %ile)', (m.head_lateral_tilt_max||0) + '°'));
      parts.push(row('Shoulder height asymmetry (drop, 95th %ile)', (m.shoulder_drop_max||0) + ' px'));
      parts.push(row('Shoulder abduction L (95th %ile)', (m.shoulder_abduction_max_L||0) + '°'));
      parts.push(row('Shoulder abduction R (95th %ile)', (m.shoulder_abduction_max_R||0) + '°'));
      parts.push(row('Elbow carrying angle L (mean)', (m.elbow_angle_mean_L||0) + '°'));
      parts.push(row('Elbow carrying angle R (mean)', (m.elbow_angle_mean_R||0) + '°'));
      parts.push(row('Hip ab/adduction lean (95th %ile)', (m.hip_abduction_lean_max||0) + '°'));
      parts.push(row('Knee varus/valgus deviation (95th %ile)', (m.knee_valgus_off_max||0) + '°'));
      parts.push(row('Ankle/foot alignment L (95th %ile)', (m.ankle_foot_align_max_L||0) + '°'));
      parts.push(row('Ankle/foot alignment R (95th %ile)', (m.ankle_foot_align_max_R||0) + '°'));
      parts.push(row('Step width (mean)', (m.step_width_mean||0) + ' px'));
      parts.push(`</tbody></table></div>`);
    }
    const plots = b.plots || {};
    const plotThumbs = Object.keys(plots).filter(k => plots[k]).map(k => `
      <div style="border:1px solid #E1EEF8; border-radius:8px; background:#fff; padding:6px;">
        <a href="${artifactUrl(plots[k])}" target="_blank" title="${escapeHtml(k)} graph">
          <img src="${artifactUrl(plots[k])}" alt="${escapeHtml(k)} graph" style="height:150px; border:1px solid #E1EEF8; border-radius:8px; background:#fff;">
        </a>
        <div style="text-align:center; margin-top:4px;">
          <a class="btn btn-ghost btn-sm" href="${artifactUrl(plots[k])}?download=1" download>⬇ ${escapeHtml(k.replace(/_/g, ' '))} graph</a>
        </div>
      </div>`).join('');
    if (plotThumbs) parts.push(`<div class="mt-8 tags" style="gap:10px; align-items:flex-start;">${plotThumbs}</div>`);
    parts.push(`</div>`);
    return parts.join('');
  };
  // ---- Interactive kinematic charts (item 6) — built client-side from `cv.*.timeseries` ----
  const colorLegend = `
    <div class="mt-8" style="background:#F7FAFC; border:1px solid #E1EEF8; border-radius:10px; padding:12px 14px; font-size:.85rem;">
      <p style="font-weight:600; color:#1E3C82; margin-bottom:6px;">How to read the plots &amp; colours</p>
      <ul style="margin-left:18px; display:grid; gap:4px; color:var(--ink-700);">
        <li><span style="color:#1E3C82; font-weight:700;">Blue / navy</span> — the <strong>left</strong> leg (or left-sided measurement).</li>
        <li><span style="color:#C99436; font-weight:700;">Gold / amber</span> — the <strong>right</strong> leg.</li>
        <li><span style="color:#2E8540; font-weight:700;">Green</span> — within the expected (normative) range. In the gait-cycle plot the green band is the <strong>stance</strong> phase (foot on the ground).</li>
        <li><span style="color:#B3452F; font-weight:700;">Red</span> — outside the expected range (abnormal). In the gait-cycle plot the red/pink band is the <strong>swing</strong> phase (foot off the ground). Red/orange curves likewise mark frontal or postural deviations (e.g. head tilt, pelvic obliquity).</li>
      </ul>
      <p class="mt-8" style="color:var(--ink-600);">In the one-cycle plot the <strong>x-axis is one full gait cycle (0–100%)</strong> and the <strong>y-axis is joint angle (degrees)</strong>. Higher angles mean more joint flexion. A large gap between the left and right lines, or red values, can point to an asymmetry or limited range worth discussing with your clinician.</p>
    </div>`;
  window.__gaitChartData = {};
  const chartStore = (id, cfg) => { window.__gaitChartData[id] = cfg; };
  const chartCells = [];
  const sag = r.cv && r.cv.sagittal;
  const fro = r.cv && r.cv.frontal;
  if (sag && sag.timeseries) {
    const ts = sag.timeseries;
    const x = ts.cycle_pct || [];
    ['hip_flexion', 'knee_flexion', 'ankle_angle'].forEach(metric => {
      const L = (ts[metric] && ts[metric].L) || [];
      const R = (ts[metric] && ts[metric].R) || [];
      if (!L.length && !R.length) return;
      const id = 'gait-chart-' + metric;
      chartStore(id, {
        type: 'line',
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { boxWidth: 14 } } }, scales: { x: { title: { display: true, text: 'Gait cycle (%)' } }, y: { title: { display: true, text: 'Degrees' } } } },
        data: {
          labels: x.map(v => v + '%'),
          datasets: [
            { label: 'Left', data: L, borderColor: '#1E3C82', backgroundColor: '#1E3C82', pointRadius: 0, borderWidth: 2, tension: 0.3 },
            { label: 'Right', data: R, borderColor: '#C99436', backgroundColor: '#C99436', pointRadius: 0, borderWidth: 2, tension: 0.3 },
          ],
        },
      });
      chartCells.push({ id, title: `${metric.replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase())} (one gait cycle)`, plane: 'sagittal' });
    });
    const post = ts.posture || {};
    if (post.trunk_lean && post.trunk_lean.length) {
      const id = 'gait-chart-posture';
      chartStore(id, {
        type: 'line',
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { boxWidth: 14 } } }, scales: { x: { title: { display: true, text: 'Frame sample' } }, y: { title: { display: true, text: 'Degrees' } } } },
        data: {
          labels: (post.sample || post.trunk_lean.map((_, i) => i)).map(v => v),
          datasets: [
            { label: 'Trunk forward lean', data: post.trunk_lean || [], borderColor: '#2E8540', backgroundColor: '#2E8540', pointRadius: 0, borderWidth: 2, tension: 0.3 },
            { label: 'Head tilt', data: post.head_tilt || [], borderColor: '#B3452F', backgroundColor: '#B3452F', pointRadius: 0, borderWidth: 2, tension: 0.3 },
          ],
        },
      });
      chartCells.push({ id, title: 'Postural displacement over recording (sagittal)', plane: 'sagittal' });
    }
  }
  if (fro && fro.timeseries) {
    const ts = fro.timeseries;
    const lbl = (ts.sample || (ts.trunk_lean || []).map((_, i) => i));
    const series = [
      ['trunk_lean', 'Lateral trunk lean', '#B3452F'],
      ['pelvic_obliquity', 'Pelvic obliquity', '#46B4DC'],
      ['knee_valgus', 'Frontal knee deviation', '#258DC1'],
    ];
    const datasets = series
      .filter(([k]) => (ts[k] || []).length)
      .map(([k, label, color]) => ({ label, data: ts[k] || [], borderColor: color, backgroundColor: color, pointRadius: 0, borderWidth: 2, tension: 0.3 }));
    if (datasets.length) {
      const id = 'gait-chart-frontal';
      chartStore(id, {
        type: 'line',
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { boxWidth: 14 } } }, scales: { x: { title: { display: true, text: 'Frame sample' } }, y: { title: { display: true, text: 'Degrees' } } } },
        data: { labels: lbl.map(v => v), datasets },
      });
      chartCells.push({ id, title: 'Frontal-plane dynamics over recording', plane: 'frontal' });
    }
  }
  // ---- Multi-view 3D kinematics charts (2e.txt items 1 & 4) — client-interactive ----
  const cv3d = r.cv3d;
  if (cv3d && cv3d.timeseries) {
    const ts = cv3d.timeseries;
    const xlabels = (ts.sample || []).map(v => v);
    const c3Series = [
      ['sagittal.hip_flex', '3D hip flexion (L/R)'],
      ['frontal.hip_ab_abd', '3D hip ab/adduction (L/R)'],
      ['frontal.knee_valgus', '3D frontal knee deviation (L/R)'],
    ];
    ['knee_flex', 'ankle_angle'].forEach(metric => c3Series.unshift([`sagittal.${metric}`, `3D ${metric.replace(/_/g, ' ')} (L/R)`]));
    c3Series.forEach(([path, title]) => {
      const [group, key] = path.split('.');
      const g = ts[group] && ts[group][key];
      const L = (g && g.L) || [];
      const R = (g && g.R) || [];
      if (!L.length && !R.length) return;
      const id = 'gait-chart-3d-' + key;
      chartStore(id, {
        type: 'line',
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { boxWidth: 14 } } }, scales: { x: { title: { display: true, text: 'Sample' } }, y: { title: { display: true, text: 'Degrees' } } } },
        data: {
          labels: xlabels.slice(0, Math.max(L.length, R.length)),
          datasets: [
            { label: 'Left', data: L, borderColor: '#1E3C82', backgroundColor: '#1E3C82', pointRadius: 0, borderWidth: 2, tension: 0.3 },
            { label: 'Right', data: R, borderColor: '#C99436', backgroundColor: '#C99436', pointRadius: 0, borderWidth: 2, tension: 0.3 },
          ],
        },
      });
      chartCells.push({ id, title, plane: 'combined' });
    });
  }
  const chartCellHtml = c => `
    <div style="border:1px solid #E1EEF8; border-radius:10px; background:#fff; padding:10px;">
      <p style="font-size:.85rem; font-weight:600; color:#1E3C82; margin-bottom:6px;">${escapeHtml(c.title)}</p>
      <div style="position:relative; height:230px;"><canvas data-gait-chart="${c.id}"></canvas></div>
    </div>`;
  const planeCharts = plane => (chartCells.length && window.Chart)
    ? `<div class="mt-8" style="display:grid; grid-template-columns:1fr 1fr; gap:16px; align-items:start;">${chartCells.filter(c => c.plane === plane).map(chartCellHtml).join('')}</div>`
    : '';
  const planeDefault = (!hasArm(r.cv && r.cv.frontal) && hasArm(r.cv && r.cv.sagittal)) ? 'sagittal'
    : ((!hasArm(r.cv && r.cv.sagittal) && hasArm(r.cv && r.cv.frontal)) ? 'frontal' : 'sagittal');

  // ---- Multi-view 3D kinematics section (2e.txt items 1 & 4) ----
  const cv3dHtml = (cv3d && cv3d.status === 'ok') ? `
    <h4 class="mt-24" style="border-top:2px solid #E1EEF8; padding-top:16px;">Multi-View 3D Kinematics</h4>
    <div class="mt-8 tags" style="flex-wrap:wrap;">
      <span class="status-badge status-confirmed">${escapeHtml(cv3d.engine === 'brc-multiview-3d' ? 'BRC multi-view 3D (calibrated)' : 'BRC dual-view triangulation')}</span>
      <span class="status-badge">${cv3d.samples} samples</span>
      <span class="status-badge">${escapeHtml((cv3d.calibration && cv3d.calibration.units) || 'normalized')}</span>
      ${cv3d.calibration && cv3d.calibration.multiview && cv3d.calibration.multiview.status === 'configured' ? '<span class="status-badge status-confirmed">BRC multi-view 3D workspace configured</span>' : ''}
    </div>
    <p class="mt-8" style="font-size:.8rem; color:var(--ink-500);">Both planes were triangulated into shared 3D coordinates (frontal ↦ x/y, sagittal ↦ z/y), giving full-body 3D joint kinematics and anatomical coordinates.</p>
    <div class="mt-8" style="overflow-x:auto;">
      <table class="admin-table">
        <thead><tr><th>3D joint angle (median)</th><th>Left</th><th>Right</th></tr></thead>
        <tbody>
          ${(() => {
            const angleSrc = Object.assign({}, cv3d.joint_angles_3d || {}, cv3d.frontal_angles_3d || {});
            const names = { hip_flex: 'Hip flexion', knee_flex: 'Knee flexion', ankle_angle: 'Ankle angle', hip_ab_abd: 'Hip ab/adduction', knee_valgus: 'Frontal knee deviation', shoulder_flex: 'Shoulder flexion', elbow_flex: 'Elbow flexion' };
            return Object.keys(names).map(k => {
              const v = angleSrc[k];
              if (!v) return '';
              return `<tr><td>${escapeHtml(names[k])}</td><td>${v.L == null ? '—' : v.L + '°'}</td><td>${v.R == null ? '—' : v.R + '°'}</td></tr>`;
            }).join('');
          })()}
        </tbody>
      </table>
    </div>
    ${cv3d.segment_lengths ? `
    <p style="font-weight:600; font-size:.9rem; margin-top:14px;">Normalized segment lengths (torso heights)</p>
    <div style="overflow-x:auto;">
      <table class="admin-table mt-8">
        <thead><tr><th>Segment</th><th>Length</th></tr></thead>
        <tbody>${Object.keys(cv3d.segment_lengths).map(k => `<tr><td>${escapeHtml(k.replace(/_/g, ' '))}</td><td>${escapeHtml(String(cv3d.segment_lengths[k]))}</td></tr>`).join('')}</tbody>
      </table>
    </div>` : ''}
    ${cv3d.symmetry ? `
    <p class="mt-8" style="font-size:.85rem; color:var(--ink-600);">Symmetry indices — knee flexion ${cv3d.symmetry.knee_flex_si == null ? 'n/a' : escapeHtml(cv3d.symmetry.knee_flex_si + '%')}; hip flexion ${cv3d.symmetry.hip_flex_si == null ? 'n/a' : escapeHtml(cv3d.symmetry.hip_flex_si + '%')}; thigh length ${cv3d.symmetry.thigh_si == null ? 'n/a' : escapeHtml(cv3d.symmetry.thigh_si + '%')}; shank length ${cv3d.symmetry.shank_si == null ? 'n/a' : escapeHtml(cv3d.symmetry.shank_si + '%')}.</p>` : ''}
    ${(cv3d.plots && (cv3d.plots.sim3d_anatomy || cv3d.plots.sim3d_angles)) ? `
    <div class="mt-8 tags" style="gap:10px; align-items:flex-start;">
      ${['sim3d_anatomy', 'sim3d_angles'].map(k => cv3d.plots[k] ? `
        <div style="border:1px solid #E1EEF8; border-radius:8px; background:#fff; padding:6px;">
          <a href="${artifactUrl(cv3d.plots[k])}" target="_blank" title="${escapeHtml(k)} graph">
            <img src="${artifactUrl(cv3d.plots[k])}" alt="${escapeHtml(k)} graph" style="height:150px; border:1px solid #E1EEF8; border-radius:8px; background:#fff;">
          </a>
          <div style="text-align:center; margin-top:4px;">
            <a class="btn btn-ghost btn-sm" href="${artifactUrl(cv3d.plots[k])}?download=1" download>⬇ ${escapeHtml(k.replace(/_/g, ' '))}</a>
          </div>
        </div>` : '').join('')}
    </div>` : ''}
    ${cv3d.anatomical_note ? `<p class="mt-8" style="font-size:.78rem; color:var(--ink-500); font-style:italic;">${escapeHtml(cv3d.anatomical_note)}</p>` : ''}
  ` : '';

  // ---- Bottom section: landmark overlay videos (plots now live inside the plane tabs) ----
  const cvBottomVideos = [];
  if (isCV) {
    const sag = r.cv.sagittal;
    const fro = r.cv.frontal;
    if (hasArm(sag) && sag.overlay_video) cvBottomVideos.push({ path: sag.overlay_video, plane: 'sagittal' });
    if (hasArm(fro) && fro.overlay_video) cvBottomVideos.push({ path: fro.overlay_video, plane: 'frontal' });
  }
  const videoCells = cvBottomVideos.map(v => `
    <div style="max-width:460px; border:1px solid #E1EEF8; border-radius:10px; background:#fff; padding:8px;">
      <p style="font-size:.82rem; font-weight:600; margin-bottom:4px;">Landmark overlay — ${escapeHtml(v.plane === 'sagittal' ? 'side (sagittal)' : 'front (frontal)')} view</p>
      <video src="${artifactUrl(v.path)}" controls loop muted preload="metadata" style="width:100%; border-radius:8px; border:1px solid #E1EEF8; background:#0e1b14;"></video>
      <div style="margin-top:6px;">
        <a class="btn btn-outline btn-sm" href="${artifactUrl(v.path)}?download=1" download>⬇ Download ${escapeHtml(v.plane)} landmark video</a>
      </div>
    </div>`).join('');

  const bottomSectionHtml = cvBottomVideos.length ? `
    <h4 class="mt-24" style="border-top:2px solid #E1EEF8; padding-top:16px;">Landmark Overlay Videos</h4>
    <p class="mt-16" style="font-weight:600; font-size:.9rem;">Landmark overlay videos (joint keypoints drawn on the walk, generated from the uploaded clip)</p>
    <div class="mt-8" style="display:grid; grid-template-columns:1fr 1fr; gap:14px; align-items:start;">${videoCells}</div>
    <div class="mt-16 tags" style="background:#F0F7FC; border:1px solid #E1EEF8; border-radius:10px; padding:10px 12px; gap:8px;">
      <span style="font-size:.85rem; color:var(--ink-600); margin-right:4px;">Export this report:</span>
      <a class="btn btn-primary btn-sm" href="/api/gait/sessions/${s.id}/report.pdf" target="_blank">⬇ PDF</a>
      <a class="btn btn-outline btn-sm" href="/api/gait/sessions/${s.id}/report.docx" target="_blank">⬇ Word</a>
      <a class="btn btn-ghost btn-sm" href="/api/gait/sessions/${s.id}/results.json" target="_blank">JSON</a>
    </div>
  ` : '';

  const vm = window.__viewMatrix;
  const secVis = (id) => !vm || !vm.sectionViews || !vm.sectionViews[id] || vm.sectionViews[id].indexOf(activeViewId) !== -1;

  // ---- rules.md — interactive tabbed plane views (Static charts live inside each plane card) ----
  const planeTabsHtml = `
    <h4 class="mt-24" style="border-top:2px solid #E1EEF8; padding-top:16px;">Interactive Biomechanical Charts</h4>
    ${colorLegend}
    <div class="gait-tabs mt-8" role="tablist" aria-label="Plane views">
      <button type="button" class="gait-tab" data-gait-tab="sagittal" data-panel="tab-sagittal">Sagittal Plane View</button>
      <button type="button" class="gait-tab" data-gait-tab="frontal" data-panel="tab-frontal">Frontal Plane View</button>
      <button type="button" class="gait-tab" data-gait-tab="combined" data-panel="tab-combined">Combined / Dual View</button>
    </div>
    <div class="gait-tab-panel" id="tab-sagittal" data-default="${planeDefault === 'sagittal' ? '1' : '0'}">
      ${secVis('plane_cv') ? cvPlane('sagittal') : ''}
      ${planeCharts('sagittal')}
    </div>
    <div class="gait-tab-panel" id="tab-frontal" data-default="${planeDefault === 'frontal' ? '1' : '0'}">
      ${secVis('plane_cv') ? cvPlane('frontal') : ''}
      ${planeCharts('frontal')}
    </div>
    <div class="gait-tab-panel" id="tab-combined" data-default="${planeDefault === 'combined' ? '1' : '0'}">
      ${secVis('cv3d') ? cv3dHtml : ''}
      ${planeCharts('combined')}
    </div>
  `;

  const sections = [];
  const put = (id, html) => { if (secVis(id) && html) sections.push(html); };
  const always = (html) => { if (html) sections.push(html); };

  const switcher = viewSwitcherHtml(vm);
  if (switcher) always(switcher);

  always(`
    <div class="tags" style="justify-content:space-between; flex-wrap:wrap;">
      <h3>Gait Analysis Report — Session #${s.id}</h3>
      <span class="tags">
        ${s.status === 'reviewed' ? `<span class="status-badge status-confirmed">Reviewed by ${escapeHtml(s.reviewed_by || 'staff')}</span>` : ''}
        <a class="btn btn-outline btn-sm" href="/api/gait/sessions/${s.id}/report.pdf" target="_blank">⬇ PDF</a>
        <a class="btn btn-outline btn-sm" href="/api/gait/sessions/${s.id}/report.docx" target="_blank">⬇ Word</a>
      </span>
    </div>
    ${metadataBarHtml(s, r)}
    <p class="mt-8" style="font-size:.8rem; color:var(--ink-500);">${escapeHtml(r.diagnostic_note)}</p>
  `);

  put('warnings', warningsHtml(s, r));

  put('kpis', `<h4 class="mt-24">Executive Summary</h4>${kpiCardsHtml(r, cycle)}`);
  put('summary_easy', beginnerSummaryHtml(r));
  put('clinical_impression', r.summary ? `
    <div class="mt-8" style="background:#F0F7FC; border-left:4px solid #1E3C82; border-radius:8px; padding:12px 14px; font-size:.9rem;">
      <p style="font-weight:600; color:#1E3C82;">${escapeHtml(r.summary.headline)}</p>
      <p class="mt-8" style="color:var(--ink-700);">${escapeHtml(r.summary.narrative)}</p>
    </div>
    ${r.summary.recommendation ? `<p class="mt-8" style="font-size:.85rem; color:var(--sage-700);">${escapeHtml(r.summary.recommendation)}</p>` : ''}
  ` : '');

  put('symmetry', symmetryDialsHtml(r));
  put('mv_charts', planeTabsHtml);

  put('name_verify', nameVerificationHtml(r));
  put('anthropometry', anthropometryHtml(r));
  put('integrity', integrityHtml(r));
  put('integrity', confidenceHistogramHtml(r));

  put('muscles', `
    <h4 class="mt-24">Muscle Involvement &amp; Clinical Linkage Map</h4>
    <div class="mt-8" style="display:grid; grid-template-columns:1fr 1fr; gap:14px; align-items:start;">
      <div class="cv-plane">
        <p style="font-weight:600; font-size:.9rem; color:#B3452F;">Overactive / overworked</p>
        <ul>${muscleRows(r.muscles.overactive, '#B3452F')}</ul>
      </div>
      <div class="cv-plane">
        <p style="font-weight:600; font-size:.9rem; color:#258DC1;">Weak / under-active</p>
        <ul>${muscleRows(r.muscles.weak, '#258DC1')}</ul>
      </div>
    </div>
    ${(r.muscles.anomaly_links && r.muscles.anomaly_links.length) ? `
    <p style="font-weight:600; font-size:.9rem; margin-top:12px; color:#2F7A4D;">Deformity ↔ muscle linkage</p>
    <ul style="display:grid; gap:8px; font-size:.85rem; color:var(--ink-700);">
      ${r.muscles.anomaly_links.map(l => `
        <li>
          <strong>${escapeHtml(l.anomaly)}</strong><em style="color:var(--ink-500); font-size:.78rem;">${l.matched ? '' : ' (pattern context)'}</em>
          <ul style="margin-left:16px; margin-top:4px; display:grid; gap:3px; font-size:.8rem;">
            ${(l.muscles || []).map(mu => `<li style="color:${mu.status === 'overactive' ? '#B3452F' : '#1E3C82'};"><strong>${escapeHtml(mu.name)}</strong> [${escapeHtml(mu.status)}] — ${escapeHtml(mu.role)}. ${escapeHtml(mu.implication)}</li>`).join('')}
            ${l.compensation ? `<li style="color:var(--ink-500);">Compensation: ${escapeHtml(l.compensation)}</li>` : ''}
            ${l.localized_damage ? `<li style="color:var(--ink-500);">Localized structural burden: ${escapeHtml(l.localized_damage)}</li>` : ''}
          </ul>
        </li>`).join('')}
    </ul>` : ''}
    ${(r.muscles.structural_weaknesses && r.muscles.structural_weaknesses.length) ? `
    <p style="font-weight:600; font-size:.9rem; margin-top:12px; color:#1E3C82;">Structural weaknesses implicated</p>
    <ul style="display:grid; gap:6px; font-size:.85rem; color:var(--ink-700);">
      ${r.muscles.structural_weaknesses.map(w => `<li><strong>${escapeHtml(w.structure)}</strong> <em style="color:var(--ink-500);">(${escapeHtml(w.category)} · ${escapeHtml(w.related_deformity)})</em><div style="color:var(--ink-500); font-size:.8rem;">${escapeHtml(w.note)}</div></li>`).join('')}
    </ul>` : ''}
    ${(r.muscles.notes && r.muscles.notes.length) ? `<p style="font-size:.75rem; color:var(--ink-500); margin-top:8px; font-style:italic;">${r.muscles.notes.map(escapeHtml).join(' ')}</p>` : ''}
  `);

  put('prescriptions', `
    <h4 class="mt-24">Targeted Clinical Prescriptions &amp; Orthotics</h4>
    ${r.prescriptions.rationale ? `<p class="mt-8" style="font-size:.85rem; color:var(--sage-700);">${escapeHtml(r.prescriptions.rationale)}</p>` : ''}
    <p style="font-weight:600; font-size:.9rem; margin-top:8px;">Exercise routine</p>
    <div style="overflow-x:auto;">
      <table class="admin-table mt-8">
        <thead><tr><th>Exercise</th><th>Frequency</th><th>Rationale</th></tr></thead>
        <tbody>${exRows}</tbody>
      </table>
    </div>
    ${orthoHtml ? `<p style="font-weight:600; font-size:.9rem; margin-top:14px;">Orthotic recommendations</p><ul>${orthoHtml}</ul>` : ''}
    ${prosthHtml ? `<p style="font-weight:600; font-size:.9rem; margin-top:14px;">Prosthetic components</p><ul>${prosthHtml}</ul>` : ''}
    <p style="font-weight:600; font-size:.9rem; margin-top:14px;">Guidance</p>
    <ul style="font-size:.88rem;">${guidanceHtml}</ul>
  `);

  put('prediction', predictionHtml);

  put('cycle_summary', `
    <h4 class="mt-24">Gait Cycle Summary</h4>
    <div class="gait-bar mt-8"><div class="gait-stance" style="width:${stanceW}%;"></div><div class="gait-swing" style="width:${100 - stanceW}%;"></div></div>
    <div class="mt-8 tags">
      <span class="status-badge status-confirmed">Stance ${cycle.stance_pct}%</span>
      <span class="status-badge">Swing ${cycle.swing_pct}%</span>
      ${cycle.running ? '<span class="status-badge" style="background:#B3452F; color:#fff;">Running</span>' : ''}
      <span style="font-size:.85rem; color:var(--ink-600);">Cadence ${cycle.cadence_cycles_per_second} cycles/sec · Cycle ${cycle.cycle_seconds}s</span>
    </div>
    ${cycle.playback_note ? `<p style="font-size:.82rem; color:#258DC1; margin-top:6px;">${escapeHtml(cycle.playback_note)}</p>` : ''}
    <p style="font-size:.82rem; color:var(--ink-600); margin-top:6px;">
      Normative stance reference band: ${(cycle.stance_norm_band || [58, 62]).join('–')}%.
      ${r.summary && r.summary.stance_status ? `Stance is <strong>${escapeHtml(r.summary.stance_status)}</strong>.` : ''}
    </p>
  `);

  put('phase_table', `
    <h4 class="mt-24">Stance &amp; Swing Sub-Phases</h4>
    ${strideTimelineHtml(cycle, r)}
    <div class="gait-legend mt-8">
      <span><span class="dot" style="background:#46B4DC;"></span>Stance</span>
      <span><span class="dot" style="background:#9fc3e0;"></span>Swing</span>
      <span style="color:#B3452F;">&#9650; longer than normative</span>
      <span style="color:#258DC1;">&#9660; shorter than normative</span>
    </div>
    <div class="phase-row phase-head" style="border-bottom:2px solid #fff; background:#F0F7FC; border-radius:8px 8px 0 0;">
      <span>Phase</span><span>Type</span><span>% of cycle</span><span>Δ vs norm</span><span>Norm range</span><span>Duration</span><span>Status</span>
    </div>
    ${phaseRows}
    <p style="font-size:.78rem; color:var(--ink-500); margin-top:4px;">Δ vs norm = observed share of the gait cycle minus the normative share for that sub-phase; Norm range = acceptable reference bandwidth for the sub-phase (values outside it are flagged). Durations: ${cycle.phases.map(p => `${p.name}: ${Math.round(p.duration_ms)} ms`).join(', ')}.</p>
  `);

  put('anomalies', `
    <h4 class="mt-24">Detected Anomalies</h4>
    ${anomalyHtml}
  `);

  put('deformities', `
    <h4 class="mt-24">Multi-Planar Deformity &amp; Biomechanical Analysis</h4>
    <p style="font-weight:600; font-size:.9rem; margin-top:8px;">Frontal plane</p>
    <ul>${deformityList('frontal')}</ul>
    <p style="font-weight:600; font-size:.9rem; margin-top:8px;">Sagittal plane</p>
    <ul>${deformityList('sagittal')}</ul>
    <p style="font-weight:600; font-size:.9rem; margin-top:8px;">Rotational / transverse plane</p>
    <ul>${deformityList('rotational')}</ul>
    <p style="font-size:.78rem; color:var(--ink-500); margin-top:6px;">Findings are classified as <strong>structural</strong> (bony/alignment), <strong>functional</strong> (timing/muscle-driven) or <strong>rotational</strong> (transverse-plane torsion).</p>
  `);

  put('rom', `
    <h4 class="mt-24">Joint Kinematics (Range of Motion)</h4>
    <div style="overflow-x:auto;">
      <table class="admin-table mt-8">
        <thead><tr><th>Joint</th><th>Movement</th><th>Reference ROM</th><th>Observed</th></tr></thead>
        <tbody>${romRows}</tbody>
      </table>
    </div>
  `);

  put('progression', progressionHtml(s));
  put('ocr_panel', ocrPanelHtml(s, r));
  put('raw_json', rawJsonHtml(s, r));

  put('references', `
    <h4 class="mt-24">References</h4>
    <hr style="border:0; border-top:1px solid #E1EEF8; margin:10px 0;">
    ${refsHtml}
  `);

  put('downloads', bottomSectionHtml);

  return sections.join('\n');
}


function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = String(str == null ? '' : str);
  return div.innerHTML;
}

function speedHintLabel(hint) {
  const map = {
    'auto': 'Auto-detect',
    'normal': 'Normal Walk (Real-Time)',
    'running': 'Running / Treadmill',
    'slowmo_120': 'Slow-Motion (120 FPS)',
    'slowmo_240': 'Slow-Motion (240 FPS)'
  };
  return map[hint] || hint;
}

function routingBadgeHtml(r) {
  const routing = r && r.input && r.input.routing;
  if (routing === 'combined-dual-view') {
    return '<span class="status-badge status-confirmed">Combined dual-plane · auto-separated · 3D triangulation</span>';
  }
  if (routing === 'dual-view-3d') {
    return '<span class="status-badge status-confirmed">Dual-view · 3D triangulation</span>';
  }
  return '<span class="status-badge">Single-plane</span>';
}

function formatDate(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d)) return dateStr || '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}