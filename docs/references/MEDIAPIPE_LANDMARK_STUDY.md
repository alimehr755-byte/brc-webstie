# MediaPipe Landmark Mapping Study — BRC Gait Lab

## 1. MediaPipe Pose Landmark Index Reference (33 landmarks)

MediaPipe Pose Landmarker (Tasks-vision, `pose_landmarker_full.task`) returns 33 landmarks per frame. The standard indices are:

| Index | Landmark Name | Used In |
|-------|---------------|---------|
| 0 | Nose | — |
| 1 | Left eye inner | — |
| 2 | Left eye | — |
| 3 | Left eye outer | — |
| 4 | Right eye inner | — |
| 5 | Right eye | — |
| 6 | Right eye outer | — |
| 7 | Left ear | Frontal (head lateral tilt, shoulder asymmetry) |
| 8 | Right ear | Frontal (head lateral tilt, shoulder asymmetry) |
| 9 | Mouth left | — |
| 10 | Mouth right | — |
| 11 | Left shoulder | Sagittal (hip flexion, shoulder flexion), Frontal (trunk lean, shoulder drop) |
| 12 | Right shoulder | Sagittal (hip flexion, shoulder flexion), Frontal (trunk lean, shoulder drop) |
| 13 | Left elbow | Sagittal (shoulder flexion, elbow flexion) |
| 14 | Right elbow | Sagittal (shoulder flexion, elbow flexion) |
| 15 | Left wrist | Sagittal (elbow flexion) |
| 16 | Right wrist | Sagittal (elbow flexion) |
| 17 | Left pinky | — |
| 18 | Right pinky | — |
| 19 | Left index | — |
| 20 | Right index | — |
| 21 | Left thumb | — |
| 22 | Right thumb | — |
| 23 | Left hip | Sagittal (hip flexion, knee flexion), Frontal (pelvic obliquity, hip ab/adduction, knee valgus) |
| 24 | Right hip | Sagittal (hip flexion, knee flexion), Frontal (pelvic obliquity, hip ab/adduction, knee valgus) |
| 25 | Left knee | Sagittal (knee flexion, ankle angle), Frontal (knee valgus/varus, tibiofemoral axis) |
| 26 | Right knee | Sagittal (knee flexion, ankle angle), Frontal (knee valgus/varus, tibiofemoral axis) |
| 27 | Left ankle | Sagittal (ankle angle), Frontal (step width, body height) |
| 28 | Right ankle | Sagittal (ankle angle), Frontal (step width, body height) |
| 29 | Left heel | Frontal (foot angle, ankle-foot alignment) |
| 30 | Right heel | Frontal (foot angle, ankle-foot alignment) |
| 31 | Left foot index | Sagittal (ankle angle, toe angle), Frontal (step width) |
| 32 | Right foot index | Sagittal (ankle angle, toe angle), Frontal (step width) |

---

## 2. BRC Gait Lab L_INDEX / R_INDEX Mapping

The BRC codebase uses `L_INDEX` and `R_INDEX` dictionaries that map **joint labels** to MediaPipe landmark indices:

```python
# python/gait_lab.py lines 67-68
L_INDEX = dict(ear=7, shoulder=11, elbow=13, wrist=15, hip=23, knee=25, ankle=27, foot=31, toe=29)
R_INDEX = dict(ear=8, shoulder=12, elbow=14, wrist=16, hip=24, knee=26, ankle=28, foot=32, toe=30)
```

| Joint Label | Left MediaPipe Index | Right MediaPipe Index | Landmark Name |
|-------------|---------------------|----------------------|---------------|
| ear | 7 | 8 | Left/Right ear |
| shoulder | 11 | 12 | Left/Right shoulder |
| elbow | 13 | 14 | Left/Right elbow |
| wrist | 15 | 16 | Left/Right wrist |
| hip | 23 | 24 | Left/Right hip |
| knee | 25 | 26 | Left/Right knee |
| ankle | 27 | 28 | Left/Right ankle |
| foot | 31 | 32 | Left/Right foot index |
| toe | 29 | 30 | Left/Right heel |

