# BRC Gait Lab — Multi-View Clinical Specification

**Document:** `BRC_Gait_Lab_MultiView_Spec.md`
**Status:** Draft for implementation
**Version:** 1.0
**Role:** Senior Medical Software Architect & Clinical Biomechanist
**Scope basis:** Live production pipeline (`python/gait_lab.py`, `python/gait_analyzer.py`, `python/cv3d.py`, `python/anthropometry.py`, `python/overlay_ocr.py`, `routes/gait.js`, `public/gait.html` + `public/js/gait.js`)

---

## Table of Contents

1. [Purpose & Design Contract](#1-purpose--design-contract)
2. [Role Model & Access Matrix](#2-role-model--access-matrix)
3. [Canonical Data Model (results JSON)](#3-canonical-data-model-results-json)
4. [Mathematical Units & Conventions](#4-mathematical-units--conventions)
5. [View 1 — Family / Patient (Easy-Read)](#5-view-1--family--patient-easy-read)
6. [View 2 — Ordering Clinician (Physician)](#6-view-2--ordering-clinician-physician)
7. [View 3 — Gait Analyst / Physiotherapist](#7-view-3--gait-analyst--physiotherapist)
8. [View 4 — Orthotist / Prosthetist & Surgical Subspecialist](#8-view-4--orthotist--prosthetist--surgical-subspecialist)
9. [View 5 — Clinical QA / Audit (Super Admin)](#9-view-5--clinical-qa--audit-super-admin)
10. [Parameter Registry (master table)](#10-parameter-registry-master-table)
11. [Visualizer Library](#11-visualizer-library)
12. [Data Integrity & Zero-Assumption Protocol Rendering](#12-data-integrity--zero-assumption-protocol-rendering)
13. [Kinetics — Current Scope Boundary & Extension Contract](#13-kinetics--current-scope-boundary--extension-contract)
14. [Implementation Mapping & Roadmap](#14-implementation-mapping--roadmap)

---

## 1. Purpose & Design Contract

This specification defines the **UI structure**, **precise kinematic/kinetic parameters**, **data visualizers**, and **mathematical units** for **five distinct clinical role-based views** of the BRC Gait Lab.

### 1.1 Non-negotiable principles

| # | Principle | Binding reference |
|---|-----------|-------------------|
| P1 | **Zero-assumption protocol** — a parameter is reported only when its supporting keypoints clear the visibility gate; otherwise it is `unassessed` and withheld, never interpolated or padded. | `CONF_GATE = 0.60` (`python/gait_lab.py:116`), `python/gait_validity.py`, `python/gait_lab.py::_build_integrity` |
| P2 | **No fabricated metrics.** A rejected capture prints a professional notice; a failed analysis returns HTTP 500 and stores nothing. | `routes/gait.js:runAnalyzer` |
| P3 | **Single source of truth** for all numbers is the persisted `gait_sessions.results` JSON. Views are projections/filter/aggregates of that document. | `db/database.js`, `routes/gait.js:serialize` |
| P4 | **Role gating is application-layer.** Every view enforces `requireAuth` / `requireStaff` / `requireAdmin` / `requireSuperAdmin`; the DB `CHECK` on `users.role` is narrower than the app's effective role set and must not be relied on. | `routes/auth.js`, `routes/admin.js:491` |
| P5 | **Name-overlay OCR is deferred to export.** OCR never runs at analysis time; the overlay is read only when a PDF/Word report is exported, and the result appears in the QA view / report header. | `python/overlay_ocr.py`, `routes/gait.js:runOcrAtExport` |
| P6 | **Left/Right colour contract.** Left = navy `#1E3C82` (`L`), Right = gold `#C99436` (`R`); green `#2E8540` = in-range, red `#B3452F` = out-of-range, blue band `#46B4DC` = stance, pink band `#9fc3e0`/`#B3452F` = swing. | `public/js/gait.js` |

### 1.2 Letterhead / shared chrome

Every view renders on the clinic letterhead (`clinic_info` config): logo, clinic name, address, email · phone, and the report title bar ("Gait Laboratory Report"), generated timestamp, and confidentiality line — mirrored exactly by `routes/gait.js` PDF and DOCX generators.

---

## 2. Role Model & Access Matrix

Effective roles (application layer): `patient`, `clinician`, `admin`, `super_admin`.

| ID | Role | View | Purpose | Gating |
|----|------|------|---------|--------|
| V1 | Guardian / Family / **Patient** | **Family View** | Plain-language walk-through of what the child can do and the next steps. No raw biomechanics charts by default (expandable "Why?" popovers). | `requireAuth`, session owned by the patient's account only (via `user_id`) |
| V2 | **Ordering Clinician** (referring physician) | **Clinician View** | Summary diagnosis, gait-capture validity, phase timing, deformity summary, prescriptions, prognosis, capture mode, references. | `requireStaff` (read-only) or session owner; mutations require `admin` |
| V3 | **Gait Analyst / Physiotherapist** | **Therapy View** | Full kinematics (angles, ROM, symmetry), per-plane CV, exercise routine, recovery timeframes, prognostic KPIs, progression tracking across sessions. | `requireStaff` |
| V4 | **Orthotist / Prosthetist / Surgical subspecialist** | **Multi-View 3D & Fabrication View** | Dual-plane 3D kinematics, normalized segment lengths, symmetry indices, 3D anatomy plots, orthotic/prosthetic recommendations, deformity detail by plane. | `requireStaff` |
| V5 | **Clinical QA / Audit (Super Admin)** | **Audit View** | Zero-assumption integrity ledger, per-parameter confidence, OCR (export) verification status, review/audit trail, raw results diff, data-completeness. | `requireAdmin` for reads, `requireSuperAdmin` for mutation/export-forensics |

**Access matrix (view × capability):**

| View | Read session | Download raw JSON | Interactive charts | PDF / Word export | Edit session | Review / sign-off |
|------|:---:|:---:|:---:|:---:|:---:|:---:|
| V1 (patient, own) | ✓ | ✓ (own) | ✓ (Easy-Read) | ✓ | — | — |
| V2 (clinician, any) | ✓ | ✓ | ✓ | ✓ | — | ✓ (note-only) |
| V3 (analyst/physio) | ✓ | ✓ | ✓ | ✓ | — | ✓ (note-only) |
| V4 (orthotist/surgical) | ✓ | ✓ | ✓ | ✓ | — | ✓ (note-only) |
| V5 (admin/super_admin) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (full sign-off) |

Route anchors: `GET /api/gait/sessions/:id` (V1–V5), `GET /api/gait/admin/sessions` (V2–V5), `GET /api/gait/sessions/:id/results.json` (all), `GET /api/gait/sessions/:id/report.{pdf,docx}` (all), `PATCH/PUT /api/gait/admin/sessions/:id/*` (V5).

---

## 3. Canonical Data Model (results JSON)

All views consume this persisted document (`gait_sessions.results`). Keys are authoritative (engine = `python/gait_lab.py`).

### 3.1 Top-level

| Key | Type | Notes |
|-----|------|-------|
| `analyzer`, `version`, `mode` | string | `mode ∈ {"video","rejected"}` (real engine) / `"demo"` (legacy analyzer) |
| `generated_at`, `session_id`, `patient`, `diagnostic_note` | string | provenance |
| `cycle` | object | see §3.2 |
| `profile` | object | `{frontal, sagittal, rotational}` ⇒ `{deformities[], assessed, note, stance_notes[]}` |
| `kinematics` | object | `{rom[], summary[]}` — rows `{joint, movement, normal, observed, note}` |
| `muscles` | object | `{overactive[], weak[], notes[], anomaly_links[], structural_weaknesses[]}` |
| `prescriptions` | object | `{exercises[], orthotics[], prosthetics[], guidance[], rationale}` |
| `prediction` | object | severity, patterns, joint_degeneration_risk, compensatory_pathologies, recovery_timeframe, prognostic_kpis, summary, recommendation, disclaimer |
| `references`, `reference_sections` | object | evidence set (R1–R8 core + categorized) |
| `cv` | object | per-plane CV blocks + artifact pointers |
| `cv3d` | object | dual-view 3D block (V4/V3) |
| `cv_split` | object | combined-dual-plane split diagnostics |
| `input` | object | videos, routing (`single-plane` \| `dual-view-3d` \| `combined-dual-view` \| `combined-unroutable`), `height_cm`, `height_source` |
| `gait_validation` | object | `{status, message}` + per-plane map |
| `anthropometry` | object | calibration + 12 segment rows |
| `name_metadata` | object | `status: "deferred"` until export; `verified` / `unverified` / `ocr_unavailable` after on-demand OCR |
| `integrity` | object | zero-assumption ledger (§12) |
| `beginner_summary` | object | plain-language block (V1) |
| `summary` | object | headline, stance/swing, stance_norm_band, findings, narrative, recommendation |
| `focus_areas` | array | prioritized therapy targets |

### 3.2 `cycle` block

| Field | Unit | Notes |
|-------|------|-------|
| `cadence_cycles_per_second` | Hz (cycles/s) | stride cadence |
| `cycle_seconds` | s | single stride duration |
| `stance_pct`, `swing_pct` | % of cycle | swing = 100 − stance |
| `stance_norm_band` | % | normative band `[58, 62]` |
| `phases[]` | array (8) | per phase: `name`, `type ∈ {stance,swing}`, `pct_of_cycle`(%), `pct_delta`(pp), `norm_range_pct[2]`(%), `duration_ms`, `classification`, `flag ∈ {none, prolonged, accelerated, missing}`, `severity`, `note`. Running mode: 9 phases incl. `flight`. |
| `anomalies[]` | array | `{phase, phase_name, type, severity ∈ {minor,moderate,major}, description}` |
| `running` | boolean | running vs walking classification |
| `flight_phase_frac` | fraction | double-float portion of cycle (running) |
| `playback_speed`, `playback_note` | ×, text | resolved k playback factor |

Phase definitions (8 canonical, walk): Initial Contact (0–2%), Loading Response (2–10%), Mid Stance (10–30%), Terminal Stance (30–50%), Pre-Swing (50–60%), Initial Swing (60–73%), Mid Swing (73–87%), Terminal Swing (87–100%).

### 3.3 Per-plane CV block (`cv.sagittal` / `cv.frontal`)

Sagittal (`cv.sagittal`): `plane, status, fps, frames, samples, playback_speed, running, cycle_seconds, cadence_cycles_per_second, stance_pct, swing_pct, stride_symmetry, knee_flexion_si, hip_flexion_si, rom{L,R}, trunk_lean_range, head_tilt_range, specific{...}, deformity_screens, confidence{threshold, parameters, posture, note}, timeseries, plots, overlay_video`.

- `rom.*` per side: `hip_max, hip_min, knee_max, knee_min, ankle_max_df, ankle_max_pf, knee_rom, hip_peak, ankle_rom, shoulder_flex_max, shoulder_flex_rom, elbow_flex_max, elbow_flex_min, elbow_flex_rom` — all °.
- `timeseries`: `cycle_pct` (0–100), `hip_flexion`, `knee_flexion`, `ankle_angle` (°), `posture{trunk_lean, head_tilt}` (°) — normalized one-cycle curves (101 points at 0–100%).

Frontal (`cv.frontal`): `plane, status, fps, frames, samples, playback_speed, running, metrics{...}, confidence, plots, overlay_video`.
- `metrics` (all ° unless noted): `pelvic_obliquity_max/mean`, `lateral_trunk_lean_max`, `knee_valgus_off_max/mean`, `step_width_mean`, `weight_shift_max`, `head_lateral_tilt_max`, `shoulder_drop_max`, `shoulder_drop_norm_pct`(%), `shoulder_abduction_max_L/R`, `hip_abduction_lean_max_L/R/max`, `hip_abduction_asymmetry_deg`, `hip_abduction_means_deg`, `shoulder_protrusion_deg`, `elbow_angle_mean_L/R`, `ankle_foot_align_max_L/R`, `tibiofemoral{L,R:{angle_deg, dev_max, direction}}`, `tibiofemoral_dev_max`, `coronal_load{symmetry_pct(%), heavier_side_load_pct(%), lighter_side_load_pct(%), weight_shift_mean}`, `shoulder_asymmetry_index`, `subtalar{status, reason}`.

### 3.4 `anthropometry` block

`{protocol, calibration{protocol, method ∈ {clinician_height, uncalibrated}, height_cm, px_per_cm, head_correction_frac:0.10, frames_used, covered_frames, status}, segments[], units_note}`.

12 segments: femur L/R, tibia L/R, foot L/R (ankle→toe surrogate), upper_arm L/R, forearm L/R, shoulder_width, wrist_width. Each row: `{code, name, side, value, unit ∈ {cm, fraction_of_stature}, status ∈ {assessed, unassessed}, reason, plane, confidence}`. Calibration anchor: `px_per_cm = median(frame stature incl. 10% vertex correction) / clinician height`; requires ≥ 5 usable frames.

### 3.5 `cv3d` block (dual-view)

`{status, engine ∈ {brc-3d, brc-multiview-3d}, mode: "dual-view-3d", samples, fps_frontal, fps_sagittal, calibration{model:"orthographic-dual-view", cameras, units:"normalized (torso heights)", reference_scale_px, multiview}, joints_3d{L,R}, joint_angles_3d, frontal_angles_3d, segment_lengths, symmetry, timeseries, plots, anatomical_note}`.

- `joint_angles_3d`: `hip_flex, knee_flex, ankle_angle, shoulder_flex, elbow_flex, knee_valgus` — each `{L, R}` in °.
- `segment_lengths`: `thigh_L/R, shank_L/R, upper_arm, forearm, torso` — normalized to torso height (dimensionless units).
- `symmetry`: `knee_flex_si, hip_flex_si, thigh_si, shank_si` — %.

### 3.6 `name_metadata` (OCR, export-time)

Emitted at analysis as `status:"deferred"` (see `python/gait_lab.py`). On PDF/Word export, `routes/gait.js:runOcrAtExport` spawns `overlay_ocr.py` and replaces it with `status ∈ {verified, unverified, ocr_unavailable}` plus `matched_name, cleaned_text, texts_seen[], frames_scanned, confidence (0–1), reason`.

---

## 4. Mathematical Units & Conventions

### 4.1 Unit registry

| Measurement class | Unit | Symbol / format | Source key |
|-------------------|------|-----------------|------------|
| Joint angle / ROM / deviation / tilt / obliquity | degree | `°` | `cv.*.rom`, `kinematics.rom`, `cv.frontal.metrics`, `cv3d.joint_angles_3d` |
| Cadence | cycles per second | `Hz` (cycles/s) | `cycle.cadence_cycles_per_second`, `cv.sagittal.cadence_cycles_per_second` |
| Cycle / phase duration | second / millisecond | `s`, `ms` | `cycle.cycle_seconds`, `cycle.phases[].duration_ms` |
| Phase share / deviation | percent / percentage-point | `%`, `pp` | `cycle.phases[].pct_of_cycle`, `pct_delta`, `stance_pct`, `swing_pct` |
| Normative band | percent | `%` (of cycle) | `stance_norm_band [58,62]` |
| Symmetry index | percent | `%`, `SI` | `cv.sagittal.*_si`, `cv3d.symmetry` (SI raw index, see 4.2) |
| Weight-shift / coronal load surrogate | percent | `%` | `cv.frontal.metrics.coronal_load.*` |
| Segment length (anthropometry) | centimetre / fraction of stature | `cm`, `fraction_of_stature` | `anthropometry.segments[].value/unit` |
| 3D segment length / joint position | normalized (torso heights) | dimension-less | `cv3d.segment_lengths`, `cv3d.joints_3d` |
| Calibration scale | pixels per cm | `px/cm` | `anthropometry.calibration.px_per_cm` |
| Playback factor | × (ratio) | `×` | `cycle.playback_speed` |
| Flight fraction (running) | fraction | 0–1 | `cycle.flight_phase_frac` |
| Confidence / visibility | fraction (0–1) or % | `0–1`, `%` | `integrity.parameters[].confidence`, `cv.*.confidence`, overlay `confidence` |
| Capture routing | enum | `single-plane` \| `dual-view-3d` \| `combined-dual-view` \| `combined-unroutable` | `input.routing` |

### 4.2 Angle conventions

1. **Sagittal angles** are measured against the anatomical neutral (0° = neutral/extended):
   - Hip flexion +, extension −; reported peak flexion (`hip_peak`) and range (`hip_max`−`hip_min`).
   - Knee: 0° = full extension; positive values = flexion (`knee_max`, `knee_rom`).
   - Ankle: dorsiflexion +, plantarflexion − (`ankle_max_df`, `ankle_max_pf`, `ankle_rom`).
2. **Frontal deviations** are absolute magnitudes of deviation from vertical/level (pelvic obliquity = vertical, knee varus/valgus, lateral trunk lean = from vertical, head tilt). All reported as positive magnitudes in °.
3. **3D (multiview) angles** (`cv3d.joint_angles_3d`) use the same neutral convention, computed by orthographic dual-view triangulation, units "normalized (torso heights)". Values not calibrated to a physical ruler unless anthropometry calibration exists; when it does, the calibration banner governs display.
4. **Symmetry index** default formula (mono-lateral index): `SI = 100 − 100·|L − R| / max(|L|,|R|)` (100 = perfect symmetry). A bilateral-paired SI variant is reserved for paired measures (see Roadmap §14).

### 4.3 Reference / norm tables (renderers use these)

| Measure | Normative reference | Source |
|---------|--------------------|--------|
| Hip flexion ROM | 25–45° (norm; red if observed > 45°×1.35) | `ROM_REF` (`gait_lab.py:730`) |
| Knee flexion ROM | 55–75° | `ROM_REF` |
| Ankle ROM (dorsiflexion–plantarflexion) | 20–40° | `ROM_REF` |
| Shoulder flexion ROM | 0–45° | `ROM_REF` |
| Elbow flexion ROM | 0–35° | `ROM_REF` |
| Stance phase share | 58–62% of cycle | `stance_norm_band` |
| Pelvic obliquity | ≤ 12° | `_frontal_rom_plot` |
| Knee varus/valgus | ≤ 15° | `_frontal_rom_plot` |
| Tibiofemoral axis deviation | ≤ 5° | `_frontal_rom_plot` |
| Lateral trunk lean | ≤ 10° | `_frontal_rom_plot` |
| Head/neck lateral tilt | ≤ 8° | `_frontal_rom_plot` |
| Shoulder height asymmetry | ≤ 12% | `_frontal_rom_plot` |
| Shoulder abduction | ≤ 20° | `_frontal_rom_plot` |
| Hip flexion (clinical) | 0–45 flex | `ROM_DEFS` |
| Knee flexion (swing) | 0–60 flex | `ROM_DEFS` |
| Ankle DF / PF | 0–20 DF / 0–50 PF | `ROM_DEFS` |
| Pelvis tilt in stance | 0–5° | `ROM_DEFS` |

### 4.4 Confidence gate

`CONF_GATE = 0.60`. A parameter's confidence = fraction of tracked frames whose keypoints had visibility ≥ gate. Below-gate parameters render as `Unassessed — <reason>` with amber styling and never pad a table.

---

## 5. View 1 — Family / Patient (Easy-Read)

**Role:** Guardian / child family facing; session owner only.
**Purpose:** "What did the walk show, and what do we do next?" in plain language.

### 5.1 UI structure

```
┌────────────────────────────────────────────────────────────┐
│ Letterhead (logo · clinic · generated · confidential)      │
├────────────────────────────────────────────────────────────┤
│ Session metadata bar: #<id> · Age · Gender · Status        │
│ "Beginner-Friendly Summary (Easy Read)"                    │
│   Headline (bold, navy)                                    │
│   Walking  → "What we could see" list                      │
│   Body measurements list                                   │
│   "What to do next" (green) from recommended_next          │
│   Confidence note (italic, small)                          │
├────────────────────────────────────────────────────────────┤
│ [Name verification strip] — optional, downgraded badge     │
├────────────────────────────────────────────────────────────┤
│ Rejection banner (ONLY if mode=rejected)                   │
│   "Analysis blocked — no metrics generated" + reasons      │
├────────────────────────────────────────────────────────────┤
│ Easy-read visualizations:                                  │
│   • Gait-cycle timeline (green=stance / pink=swing)        │
│   • Phase chips (only non-normal flags, e.g. "Long heel    │
│     strike")                                               │
├────────────────────────────────────────────────────────────┤
│ Footer: "Ask your clinician about the full report."        │
└────────────────────────────────────────────────────────────┘
```

### 5.2 Parameters surfaced

- Plain-language phase flags (mapping `flag→friendly label`), e.g. `prolonged` → "Took longer than usual", `accelerated` → "Quicker than usual", `missing` → "Didn't appear").
- `beginner_summary.what_we_found[]`, `measurements[]`, `recommended_next[]`, `confidence_note`.
- None of the raw numeric tables, ROM, muscles, prescriptions, or prediction blocks are shown raw.

### 5.3 Units surfaced

Only friendly: feet on ground "about X% of each step" (from stance_pct, no % required but allowed), durations in seconds, distances as plain language. No degree/Hz symbols.

### 5.4 Visualizers

- Stride timeline (SVG/Chart.js stacked band, width ∝ `pct_of_cycle`).
- Phase status chips colored per flag.

### 5.5 Data source mapping

`r.beginner_summary`, `r.mode`, `r.name_metadata` (deferred display note), `r.cycle.phases`, `r.gait_validation`. Backed by `public/js/gait.js:beginnerSummaryHtml` + `renderReport` Easy-Read path.

---

## 6. View 2 — Ordering Clinician (Physician)

**Role:** Referring clinician, read-only staff.
**Purpose:** Is the capture valid? What is the provisional diagnosis? What parameters/deformities drive it? What treatment/prescriptions and prognosis?

### 6.1 UI structure

```
┌────────────────────────────────────────────────────────────┐
│ Letterhead                                                 │
│ Title "Gait Laboratory Report" + generated/confidential    │
│ Patient · Guardian · Diagnosis · Session · Status          │
│ Demographics (age/gender/mass/height) · clinician          │
│ Capture mode · Analysis engine · [OCR name strip]          │
├────────────────────────────────────────────────────────────┤
│ HEADER CARD                                                │
│  Gait validity (ok / blocked + reasons)                    │
│  Stance X% · Swing Y%  [norm band 58–62%]  speed k×        │
│  Mode: Walking / Running                                   │
├────────────────────────────────────────────────────────────┤
│ 0. Gait Cycle Summary  (phases table + anomalies)          │
│ 1. Clinical Impression  (headline · narrative · focus)     │
│ 2. Multi-Planar Deformity & Biomechanical Analysis         │
│      frontal · sagittal · rotational (name, magnitude,     │
│      category, description)                                │
│ 3. Joint Kinematics / ROM (table joint/movement/ref/obs)   │
│ 4. Muscle Involvement Map (overactive/weak/links)          │
│ 5. Targeted Clinical Prescriptions (exercises table +      │
│      orthotics/prosthetics/guidance + evidence cites)      │
│ 6. Predictive Progression & Prognosis                     │
│      severity badge · patterns · joint-degeneration risk · │
│      compensatory pathologies · recommendation            │
│ 7. References (core + categorized)                          │
├────────────────────────────────────────────────────────────┤
│ Footer: clinical sign-off block + page numbers             │
└────────────────────────────────────────────────────────────┘
```

### 6.2 Parameters & units

- Validity: `gait_validation.status`, blocked-mode professional message (`NO_GENUINE_GAIT_MSG`).
- Timing: stance/swing `%`, `cadence_cycles_per_second` (Hz), `cycle_seconds` (s), per-phase `pct_of_cycle`, `pct_delta` (Δ vs norm, pp), `duration_ms`, `norm_range_pct`.
- Deformities: `profile.*.deformities[].{name, magnitude, category, description, plane, detected}` (magnitude ° or qualitative).
- ROM: `kinematics.rom[]` `{joint, movement, normal, observed}` — observed in °.
- Prediction: `severity ∈ {low, moderately elevated, elevated}`, risk items with horizon strings, `recovery_timeframe{estimated_weeks_low..high, milestones[].week, reassessment_schedule}`.
- Prescriptions: exercises `{name, sets, reps, hold_seconds, rest_seconds, frequency, reason, references}`.
- OCR strip: `name_metadata` rendered as a header line (verified/unverified/deferred/ocr_unavailable) — see §3.6.

### 6.3 Visualizers

- Phase table (8 rows) with Δ arrows ▲ reduced / ▼ prolonged against `norm_range_pct`.
- Anomaly severity chips (`minor`/`moderate`/`major`).
- Optional one-cycle joint angle chart (collapsible).
- No 3D or integrity panels by default.

### 6.4 Implementation anchor

This is the closest match to today's `renderReport` + PDF/DOCX body. New: explicit header treatment of `gait_validation`, phase Δ column, and OCR strip reuse.

---

## 7. View 3 — Gait Analyst / Physiotherapist

**Role:** In-house analyst / physiotherapist planning therapy.
**Purpose:** Detailed kinematics, per-plane CV, ROM, symmetry, exercises, recovery KPIs, and cross-session progression.

### 7.1 UI structure

```
┌────────────────────────────────────────────────────────────┐
│ Letterhead + metadata (as View 2)                          │
├────────────────────────────────────────────────────────────┤
│ TABS:  Timing · Kinematics · Planes · Symmetry ·           │
│        Prescriptions · Prognosis · Progression             │
├────────────────────────────────────────────────────────────┤
│ TIMING       cycle table + timeline + cadence KPIs         │
│ KINEMATICS   interactive joint-angle charts:               │
│              hip / knee / ankle one-cycle (L/R overlay)    │
│              ROM table vs ROM_REF shaded ranges            │
│ PLANES       sagittal CV block:                            │
│                ♦ overlay video thumb + ?download=1         │
│                ♦ rom table (L/R)                           │
│                ♦ posture (trunk lean, head tilt)           │
│                ♦ sagittal_rom/ posture/ gait_cycle/        │
│                  full_rom plot embed                       │
│              frontal CV block: metrics table + plots       │
│ SYMMETRY     stride_symmetry · knee/hip flexion SI (L/R)   │
│              weight-shift/coronal-load % · asymmetry idx   │
│ PRESCRIPTIONS exercise routine + rationale + evidence      │
│ PROGNOSIS    recovery timeframe weeks + milestones +       │
│              prognostic KPIs (baseline & milestone targets)│
│ PROGRESSION  multi-session overlay of stance%, cadence,    │
│              knee/hip ROM, SI (future: requires series)    │
├────────────────────────────────────────────────────────────┤
│ Footer: sign-off + page numbers                            │
└────────────────────────────────────────────────────────────┘
```

### 7.2 Parameters & units

All of View 2 plus specifically:
- `cv.sagittal.rom{L,R}` in ° (all 13 fields per side), `stride_symmetry`, `knee_flexion_si`, `hip_flexion_si` (%).
- `cv.sagittal.specific{trunk_lean_min/max, head_tilt_min/max, shoulder_flex_si, elbow_flex_si, shoulder_offset_vs_pelvis_L/R}`.
- `cv.sagittal.confidence{parameters{L,R per metric}, posture, note}` — confidence fraction per parameter.
- `cv.frontal.metrics` full set incl. `coronal_load{symmetry_pct, heavier_side_load_pct, lighter_side_load_pct, weight_shift_mean}` (%), `tibiofemoral{angle_deg, dev_max, direction}`, `shoulder_asymmetry_index`.
- `cycle.phases[].{pct_of_cycle, pct_delta, duration_ms, flag, classification, severity, norm_range_pct}`.
- `prediction.recovery_timeframe{phase_label, estimated_weeks_low, estimated_weeks_high, milestones[{week, target, metric}], reassessment_schedule, note}`.
- `prediction.prognostic_kpis[{category, targets[{metric, baseline_target, milestone_target}]}]`.
- Confidence note: `cv.frontal.confidence + anthropometry.calibration.status`.

### 7.3 Visualizers

- Interactive Chart.js lines per plane (`cv.*.timeseries`): hip/knee/ankle one-cycle with stance green band + swing pink band; blue=L `/gold=R`.
- Embedded PNG plots: `sagittal_rom_plot`, `sagittal_posture_plot`, `gait_cycle_plot`, `full_rom_plot`, `frontal_plot`, `frontal_rom_plot` (all served via `GET /api/gait/sessions/:id/artifacts/:file`).
- Symmetry gauges: dual-dial per measure (L vs R), center 100% = symmetric.
- Cross-session progression line chart (reserved dataset: sessions grouped by patient, newest overlay).

---

## 8. View 4 — Orthotist / Prosthetist & Surgical Subspecialist

**Role:** Intervention planner for devices / surgical candidacy.
**Purpose:** Dual-plane 3D kinematics, normalized segment lengths, symmetry, 3D reconstructions, deformity detail, orthotic/prosthetic recommendations.

### 8.1 UI structure

```
┌────────────────────────────────────────────────────────────┐
│ Letterhead + metadata                                      │
├────────────────────────────────────────────────────────────┤
│ TABS:  3D Kinematics · Segments · Deformities · Devices    │
├────────────────────────────────────────────────────────────┤
│ 3D KINEMATICS  engine badge + samples + calibration note   │
│                ("normalized (torso heights)" unless        │
│                calibrated)                                 │
│                joint angle table 3D: hip_flex / knee_flex /│
│                ankle_angle / shoulder_flex / elbow_flex /  │
│                knee_valgus (L, R) °                        │
│                interactive 3D angle charts                 │
│                3D anatomy plot (sim3d_anatomy) embed       │
│                3D angle plot (sim3d_angles) embed          │
│ SYMMETRY       knee/hip/thigh/shank SI table              │
│ SEGMENTS       normalized segment lengths table            │
│                (thigh/shank/upper_arm/forearm/torso)       │
├────────────────────────────────────────────────────────────┤
│ DEFORMITIES    per-plane: frontal / sagittal / rotational  │
│                detail cards (magnitude °, category,        │
│                description)                                │
│ DEVICES        orthotics list + prosthetics list with      │
│                component + reason + evidence references     │
│ (if calibrated) anthropometry cm table with calibration    │
│                banner (px/cm)                              │
├────────────────────────────────────────────────────────────┤
│ Footer: sign-off                                            │
└────────────────────────────────────────────────────────────┘
```

### 8.2 Parameters & units

- `cv3d.joint_angles_3d` — values in °; `{L,R}` present only where per-side exists.
- `cv3d.segment_lengths` — normalized to torso height (dimensionless); if `anthropometry.calibration.status == "calibrated"`, a parallel cm panel is shown from `anthropometry.segments[].value/unit`.
- `cv3d.symmetry.{knee_flex_si, hip_flex_si, thigh_si, shank_si}` — %.
- `cv3d.calibration{model:"orthographic-dual-view", units:"normalized (torso heights)", reference_scale_px, multiview}`.
- `profile.*.deformities[]` with `plane` classification (structural/functional/rotational).
- `prescriptions.orthotics[]`, `prescriptions.prosthetics[]` — each `{component, reason, references[]}`.
- Anthropometry 12-segment table with `unit ∈ {cm, fraction_of_stature}` and per-segment `status/confidence`.

### 8.3 Visualizers

- Embedded `sim3d_anatomy.png` + `sim3d_angles.png` (dpi 150) from `cv3d.plots`.
- 3D angle interactive charts (`cv3d.timeseries`).
- Device recommendation cards with evidence footnotes (`references` short cites).
- Calibration badge: `Calibrated with physician height X cm` vs `UNCONVERTED — pixel-only`.

---

## 9. View 5 — Clinical QA / Audit (Super Admin)

**Role:** QA of the analysis itself, not of the patient alone.
**Purpose:** Trust the numbers: integrity ledger, per-parameter confidence, OCR (export) verification, review/audit trail, and raw-results forensics.

### 9.1 UI structure

```
┌────────────────────────────────────────────────────────────┐
│ Letterhead + metadata                                      │
├────────────────────────────────────────────────────────────┤
│ DATA INTEGRITY  "Data Integrity & Confidence              │
│                 (Zero-Assumption Protocol)"                │
│   status badge: assessed | partial                        │
│   summary sentence                                        │
│   table: parameter · value · confidence% · status ·       │
│          reason (rows=integrity.parameters[])             │
│   unassessed list (amber) with reasons                    │
├────────────────────────────────────────────────────────────┤
│ NAME METADATA  OCR panel:                                 │
│   status: deferred/verified/unverified/ocr_unavailable    │
│   engine · frames_scanned · texts_seen[] · cleaned_text · │
│   confidence · matched_name vs expected_name · reason     │
│   [Run OCR] button → POST export-trigger (reruns read)    │
├────────────────────────────────────────────────────────────┤
│ REVIEW & AUDIT  session status · reviewed_by ·            │
│                 reviewed_at · review_note                 │
│                 audit trail (audit_logs rows for gait)    │
│   actions: edit details · override results (V5-only)      │
│            sign off (status → reviewed)                   │
├────────────────────────────────────────────────────────────┤
│ RAW (dev)      syntax-highlighted results.json viewer +   │
│                JSON download                              │
└────────────────────────────────────────────────────────────┘
```

### 9.2 Parameters & units

- `integrity.protocol`, `status ∈ {assessed, partial}`, `confidence_threshold (0.60)`, `parameters[] {parameter, value, confidence(0–1), status, reason}`, `unassessed[]`, `name_verification`.
- `name_metadata.*` (see §3.6) — confidence 0–1, `frames_scanned`, `engine ∈ {rapidocr, none}`.
- `analyzer_meta{engine, version, mode, generatedAt}` from `gait_sessions.analyzer_meta`.
- `gait_sessions` row: `status ∈ {created, analyzed, reviewed}`, `reviewed_by`, `reviewed_at`, `review_note`.
- Audit: `audit_logs.admin_id, admin_name, action, target_type, target_id, detail, created_at` (rows tagged `gait_*`).
- Annex: raw `results.json` diff handles (forensic, V5-only modal).

### 9.3 Visualizers

- Confidence histogram per parameter family (sagittal/frontal/anthropometry/name) — bar height = confidence, gate line at 0.60.
- Integrity tree: parameters collapsed by domain (kinematics / profile / anthropometry / name_metadata) with per-branch worst-case confidence.
- OCR panel with `texts_seen` chips and matched-vs-expected names.

---

## 10. Parameter Registry (master table)

Columns: **Code** (exact results key) · **View visibility** (V1–V5) · **Unit** · **Class** · **Confidence-gated?** · **Visualizer**.

| Code | V1 | V2 | V3 | V4 | V5 | Unit | Class | Gate? | Visualizer |
|------|:--:|:--:|:--:|:--:|:--:|------|-------|:-----:|------------|
| `cycle.stance_pct` / `swing_pct` | ✓ | ✓ | ✓ | ✓ | ✓ | % | timing | – | timeline / KPI |
| `cycle.cadence_cycles_per_second` | – | ✓ | ✓ | ✓ | ✓ | Hz | timing | – | KPI card |
| `cycle.cycle_seconds` | ✓* | ✓ | ✓ | ✓ | ✓ | s | timing | – | KPI card |
| `cycle.phases[].pct_of_cycle` | ✓* | ✓ | ✓ | ✓ | ✓ | % | timing | – | timeline |
| `cycle.phases[].pct_delta` | – | ✓ | ✓ | ✓ | ✓ | pp | timing | – | Δ arrows |
| `cycle.phases[].duration_ms` | – | ✓ | ✓ | – | ✓ | ms | timing | – | table |
| `cycle.phases[].norm_range_pct` | – | ✓ | ✓ | – | ✓ | % | timing | – | table band |
| `cycle.phases[].flag/severity` | ✓* | ✓ | ✓ | ✓ | ✓ | enum | timing | – | chips |
| `cycle.anomalies[]` | – | ✓ | ✓ | ✓ | ✓ | enum+desc | timing | – | severity chips |
| `cycle.running` / `flight_phase_frac` | ✓* | ✓ | ✓ | – | ✓ | frac | timing | – | chip |
| `cycle.playback_speed` | – | ✓ | ✓ | ✓ | ✓ | × | capture | – | KPI |
| `kinematics.rom[]` | – | ✓ | ✓ | ✓ | ✓ | ° | ROM | – | table / bars |
| `profile.*.deformities[]` | – | ✓ | ✓ | ✓ | ✓ | °/qual | deformity | – | cards |
| `muscles.overactive/weak/links` | – | ✓ | ✓ | – | ✓ | enum | muscles | – | lists |
| `prescriptions.exercises[]` | ✓* | ✓ | ✓ | ✓ | ✓ | sets/reps/s/h | therapy | – | table |
| `prescriptions.orthotics/prosthetics[]` | – | ✓ | ✓ | ✓ | ✓ | enum | devices | – | cards |
| `prediction.severity` | – | ✓ | ✓ | – | ✓ | enum | prognosis | – | badge |
| `prediction.recovery_timeframe` | – | ✓ | ✓ | – | ✓ | weeks | prognosis | – | milestones |
| `prediction.prognostic_kpis[]` | – | – | ✓ | – | ✓ | mixed | prognosis | – | KPI targets |
| `cv.sagittal.rom.*` | – | – | ✓ | ✓ | ✓ | ° | kinematics | ✓ | table + charts |
| `cv.sagittal.knee_flexion_si` / `hip_flexion_si` | – | – | ✓ | ✓ | ✓ | % | symmetry | ✓ | gauge |
| `cv.sagittal.trunk_lean_range` / `head_tilt_range` | – | – | ✓ | – | ✓ | ° | posture | ✓ | line chart |
| `cv.frontal.metrics.*` | – | – | ✓ | ✓ | ✓ | ° / % | frontal | ✓ | table / bars |
| `cv.frontal.metrics.coronal_load.*` | – | – | ✓ | ✓ | ✓ | % | load surrogate | ✓ | dials |
| `cv.frontal.metrics.tibiofemoral.*` | – | – | ✓ | ✓ | ✓ | ° | frontal | ✓ | table |
| `anthropometry.segments[].value/unit` | – | – | ✓ | ✓ | ✓ | cm / frac | anthropometry | ✓ | table |
| `anthropometry.calibration.status` | – | – | ✓ | ✓ | ✓ | enum | anthropometry | – | banner |
| `cv3d.joint_angles_3d.*` | – | – | ✓ | ✓ | ✓ | ° | 3D kinematics | ✓ | chart |
| `cv3d.segment_lengths.*` | – | – | ✓ | ✓ | ✓ | torso-h | 3D | ✓ | table |
| `cv3d.symmetry.*_si` | – | – | ✓ | ✓ | ✓ | % | 3D symmetry | ✓ | gauge |
| `cv3d.plots.*` | – | – | ✓ | ✓ | ✓ | PNG | 3D | – | embed |
| `integrity.parameters[]` | – | – | – | – | ✓ | 0–1 | QA | – | histogram |
| `name_metadata.*` | ✓* | ✓ | ✓ | ✓ | ✓ | 0–1 / enum | QA/OCR | – | OCR strip |

`✓*` = only in friendly/flattened form (never raw units). All confidence-gated parameters render amber `Unassessed — <reason>` below the 0.60 gate.

---

## 11. Visualizer Library

### 11.1 Static engine plots (server-generated PNG, dpi 140/150)

Served: `GET /api/gait/sessions/:id/artifacts/:file` (whitelist regex `^[A-Za-z0-9_\-]+\.(mp4|png|jpg|jpeg)$`).

| File | Domain | Spec | Source |
|------|--------|------|--------|
| `sagittal_rom_plot.png` | ROM | 5-panel (hip/knee/ankle/shoulder/elbow) over 101-pt normalized cycle, L navy / R gold | `gait_lab.py::_sagittal_plots` |
| `sagittal_posture_plot.png` | posture | trunk lean + head tilt vs sample | `gait_lab.py::_sagittal_plots` |
| `gait_cycle_plot.png` | timing | one-cycle joint angles; green stance band, pink swing band; L/R knee & hip lines | `gait_lab.py::_gait_cycle_plot` |
| `full_rom_plot.png` | ROM | L/R bars vs `ROM_REF`, green in-range / red > 1.35× ref | `gait_lab.py::_full_rom_plot` |
| `frontal_plot.png` | frontal | lateral trunk lean + pelvic obliquity vs sample | `gait_lab.py` (analyze_frontal) |
| `frontal_rom_plot.png` | frontal | 8 metrics vs refs (obliq ≤12°, valgus ≤15°, tibiofemoral ≤5°, lean ≤10°, tilt ≤8°, drop ≤12%, abd ≤20°) | `gait_lab.py::_frontal_rom_plot` |
| `sim3d_anatomy.png` | 3D | reconstructed frontal+sagittal projections | `cv3d.py` |
| `sim3d_angles.png` | 3D | 3D joint-angle curves | `cv3d.py` |

### 11.2 Interactive charts (Chart.js, client, from `cv.*.timeseries` / `cv3d.timeseries`)

| Chart | Data | Series/colors |
|-------|------|---------------|
| One-cycle joint angles | `cv.sagittal.timeseries{cycle_pct, hip_flexion, knee_flexion, ankle_angle}` | L navy / R gold; stance green band / swing pink band |
| Postural displacement | `cv.sagittal.timeseries.posture{trunk_lean, head_tilt}` | per-metric line |
| Frontal dynamics | `cv.frontal.metrics.timeseries` | per-metric line |
| 3D joint angles | `cv3d.timeseries{joint_angles}` | L/R overlay |
| Symmetry gauges | `*_si` + `coronal_load` | dial 0–100%, center = 100% |
| Confidence histogram (V5) | `integrity.parameters[]` | bar per parameter, gate line 0.60 |

### 11.3 Rendering contracts

- Any value that is `null`, missing, or `unassessed` renders `—` or the amber reason; **never** a blank or fabricated number.
- Plots/artifacts that are missing render an inline note "(3D graph not embedded — artifact missing)".

---

## 12. Data Integrity & Zero-Assumption Protocol Rendering

Presented in **View 5** and (summarized) as a confidence note in **V3/V4** calibration banners.

- `integrity.status` badge: `assessed` (green) | `partial` (amber, any unassessed).
- `integrity.summary` sentence rendered verbatim.
- Each `parameters[]` row: parameter code → human label, value, `confidence×100%`, status chip, reason.
- `name_verification` — mirrors OCR panel (§9.1).
- An **unassessed** parameter is withheld from every other view's tables (V2–V4) except where the amber reason is explicitly needed.

---

## 13. Kinetics — Current Scope Boundary & Extension Contract

**Current pipeline computes kinematics only** (angles, timing, symmetry, segment lengths, coronal-load surrogate). There is **no force platform, GRF, inverse dynamics, joint moment, or joint power**.

For specification completeness, kinetic views reserve the following **SI units and formulas** and render "Not supported — requires force/reaction instrumentation" until a source exists:

| Quantity | Unit | Formula anchor (future) |
|----------|------|-------------------------|
| Vertical ground reaction force | N or %BW | `vGRF = m·(a_z + g)` idealization; %BW = N / (m·g) |
| Joint moment | N·m or N·m/kg | `M_j = Σ (r × F)` over distal-up stack; normalized by body mass |
| Joint power | W/kg | `P_j = M_j · ω_j` |
| Mechanical work (net per cycle) | J/kg | `W_j = ∫ P_j dt` over cycle |
| CoP / base of support | m | from force-plate or heel/toe landmarks |
| Spatio-temporal derivatives | m/s (velocity), m/s² (acceleration) | numerical differentiation of CoM/heel markers |

When instrumentation is added, a new top-level results block `kinetics{}` will be specified following the same `{parameter, value, unit, confidence, status, reason}` row contract and the same zero-assumption gating. The kinetic panels in V3 (gait analyst) and V4 (surgical) are the designated display targets.

---

## 14. Implementation Mapping & Roadmap

### 14.1 Current code anchors

| Concern | File / anchor |
|---------|---------------|
| Results generation | `python/gait_lab.py::derive_clinical` (line ~1944) |
| Reference/norm tables | `python/gait_analyzer.py` (`ROM_DEFS`, `ANOMALY_CATALOG`, `DEFORMITY_*`, `ARCHETYPES`, `PREDICTION_TABLE`) |
| ROM norms (render-side) | `python/gait_lab.py:ROM_REF` (line 730) |
| Frontal reference bands | `python/gait_lab.py::_frontal_rom_plot` (line 819) |
| 3D multiview | `python/cv3d.py` (`run_multi_view_3d`, line 535) |
| Anthropometry | `python/anthropometry.py` (`SEGMENT_DEFS`, calibration) |
| OCR (export-only) | `python/overlay_ocr.py::main`; `routes/gait.js::runOcrAtExport` |
| Routes & roles | `routes/gait.js` (routes, `requireAuth/requireAdmin`), `routes/auth.js` |
| Frontend | `public/gait.html`, `public/js/gait.js` (`renderReport`, chart builders, CV/3D/integrity renderers) |
| PDF / DOCX | `routes/gait.js` `report.pdf` / `report.docx` |

### 14.2 Implementation roadmap for the 5 views

| Stage | Work | Views |
|-------|------|-------|
| 1 | Extract a **view-matrix module** (parameter → visibility per V#) shared by frontend + report generators; prevents drift between `renderReport` and PDF/DOCX | all |
| 2 | Promote the existing single renderer into **view selectors** (role-based routing on `users.role` for V1/V5; `requireStaff` for V2–V4) | V1–V5 |
| 3 | Build **V1 easy-read** on `beginner_summary` (already emitted), phase-flag friendly labels, timeline | V1 |
| 4 | Refactor existing report body into **V2** (validity header, phase Δ, OCR strip, sign-off) | V2 |
| 5 | Add **V3 therapy tab** (symmetry gauges, coronal load, recovery milestones, progression placeholder) | V3 |
| 6 | Add **V4 fabrication tab** (3D kinematics, segment lengths, device cards) — mostly present, needs tabbed assembly | V4 |
| 7 | Add **V5 audit** (integrity histogram, OCR panel with re-run, review/audit trail, raw JSON diff) | V5 |
| 8 | **Kinetics extension** — see §13 (blocked until instrumentation) | V3, V4 |

### 14.3 Open decisions / gaps

1. **Kinetics** (see §13) — currently out of scope by data source, not by design.
2. **Progression view (V3)** requires historical series; today each result is a point-in-time snapshot. Multiple sessions already persist — a patient-grouped series query is the precondition.
3. **DB role CHECK** is narrower than app roles (`patient`/`admin` only in the CHECK). Any migration touching roles must ALTER the constraint to `('patient','clinician','admin','super_admin')` or rely solely on app-layer gating.
4. **Colour contrast / accessibility** for the amber "unassessed" and pink swing band should be verified against WCAG AA before ship.

---

*End of specification. All parameters, units, and visualizers trace to the live pipeline; nothing in this document invents a data source that the engine does not produce.*