# Live Camera Recording & Analysis Feature Specification

## Status: FUTURE PLAN — Not Yet Implemented

This document specifies the live camera recording and analysis feature for the
BRC Gait Lab research portal. This is a **future plan** that will be implemented
when the gait lab is built functionally with live recording capability.

**When to implement:** After the gait lab is built and cameras are physically
installed at BRC.

**What it does:** Adds a "Live Camera Recording" card to the web interface
that enables real-time video capture from connected cameras for all three
planes (transverse, frontal, sagittal). When recording starts, the live
camera feed is displayed, analysis begins in real-time, and results are
streamed to the dashboard.

---

## 1. Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    BROWSER (WebRTC)                          │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  Live Camera Recording Card                            │  │
│  │  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐    │  │
│  │  │ Sagittal    │ │ Frontal     │ │ Transverse  │    │  │
│  │  │ Camera      │ │ Camera      │ │ Camera      │    │  │
│  │  │ Preview     │ │ Preview     │ │ Preview     │    │  │
│  │  └─────────────┘ └─────────────┘ └─────────────┘    │  │
│  │  [Start Recording] [Stop] [Analyze Live]             │  │
│  └───────────────────────────────────────────────────────┘  │
│              WebRTC MediaRecorder API                        │
│              ┌──────────┐  ┌──────────┐  ┌──────────┐       │
│              │ Video 1  │  │ Video 2  │  │ Video 3  │       │
│              │ (chunks) │  │ (chunks) │  │ (chunks) │       │
│              └────┬─────┘  └────┬─────┘  └────┬─────┘       │
└───────────────────┼─────────────┼─────────────┼───────────────┘
                    │             │             │
                    └─────────────┴─────────────┘
                           Upload (WebSocket / HTTP)
                    ┌─────────────┴─────────────┐
                    │                           │
                    ▼                           ▼
┌─────────────────────────────────────────────────────────────┐
│                    SERVER (Node.js / Python)                 │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  Live Recording Handler                                │  │
│  │  - Receive video chunks from browser                   │  │
│  │  - Save to disk (uploads/gait/)                        │  │
│  │  - Trigger analysis pipeline                           │  │
│  │  - Stream progress back to browser                     │  │
│  └───────────────────────────────────────────────────────┘  │
│                           │                                 │
│                           ▼                                 │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  Analysis Pipeline (gait_lab.py)                      │  │
│  │  - MediaPipe Pose extraction                          │  │
│  │  - SMPL-X fitting (if enabled)                       │  │
│  │  - Gait cycle analysis                                │  │
│  │  - Deformity detection                                │  │
│  │  - Clinical interpretation                            │  │
│  └───────────────────────────────────────────────────────┘  │
│                           │                                 │
│                           ▼                                 │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  Report Engine (existing)                             │  │
│  │  - JSON results → report.html                         │  │
│  │  - PDF/DOCX export                                    │  │
│  │  - Research portal data                               │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

---

## 2. UI Components

### 2.1 Live Camera Recording Card

A new card on the gait lab page (`gait.html`) that appears alongside the
existing "New Gait Analysis Session" card:

```html
<div class="card card-lg mb-24" id="live-recording-card">
  <h3 class="mb-16">Live Camera Recording</h3>
  <p class="mt-8" style="color:var(--ink-600); font-size:.9rem;">
    Record live from connected cameras. Supports sagittal, frontal, and
    transverse planes. Recording is saved and analyzed automatically.
  </p>

  <!-- Camera selection -->
  <div class="grid grid-2 mt-16">
    <div class="field">
      <label for="live-plane-select">Plane of View</label>
      <select id="live-plane-select">
        <option value="sagittal">Sagittal Plane (side view)</option>
        <option value="frontal">Frontal Plane (front view)</option>
        <option value="transverse">Transverse Plane (overhead view)</option>
      </select>
    </div>
    <div class="field">
      <label for="live-camera-select">Camera Device</label>
      <select id="live-camera-select">
        <option value="">Select camera...</option>
      </select>
    </div>
  </div>

  <!-- Video preview -->
  <div class="video-preview mt-16" id="live-preview-container" style="display:none;">
    <video id="live-preview" autoplay playsinline muted
           style="width:100%; border-radius:8px; background:#0e1b14;"></video>
    <div class="mt-8" style="display:flex; gap:8px; align-items:center;">
      <span id="recording-timer" style="font-weight:700; color:#B3452F;">00:00</span>
      <span id="recording-status" style="font-size:.85rem; color:var(--ink-600);">Ready</span>
    </div>
  </div>

  <!-- Controls -->
  <div class="mt-16" style="display:flex; gap:10px; flex-wrap:wrap;">
    <button class="btn btn-primary" id="live-start-btn" type="button">
      Start Recording
    </button>
    <button class="btn btn-ghost" id="live-stop-btn" type="button" disabled>
      Stop Recording
    </button>
    <button class="btn btn-ghost" id="live-analyze-btn" type="button" disabled>
      Analyze Recording
    </button>
  </div>

  <!-- Recording queue -->
  <div class="mt-16" id="live-recordings-list">
    <h4 style="color:#1E3C82; margin-bottom:8px;">Recorded Clips</h4>
    <p class="empty-state">No clips recorded yet.</p>
  </div>
</div>
```