**SIDES mapping** (line 70-73):
```python
SIDES = {
    "L": ("Left", L_INDEX),
    "R": ("Right", R_INDEX),
}
```

---

## 3. Landmark Extraction Pipeline

### 3.1 MediaPipe Inference (`_make_pose_runner`)
- **Model**: `pose_landmarker_full.task` (MediaPipe Tasks-vision PoseLandmarker)
- **Mode**: VIDEO (sequential frames with timestamps)
- **Input**: RGB frame resized to max 480px dimension
- **Output**: 33 landmarks per frame (each with x, y, z, visibility, presence)
- **Frame sampling**: Every 4th frame (`FRAME_SAMPLE_STEP = 4`), capped at 150 samples (`MAX_SAMPLES = 150`)

### 3.2 Landmark Extraction (`landmark_pts`)
```python
def landmark_pts(lm, idx_map, width, height, vis_min=0.35):
    pts = {}
    for key, idx in idx_map.items():
        l = lm[idx]
        vis = getattr(l, "visibility", getattr(l, "presence", 1.0))
        if vis > vis_min:
            pts[key] = (float(l.x) * width, float(l.y) * height)
    return pts
```
- Filters keypoints by visibility threshold (0.35 minimum)
- Converts normalized (0-1) coordinates to pixel coordinates
- Returns dict: `{joint_label: (x_px, y_px)}`

### 3.3 Per-Plane Landmark Usage

---

## 4. Sagittal Plane Analysis

**File:** `python/gait_lab.py` → `analyze_sagittal()`

**Landmarks used:** ear, shoulder, elbow, wrist, hip, knee, ankle, foot

**Metrics extracted per frame:**

| Metric | Landmarks | Formula | Clinical Use |
|--------|-----------|---------|--------------|
| Hip flexion angle | shoulder, hip, knee | `three_point_angle(shoulder, hip, knee)` | Peak hip flexion during swing |
| Knee flexion angle | hip, knee, ankle | `three_point_angle(hip, knee, ankle)` | Knee ROM, CP knee pattern classification |
| Ankle angle | knee, ankle, foot | `three_point_angle(knee, ankle, foot)` | Dorsiflexion/plantarflexion |
| Shoulder flexion | hip, shoulder, elbow | `three_point_angle(hip, shoulder, elbow)` | Upper limb compensation |
| Elbow flexion | shoulder, elbow, wrist | `three_point_angle(shoulder, elbow, wrist)` | Arm swing |

**Additional sagittal metrics:**
- Trunk lean (shoulder-to-hip vector angle from vertical)
- Head tilt (ear position relative to trunk)
- Shoulder protrusion (shoulder offset vs pelvis, L/R)

**Visibility gating:** Each metric is only computed when all contributing landmarks are visible (`_gate_ok` checks visibility ≥ 0.35 for all required landmarks). If any landmark is missing, the frame is scored as NaN (never interpolated).

---

## 5. Frontal (Coronal) Plane Analysis

**File:** `python/gait_lab.py` → `analyze_frontal()`

**Landmarks used:** ear, shoulder, elbow, wrist, hip, knee, ankle, foot

**Metrics extracted per frame:**

