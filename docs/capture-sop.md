# BRC Gait Lab — Capture SOP (Standard Operating Procedure)
**Purpose:** Produce gait videos that the engine can analyze with confidence, and golden sessions for engine-vs-physio validation.
**Applies to:** Clinicians, research assistants, patients/guardians during capture sessions.

## 1. Before you start
- [ ] Consent form signed (video + data use for clinical analysis).
- [ ] Patient demographics recorded: name, DOB, age_years, gender, diagnosis, height_cm, body_mass_kg, GMFCS level (if CP), usual assistive device.
- [ ] Assessing clinician name recorded.
- [ ] Device charged; storage ≥ 5 GB free; back camera preferred (higher resolution).

## 2. Environment setup
| Parameter | Requirement |
|-----------|-------------|
| Floor | Hard, level, non-slip (tile, hardwood, short-pile carpet OK). No rugs or thresholds in the walk path. |
| Background | Plain wall, clutter-free, contrasting with patient's clothing (avoid same-color top/pants). |
| Lighting | Even, diffuse. No strong backlight (window behind patient), no harsh shadows on floor. |
| Walk path | Straight line ≥ 6 meters, marked start and end cones/tape. |
| Camera positions | Sagittal: side view, perpendicular to walk direction. Frontal: face-on view. Third/Coronal: front-facing, offset ~2–3 m from frontal for tri-view triangulation. |

## 3. Camera placement (per plane)

### Sagittal Plane (side view)
- Tripod height: **1.0–1.2 m** (lens at patient's hip height).
- Distance from walk path: **3–4 m**.
- Orientation: landscape, side-on, patient walks left→right or right→left (pick one, stay consistent per session).
- Frame: full body visible from head to heels throughout the entire walk path.

### Frontal Plane (face-on / coronal)
- Tripod height: **1.0–1.2 m**.
- Distance from walk path: **3–4 m**, directly in front of the walk line.
- Orientation: landscape, face-on.
- Frame: full body visible; patient's midline aligned with frame center.

### Third / Coronal Plane (third camera for tri-view triangulation)
- Tripod height: **1.0–1.2 m** (same as frontal).
- Distance: **3–4 m**, front-facing, offset laterally ~2–3 m from frontal axis (not directly behind frontal).
- Orientation: landscape, face-on.
- Purpose: third view for least-squares triangulation, reduces parallax error in 3D reconstruction.

## 4. Video specs
| Parameter | Requirement |
|-----------|-------------|
| Format | MP4 (preferred), MOV, WebM, AVI |
| Resolution | ≥ 720p (1280×720), 1080p recommended |
| Frame rate | 30 fps minimum; 60 fps preferred for children (faster cadence) |
| Duration | 10–20 seconds per clip (covers ≥ 3 gait cycles) |
| File size | ≤ 200 MB (platform limit) |
| Audio | Not required; mute is fine |

## 5. Capture procedure (per plane)
1. Place cones/tape at start and end of the 6 m walk path.
2. Patient wears form-fitting clothing; shorts that expose knees; bare feet or usual footwear (record which).
3. Camera rolling **before** patient starts walking; record 2 seconds of empty path first.
4. Patient walks at **self-selected comfortable speed** — no "walk like a robot" instructions.
5. Walk past the end cone, then turn around and walk back (gives ≥ 2 directions per clip).
6. Repeat **3 takes per plane** (best take selected for analysis; others kept as backup).
7. Review each clip on-device: full body visible the whole time? No framing cut-offs at feet or head? If no, re-take.

## 6. Naming convention
`session-{session_id}-{plane}-take{n}.mp4`
- `{plane}`: `frontal`, `sagittal`, `third`, or `combined`
- Example: `session-42-sagittal-take2.mp4`

## 7. Physio ground truth (golden sessions only)
For validation sessions (marked `golden=true` in the dataset), the treating physiotherapist records immediately after capture:

| Measurement | Method | Tool |
|-------------|--------|------|
| Knee flexion L / R (max, stance) | Goniometry | Standard goniometer |
| Knee flexion L / R (max, swing) | Goniometry | Standard goniometer |
| Hip flexion L / R (max) | Goniometry | Standard goniometer |
| Ankle dorsiflexion L / R (max stance) | Goniometry | Standard goniometer |
| CP knee pattern | Clinical observation | jump / crouch / stiff / recurvatum / none |
| Pelvic obliquity | Observation | present / absent / side |
| Trendelenburg sign | Observation | positive / negative / side |
| BBS total | Berg Balance Scale (14 items) | 0–4 per item |
| TUG seconds | Timed Up & Go | Stopwatch |
| GMFCS level | I–V | CanChild descriptors |

Physio records onto `tests/golden/golden_dataset.csv` (one row per session).

## 8. Upload & engine run
1. Clinician uploads best take per plane via Gait Lab UI.
2. Runs analysis; engine produces `results.json`.
3. QA: engine status must be `analyzed` (not `rejected`). If rejected, note reason and re-capture per §7.
4. Export PDF + DOCX; attach to session record.

## 9. Data handling
- Videos stored under `uploads/gait/session-{id}/`.
- Never upload to third-party cloud; local/clinic server only.
- Retention: delete after 90 days unless consent says otherwise (see retention policy).

---

**Version:** 1.0  
**Owner:** BRC Clinical Lead  
**Review:** Quarterly, or after any engine version change.