### 2.2 Live Recording JavaScript

```javascript
// Live camera recording using WebRTC MediaRecorder API
let liveStream = null;
let mediaRecorder = null;
let recordedChunks = [];
let recordingTimer = null;
let recordingStartTime = null;

async function initLiveCamera() {
  const cameraSelect = document.getElementById('live-camera-select');
  const devices = await navigator.mediaDevices.enumerateDevices();
  const videoDevices = devices.filter(d => d.kind === 'videoinput');

  cameraSelect.innerHTML = '<option value="">Select camera...</option>';
  videoDevices.forEach((device, idx) => {
    const opt = document.createElement('option');
    opt.value = device.deviceId;
    opt.textContent = device.label || `Camera ${idx + 1}`;
    cameraSelect.appendChild(opt);
  });

  cameraSelect.addEventListener('change', async () => {
    if (liveStream) {
      liveStream.getTracks().forEach(t => t.stop());
      liveStream = null;
    }
    if (!cameraSelect.value) return;

    liveStream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: { exact: cameraSelect.value },
               width: { ideal: 1920 }, height: { ideal: 1080 },
               frameRate: { ideal: 30 } }
    });
    const preview = document.getElementById('live-preview');
    preview.srcObject = liveStream;
    document.getElementById('live-preview-container').style.display = 'block';
  });
}

async function startRecording() {
  if (!liveStream) {
    alert('Please select a camera first.');
    return;
  }
  recordedChunks = [];
  const options = { mimeType: 'video/webm;codecs=vp9' };
  mediaRecorder = new MediaRecorder(liveStream, options);

  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) recordedChunks.push(e.data);
  };

  mediaRecorder.onstop = async () => {
    const blob = new Blob(recordedChunks, { type: 'video/webm' });
    await uploadRecording(blob);
  };

  mediaRecorder.start(1000); // collect data every 1 second
  recordingStartTime = Date.now();
  startTimer();
  document.getElementById('live-start-btn').disabled = true;
  document.getElementById('live-stop-btn').disabled = false;
  document.getElementById('recording-status').textContent = 'Recording...';
  document.getElementById('recording-status').style.color = '#B3452F';
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
    stopTimer();
    document.getElementById('live-start-btn').disabled = false;
    document.getElementById('live-stop-btn').disabled = true;
    document.getElementById('recording-status').textContent = 'Processing...';
  }
}

async function uploadRecording(blob) {
  const formData = new FormData();
  formData.append('video', blob, 'live-recording.webm');
  formData.append('plane', document.getElementById('live-plane-select').value);
  formData.append('source', 'live');

  const res = await fetch('/api/gait/sessions/' + currentSessionId + '/videos', {
    method: 'POST',
    body: formData,
  });
  // Handle response...
}
```

---

## 3. Server-Side Components

### 3.1 Live Recording API Endpoint

```javascript
// New route in routes/gait.js
router.post('/sessions/:id/live-record', requireAuth, (req, res) => {
  // Handle live video upload from browser
  // Save to uploads/gait/ with live- prefix
  // Trigger analysis
});
```

### 3.2 WebSocket for Real-Time Progress

```javascript
// server.js - WebSocket support for live recording progress
const WebSocket = require('ws');
const wss = new WebSocket.Server({ port: 8080 });

wss.on('connection', (ws) => {
  ws.on('message', (message) => {
    // Handle live recording chunks
    // Stream progress back
  });
});
```

---

## 4. Integration with Existing Pipeline

### 4.1 Recording Flow