| Metric | Landmarks | Formula | Clinical Use |
|--------|-----------|---------|--------------|
| Pelvic obliquity | left_hip, right_hip | `atan2(right_hip.y - left_hip.y, right_hip.x - left_hip.x)` | Trendelenburg / abductor insufficiency |
| Trunk lean | hip_mid, shoulder_mid | `signed_lean_from_vertical(hip_mid, shoulder_mid)` | Compensatory weight shift |
| Hip ab/adduction | hip, knee | Thigh vector angle from vertical (coronal) | Hip abductor function |
| Knee valgus/varus | hip, knee, ankle | Tibiofemoral axis deviation from vertical | Varus/valgus alignment |
| Step width | left_ankle, right_ankle | Horizontal distance between ankles | Base of support |
| Weight shift | hip_mid, ankle_mid | Lateral displacement of COM | Asymmetric loading |
| Head lateral tilt | shoulder_mid, ear_mid | `signed_lean_from_vertical(shoulder_mid, ear_mid)` | Upper-body compensation |
| Shoulder drop | left_shoulder, right_shoulder | Height difference between shoulders | Shoulder asymmetry |
| Shoulder abduction | shoulder, elbow | Arm vector angle from vertical (coronal) | Upper limb compensation |
| Elbow angle | shoulder, elbow, wrist | `three_point_angle` in frontal plane | Arm swing |
| Tibiofemoral axis | hip, knee, ankle | In-plane angle of femur/shank | Varus/valgus alignment |

**Plane-orientation heuristic:** 
- `frontal_ratio = hip_width / body_height`
- ratio < 0.12 → sagittal (side-on, hips nearly overlap)
- ratio ≥ 0.30 → frontal (front-on, wide pelvic silhouette)
- Otherwise → ambiguous

---

## 6. Coronal/Third Plane Analysis

**File:** `python/gait_lab.py` → `analyze_frontal()` (reused for third plane)

The third (Coronal) plane uses the **same** `analyze_frontal()` function because it's also a front-facing view. The key differences:

1. **Screened as "frontal"** by gait validity (same heuristic)
2. **Tracked under its own key** (`cv_third`) in the results dict
3. **Used for tri-view triangulation** in `cv3d.py` (least-squares across frontal + sagittal + third)
4. **SMPL-X fitting** runs on the third plane's raw keypoints (when `USE_SMPLX=True`)

The third plane contributes to:
- `cv3d.calibration.cameras.third` (width, height)
- `cv3d.calibration.third_view_used` flag
- `cv3d.fps_third`
- Least-squares triangulation in `_reconstruct()` (X/Y coordinates averaged across frontal + third views)

---

## 7. 3D Triangulation (cv3d.py)

**File:** `python/cv3d.py` → `run_multi_view_3d()`

### 7.1 MediaPipe → OpenPose-25 Mapping (for SMPL-X)
```python
# python/smplx_fit.py
MP_NOSE = 0, MP_LEFT_EYE = 2, MP_RIGHT_EYE = 5, MP_LEFT_EAR = 7, MP_RIGHT_EAR = 8
MP_LEFT_SHOULDER = 11, MP_RIGHT_SHOULDER = 12
MP_LEFT_ELBOW = 13, MP_RIGHT_ELBOW = 14
MP_LEFT_WRIST = 15, MP_RIGHT_WRIST = 16
MP_LEFT_HIP = 23, MP_RIGHT_HIP = 24
MP_LEFT_KNEE = 25, MP_RIGHT_KNEE = 26
MP_LEFT_ANKLE = 27, MP_RIGHT_ANKLE = 28
MP_LEFT_HEEL = 29, MP_RIGHT_HEEL = 30
MP_LEFT_FOOT_INDEX = 31, MP_RIGHT_FOOT_INDEX = 32
```

MediaPipe 33 → OpenPose-25 mapping:
| OpenPose ID | Joint | MediaPipe Index | Notes |
|-------------|-------|-----------------|-------|
| 0 | Nose | 0 | Direct |
| 1 | Neck | derived | Midpoint of shoulders (L11 + R12) |
| 2 | R_Shoulder | 12 | Direct |
| 3 | R_Elbow | 14 | Direct |
| 4 | R_Wrist | 16 | Direct |
| 5 | L_Shoulder | 11 | Direct |
| 6 | L_Elbow | 13 | Direct |
| 7 | L_Wrist | 15 | Direct |
| 8 | R_Hip | 24 | Direct |
| 9 | R_Knee | 26 | Direct |
| 10 | R_Ankle | 28 | Direct |
| 11 | L_Hip | 23 | Direct |
| 12 | L_Knee | 25 | Direct |
| 13 | L_Ankle | 27 | Direct |
| 14 | R_Eye | 5 | Direct |
| 15 | L_Eye | 2 | Direct |
| 16 | R_Ear | 8 | Direct |
| 17 | L_Ear | 7 | Direct |
| 18 | L_Big_toe | 31 | Direct |
| 19 | L_Small_toe | 31 | Approximated (MediaPipe has no small toe) |
| 20 | L_Heel | 29 | Direct |
| 21 | R_Big_toe | 32 | Direct |
| 22 | R_Small_toe | 32 | Approximated (MediaPipe has no small toe) |
| 23 | R_Heel | 30 | Direct |
| 24 | Background | — | Unused |

### 7.2 CV3D PANTRY_JOINTS (8 joints per side)
```python
PANTRY_JOINTS = ("ear", "shoulder", "elbow", "wrist", "hip", "knee", "ankle", "toe")
```

### 7.3 Orthographic Triangulation
- **Frontal view**: projects (X, Y) — world X from image X, world Y from image Y
- **Sagittal view**: projects (Z, Y) — world Z from image X, world Y from image Y
- **Third (Coronal) view**: projects (X, Y) — redundant constraint on X/Y
- **Least-squares**: each coordinate is averaged across all available views that measured it
- **Reference scale**: median torso height (shoulder-to-hip) across all views, in pixels

### 7.4 3D Joint Angles
Computed from reconstructed world coordinates:
- Hip flexion: shoulder → hip → knee
- Knee flexion: hip → knee → ankle
- Ankle angle: knee → ankle → toe
- Shoulder flexion: hip → shoulder → elbow
- Elbow flexion: shoulder → elbow → wrist
- Knee frontal deviation: hip → knee → ankle (coronal)

---

## 8. CP Knee Classifier (cp_knee_classifier.py)

**Pattern:** Sutherland & Davids (1993) walk-frame taxonomy

**Input:** 101-point knee-flexion curve (0-100% gait cycle) + stance_pct boundary

**Classification logic per side:**
1. **Recurvatum**: stance minimum < -5° (knee hyperextension)
2. **Crouch**: single-support minimum > 30° (knee never fully extends)
3. **Jump**: first peak ≥ 30° AND stance min 10-20° (premature flexion with held minimum)
4. **Stiff knee**: swing peak < 45° OR (swing peak < 55° AND delayed past 55% cycle)
5. **Not classified**: none of the above thresholds met

**Confidence scoring:** 0-100% based on how far the measured values are from the decision thresholds.

---

## 9. Plane Classification (classify_plane.py)

Uses the **frontal ratio heuristic**:
```
ratio = hip_width / body_height  (in pixels, normalized)
```

| Ratio Range | Classification |
|-------------|----------------|
| < 0.12 | Sagittal (side-on, hips overlap) |
| ≥ 0.30 | Frontal (front-on, wide pelvic silhouette) |
| 0.12–0.30 | Ambiguous (deferred to analyzer) |

---

## 10. Summary: Landmark → Analysis Flow

```
Video (MP4/MOV/etc.)
  │
  ▼
[MediaPipe PoseLandmarker] → 33 landmarks per frame (normalized 0-1)
  │
  ▼
[landmark_pts()] → Filter by visibility (>0.35) → Pixel coordinates
  │
  ├─→ Sagittal: hip_flexion, knee_flexion, ankle_angle, shoulder_flex, elbow_flex
  │              + trunk_lean, head_tilt, shoulder_protrusion
  │
  ├─→ Frontal: pelvic_obliquity, trunk_lean, hip_abduction, knee_valgus,
  │            step_width, weight_shift, head_lateral_tilt, shoulder_drop,
  │            shoulder_abduction, elbow_angle, tibiofemoral_axis
  │
  ├─→ Third (Coronal): Same as Frontal (front-facing view)
  │
  └─→ cv3d (tri-view): Least-squares triangulation → 3D joints → 3D angles
       └─→ SMPL-X (gated): MediaPipe 33 → OpenPose-25 → SMPL-X fit → .obj mesh
```