```
1. User selects plane (sagittal/frontal/transverse) and camera
2. User clicks "Start Recording"
3. Browser captures video via WebRTC
4. Video is recorded in chunks (MediaRecorder API)
5. Chunks are uploaded to server
6. Server saves video to uploads/gait/
7. User clicks "Analyze Recording"
8. Server runs gait_lab.py on the video
9. Results are stored in gait_sessions
10. Report is generated
11. Research portal is updated with new data
```

### 4.2 Data Flow

```
Live Camera → WebRTC → MediaRecorder → Blob → Upload → Server → gait_lab.py → Report
```

### 4.3 Existing Pipeline Compatibility

The live recording feature is **fully compatible** with the existing pipeline:
- Videos are saved in the same format as uploaded videos
- Analysis uses the same `gait_lab.py` engine
- Results use the same JSON schema
- Reports use the same templates
- Research portal data is automatically updated

---

## 5. Implementation Checklist (When Ready)

### Phase 1: Browser-Side (WebRTC)
- [ ] Camera device enumeration and selection
- [ ] Live video preview (autoplay, playsinline, muted)
- [ ] MediaRecorder with chunk collection
- [ ] Recording timer display
- [ ] Upload to server via FormData
- [ ] Error handling (camera not found, permission denied)

### Phase 2: Server-Side (Node.js)
- [ ] Live recording upload endpoint
- [ ] WebSocket support for real-time progress
- [ ] Video chunk assembly
- [ ] File storage in uploads/gait/
- [ ] Session creation from live recording

### Phase 3: Analysis Integration
- [ ] Trigger gait_lab.py on live recording
- [ ] Stream progress back to browser
- [ ] Update research portal data
- [ ] Generate reports

### Phase 4: Multi-Camera Sync
- [ ] Hardware trigger integration
- [ ] Multi-camera synchronization
- [ ] Pose2Sim integration (when 3+ cameras)
- [ ] Fallback to SMPL-X for 1-2 cameras

### Phase 5: Testing
- [ ] Unit tests for recording components
- [ ] Integration tests for full pipeline
- [ ] Browser compatibility tests (Chrome, Firefox, Safari, Edge)
- [ ] Performance tests (memory, CPU usage)

---

## 6. File Locations (When Implementing)

```
public/
├── gait.html                    # Add live recording card
├── js/
│   ├── gait.js                  # Add live recording logic
│   └── live-recorder.js         # New: WebRTC recording module
├── css/
│   └── live-recorder.css        # New: Recording UI styles

routes/
├── gait.js                      # Add live recording endpoints
└── live-recording.js            # New: WebSocket handler

python/
├── gait_lab.py                  # Existing (unchanged)
├── smplx_fit.py                # Existing (unchanged)
└── live_recorder.py            # New: Live recording handler

tests/
├── test_live_recorder.js        # New: Browser tests
└── test_live_recording.py       # New: Server tests
```

---

## 7. Browser Compatibility

| Browser | WebRTC | MediaRecorder | getUserMedia |
|---------|--------|---------------|--------------|
| Chrome 60+ | ✅ | ✅ | ✅ |
| Firefox 55+ | ✅ | ✅ | ✅ |
| Safari 11+ | ✅ | ✅ (limited) | ✅ |
| Edge 79+ | ✅ | ✅ | ✅ |

**Note:** Safari has limited MediaRecorder support. Fallback to different recording format may be needed.

---

## 8. Security Considerations

- Camera access requires HTTPS in production (or localhost for dev)
- User must grant camera permission
- Recordings are stored server-side with user authentication
- No raw video data is sent to third parties
- All data stays within the BRC gait lab network

---

## 9. Notes

- This document is a **specification only**. No code changes have been made.
- The live recording feature will be implemented when the gait lab is built
  functionally with live recording capability.
- The existing upload-based workflow remains unchanged until then.
- All existing report logic is untouched — only the input source changes
  (live recording vs uploaded video).

---

## 10. References

1. **WebRTC:** https://webrtc.org/
2. **MediaRecorder API:** https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder
3. **getUserMedia:** https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia
4. **WebSocket API:** https://developer.mozilla.org/en-US/docs/Web/API/WebSocket
5. **PhysioNet Dataset:** https://physionet.org/content/multi-gait-posture/1.0.0/

---

*Document created: November 9, 2026*
*Status: FUTURE PLAN — Not yet implemented*
*Author: Research Portal Development Team*