---

## 11. Key Files

| File | Role |
|------|------|
| `python/gait_lab.py` | Main analyzer: `analyze_sagittal()`, `analyze_frontal()`, `derive_clinical()`, `build_phases()`, `detect_gait_events()` |
| `python/cv3d.py` | Dual/tri-view 3D triangulation: `run_multi_view_3d()`, `_reconstruct()` |
| `python/cp_knee_classifier.py` | CP knee pattern classifier (jump/crouch/stiff/recurvatum) |
| `python/smplx_fit.py` | SMPL-X body model fitting (MediaPipe 33 → OpenPose-25 → SMPL-X) |
| `python/classify_plane.py` | Upload-time plane orientation classifier |
| `python/gait_analyzer.py` | Anomaly catalog, archetypes, prediction table, deformity screens |
| `python/gait_validity.py` | Gait validity gate (rejects non-walking videos) |
| `python/anthropometry.py` | Anthropometric segmentation (12 segments, height calibration) |
| `routes/gait.js` | API: sessions, videos, analyze, report.pdf/docx, view-matrix |

---

## 12. MediaPipe Model Details

- **Model file**: `pose_landmarker_full.task` (MediaPipe Tasks-vision)
- **Inference mode**: VIDEO (sequential frame processing with timestamps)
- **Frame sampling**: Every 4th frame (`FRAME_SAMPLE_STEP = 4`)
- **Max samples**: 150 per video (`MAX_SAMPLES = 150`)
- **Visibility threshold**: 0.35 (keypoints below this are omitted, never interpolated)
- **Timestamp**: `state["fc"] * 33` (33ms per frame ≈ 30fps assumption)
- **Resolution**: Downscaled to max 480px dimension for inference
- **Coordinate output**: Normalized 0-1, converted to pixel coordinates by multiplying by width/height

---

## 13. Zero-Assumption Protocol (spec P1)

Every metric in the pipeline follows the zero-assumption protocol:
1. **Measured or unassessed** — never inferred or interpolated
2. **Visibility gating** — keypoints below 0.35 visibility are omitted
3. **NaN propagation** — missing data propagates as NaN, not zero or default
4. **Status tracking** — every result block carries `status: "assessed" | "unassessed"` with a `reason` when unassessed
5. **Integrity ledger** — `_build_integrity()` reports confidence for every parameter
6. **Cross-check contract** — BBS × gait cross-validation only reports "assessed" when BOTH sides exist; otherwise "unassessed" with reason

---

## 14. Open-Source Libraries Used

| Library | Version | Purpose |
|---------|---------|---------|
| MediaPipe (Tasks-vision) | 0.10.35 | Pose landmark extraction (33 landmarks) |
| OpenCV | 5.0.0.93 | Video capture, frame sampling, overlay rendering |
| NumPy | 2.3.1 | Array operations, statistics |
| SciPy | 1.18.0 | Signal processing (savgol_filter, find_peaks) |
| Matplotlib | 3.11.1 | Plot generation (ROM, gait cycle, posture) |
| PyTorch | 2.14.0+cpu | SMPL-X model inference (gated) |
| SMPLX | 0.1.28 | SMPL-X body model (gated, license-required) |
| RapidOCR | 1.2.3 | Export-time OCR for name overlay verification |
| Pandas | 2.3.1 | Data manipulation (gait analyzer) |
| Three.js | 0.160.0 (CDN) | Rotatable 3D mesh viewport (frontend) |
| Chart.js | 4.4.4 | Progression charts (frontend) |

---

*Study document — no code changes made. All information extracted from reading the BRC Gait Lab codebase.*
