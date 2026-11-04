# BRC Gait Lab — Full Project Plan

**Version:** 1.0 — Draft for execution
**Date:** 2026-11-02
**Repo:** `E:\brc-website` (Bonsai Rehabilitation Center website)
**Companion specs:**
- `BRC_Gait_Lab_MultiView_Spec.md` (v1.0 — 5-view clinical specification, principles P1–P6)
- `j.txt` (pending idea: SMPL-X 2D→3D angle-correction fitting)
- `E:\Gait lab\BRC Gait Lab.pptx` (clinic-facing vision deck)

---

## 1. Where the project stands today (verified state)

### 1.1 Already built (working production pipeline)

| Layer | Asset | Size | Status |
|---|---|---|---|
| Vision engine | `python/gait_lab.py` (sagittal + frontal 2D cine analysis, phase D/E confidence model, zero-assumption ledger `_build_integrity`) | 122 KB | Live |
| Legacy/alternative analyzer | `python/gait_analyzer.py` (ROM_DEFS, ANOMALY_CATALOG, DEFORMITY_*, ARCHETYPES, PREDICTION_TABLE, recovery milestones) | 77 KB | Live (demo-classical path) |
| 3D | `python/cv3d.py` (`run_multi_view_3d`, orthographic dual-view triangulation, `brc-multiview-3d` calibrated mode) | 25 KB | Live |
| Anthropometry | `python/anthropometry.py` (12 segments, clinician-height calibration, ≥5-frame gate) | 11 KB | Live |
| Validity | `python/gait_validity.py` (capture rejection / quality gates) | 33 KB | Live |
| OCR | `python/overlay_ocr.py` (name-overlay verification, **export-time only** per P5) | 10 KB | Live |
| Plane routing | `python/classify_plane.py` (single-plane / dual-view-3d / combined routing) | 8 KB | Live |
| API | `routes/gait.js` (sessions, results JSON, PDF + DOCX letterhead reports, `runOcrAtExport`, admin routes, review/sign-off) | 109 KB | Live |
| Frontend | `public/gait.html` + `public/js/gait.js` (multi-view renderer, role-based **view-matrix API** `/api/gait/view-matrix`, view switcher, phase chips, V5 OCR re-scan panel, V3 multi-session progression UI, 2D timeseries + 3D plots) | — | Live |
| DB | `gait_sessions` table (`status: created→analyzed→reviewed`, results JSON, review fields, height/age/gender/mass/clinician metadata, combined video columns) | — | Live |
| Roles | `patient / clinician / admin / super_admin` enforced app-layer (`requireStaffView / requireAdmin / requireSuperAdmin` in `routes/auth.js`, per-route guards in `routes/gait.js`, `applyRoleAccess` in frontend) | — | Live |
| Marketing/demo | `gait lab/` standalone Python demo (app.py, engine.py, promo video pipeline, MP4 outputs); `E:\Gait lab\BRC Gait Lab Journey\index.html` journey page; sample report PDF #137 | — | Reference material |

**Conclusion: the Gait Lab is roughly 70–80% implemented.** A single analyzed session flows end-to-end: upload → plane routing → MediaPipe extraction → kinematics/phases/deformities/muscles/prescriptions/prediction → results JSON persist → role-based views → PDF/DOCX export with deferred OCR.

### 1.2 Known gaps (from spec §14.3 + my audit)

1. **View matrix not shared with PDF/DOCX generators** — spec stage 1; report generators and `renderReport` can drift.
2. **V1 easy-read view** — `beginner_summary` is emitted by the engine but the dedicated patient view assembly (stage 3) is partial.
3. **V3 progression** — UI shell exists, but needs the patient-grouped session-series query and real trend logic (has data: multiple sessions per patient already persist).
4. **V5 audit view** — integrity ledger + OCR panel exist; histogram, raw-JSON diff, export forensics missing.
5. **Kinetics** — out of scope by data source (no force plate); contract in spec §13 unimplemented.
6. **DB `CHECK` on roles is stale** — narrower than app roles; migration needed if touched.
7. **WCAG AA contrast** for amber "unassessed" / pink swing band unverified.
8. **Uncommitted work** — repo has many modified files and one commit ("Bonsai Rehab Center deploy"); Python deps have no pinned `requirements.txt` (it was deleted).
9. **SMPL-X angle correction** (`j.txt`) — not started.
10. **No automated tests** for the Python engine or Node routes.

---

## 2. Goals & non-goals

### 2.1 Goals (definition of "full")

- **G1.** All five clinical views (V1 Family, V2 Clinician, V3 Therapy, V4 Fabrication/3D, V5 Audit) implemented per spec, driven by a single shared view-matrix module.
- **G2.** Reports (PDF + DOCX) render identically to the on-screen view for the requesting role, with export-time OCR verification properly surfaced, signed off by a reviewer.
- **G3.** Session progression: a patient's multi-session trend (per-joint ROM, symmetry indices, phase flags) available in V3 and admin dashboard, with restore/diff against a baseline session.
- **G4.** Engine hardening: golden-output regression tests on recorded sample videos; capture rejection and unassessed paths covered; zero-assumption ledger verified end-to-end.
- **G5.** 3D accuracy uplift: SMPL-X fitting spike (CPU, offline, per-frame `.obj` + corrected 3D angles) behind a flag, cutover decision by measured angle error vs manual goniometry.
- **G6.** Production-hardened deployment: HTTPS domain, real `JWT_SECRET`, Render deploy, automated SQLite backup, audit-log retention.
- **G7.** Clinical rollout kit: capture SOP (camera distances, heights, consent), staff training, patient-facing explainer, validation checklist against physiotherapist manual assessment.

### 2.2 Non-goals (explicit)

- Real-time/wearable kinetics (force plates, IMUs, GRF estimation) — until instrumented (spec §13 contract stands).
- Neural-network retraining on clinic data during Phases 1–4; only SMPL-X fitting is considered and only offline.
- Pushing individual-level clinical data through SMPL-X cloud services or any third-party API (privacy: everything stays local per `j.txt`).
- Rewriting Express/SQLite into another stack.

---

## 3. Phased roadmap

Every phase has: scope, acceptance criteria (AC), and estimated effort. Current team: you (solo dev, Claude-opencode assisted).

### Phase 0 — Stabilize the baseline (½–1 day) 🔴 do first

| # | Task | Detail |
|---|---|---|
| 0.1 | Commit the tree | Review `git status`, split into logical commits, push to a private GitHub remote (no patient/real `.env`, check `db/*.db` and `uploads/` are ignored) |
| 0.2 | Restore `requirements.txt` | Pin mediaapi/mp job versions actually used (mediapipe, opencv, numpy, pillow, whatever imports resolve today) + add `pip freeze` |
| 0.3 | Environment parity doc | Node ≥18, Python 3.13, `.task` model files (full/heavy) placement, ffmpeg path — into README Gait Lab section |
| 0.4 | Smoke check | `npm start`, book a fake patient, run one sagittal + one dual-view capture with a sample video, confirm session + PDF + DOCX exports succeed |

**AC:** clean push to origin, reproducible setup from README in one pass, smoke check green.

### Phase 1 — Engine hardening & golden tests (2–3 days)

| # | Task | Detail |
|---|---|---|
| 1.1 | Golden-fixture harness | `tests/engine/` — check in 3 sample videos (walk-sagittal, walk-frontal, run), run `python/gait_lab.py` offline, store expected results JSON as fixtures (hash-normalized timestamps) |
| 1.2 | Unit tests: validity gates | `gait_validity.py` rejection cases: short clips, occlusion, low fps, focus blur, name-overlay detection negative/positive |
| 1.3 | Unit tests: anthropometry calibration | Height from `px_per_cm` with synthetic frames; ≥5-frame gate; head-correction 10% |
| 1.4 | Determinism check | Same input run twice ⇒ byte-diff only in `generated_at`/`session_id` |
| 1.5 | Version stamping | Engine emits `engine_git_sha`, `requirements_hash` into results JSON (auditable provenance for V5) |
| 1.6 | CI | GitHub Actions: `ruff` style, pytest engine tests offline (small model only — heavy model on manual runs), `npm` server boots, `node --test` if added |

**AC:** `pytest tests/` passes offline; a deliberate engine regression is caught by golden diff in CI.

### Phase 2 — Finish the 5-view UI (spec stages 1–7) (4–5 days, largest phase)

Stage order from spec §14.2:

| # | Stage | Task | Files touched |
|---|---|---|---|
| 2.1 | Stage 1 | **View-matrix module**: extract parameter→visibility matrix into one JS module consumed by `public/js/gait.js` AND by `routes/gait.js` PDF/DOCX generators (no drift per V#) | new `config/gait-view-matrix.js` |
| 2.2 | Stage 2 | Role-based view routing on `/gait.html` load (V1/V5 by `users.role`; V2–V4 by `requireStaff`), preview switcher stays for demo | `gait.js`, `routes/gait.js` |
| 2.3 | Stage 3 | **V1 Family View**: big easy-read cards from `beginner_summary`, phase-flag friendly labels ("Long heel rul..." plain language), "Why?" popovers → optional advanced detail, no raw charts by default | `gait.js` |
| 2.4 | Stage 4 | **V2 Clinician View**: validity header (rejected-capture notice copy), phase Δ table, OCR strip in header, note-only sign-off box | `gait.js`, `routes/gait.js` |
| 2.5 | Stage 5 | **V3 Therapy View**: symmetry gauges (knee/hip SI), coronal load panel, recovery milestones from `gait_analyzer.py` PREDICTION_TABLE, exercise routine emphasis | `gait.js` |
| 2.6 | Stage 6 | **V4 Fabrication View**: dual-plane 3D tab assembly, normalized segment lengths table, orthotic/prosthetic device cards, deformity detail by plane with `tibiofemoral` L/R rows | `gait.js` |
| 2.7 | Stage 7 | **V5 Audit View**: integrity ledger histogram (per-parameter confidence distribution), OCR panel with re-run (already exists — extend with export forensics), raw results JSON viewer + diff vs previous session, audit trail list from `audit_logs` | `gait.js`, `routes/gait.js` |
| 2.8 | — | Report generators (PDF + DOCX) become per-view section filters using the same matrix (2.1); retest all 5 exports visually | `routes/gait.js` |
| 2.9 | — | WCAG AA check for amber "unassessed" chip and pink swing band; fix colours in one tokens block | `style.css` |

**AC:** log in as each role and every view renders correctly + exports match the screen; hidden-parameter spot-check: for V1, no ° metric appears without a "Why?" popover; V5 shows the unassessed ledger for a rejected session.

### Phase 3 — Progression & history (2 days)

| # | Task | Detail |
|---|---|---|
| 3.1 | Series API | `GET /api/gait/admin/patients/:id/progression` — patient-grouped session series query (the precondition noted in spec §14.3.2) |
| 3.2 | Trend computation | Per parameter (hip/knee ROM L/R, SI, stance %, valgus, cadence): delta vs baseline session + direction arrows, with `unassessed` gaps respected (no interpolation — P1) |
| 3.3 | V3 progression chart | Multi-session line charts replacing the placeholder (C6 exists as scaffold) |
| 3.4 | Admin dashboard | Patient detail panel gains a "Gait progression" mini sparkline (reuses 3.2) |
| 3.5 | Baseline/referral | "Set as baseline" action (admin), used for trend deltas |

**AC:** patient with 3 sessions shows a real trend chart; regress on a fixture set where session 2 analysis data changes only one number, and charts update.

### Phase 4 — Deployment & data safety (1–2 days, parallel with Phase 3)

| # | Task | Detail |
|---|---|---|
| 4.1 | Render deploy | Use existing `render.yaml`; set `JWT_SECRET`, `PORT`, disk volume for `db/` + `uploads/` |
| 4.2 | Backup job | `npm run backup` wired to a scheduled job, Restore drill once |
| 4.3 | HTTPS + domain | Custom domain on Render; verify cookie `Secure` flag set in prod env |
| 4.4 | Uploads hygiene | Session video retention policy (delete raw video N days after export), storage quota check — PHI minimization |
| 4.5 | Consent & notices | In-app capture consent text (a child under therapy Assent + guardian consent), privacy statement for video storage |
| 4.6 | Staging | Render preview environment staff use before production data arrives |

**AC:** production URL loads over HTTPS, fake deploy smoke passes including a full patient session end-to-end, backup download + restore drill succeeded once.

### Phase 5 — SMPL-X 3D fitting spike (3–4 days, R&D; may run in parallel with Phase 3/4)

Scope per `j.txt` verbatim:

| # | Task | Detail |
|---|---|---|
| 5.1 | Module | `python/smplx_fit.py` — takes existing MediaPipe 33-landmark output, maps to OpenPose format SMPLify-X expects, runs SMPLify-X offline on CPU |
| 5.2 | Output | Corrected 3D joint angles per frame + `.obj` mesh export per analyzed frame; exposed alongside, not instead of, current `cv3d.py` output |
| 5.3 | Plug-in point | After MediaPipe extraction, before existing angle-smoothing/gait-cycle `gait_lab.py` — behind `BRC_SMPLX=1` env flag; existing report logic untouched |
| 5.4 | Validation | 5 paired comparisons (SMPL-X corrected angle vs manual goniometer by physiotherapist on the same video); report mean abs error old vs new |
| 5.5 | Decision gate | If mean error improves ≥ 20% → promote to standard dual-view-3d pipeline; else document and park |

**AC:** offline, CPU-only demo reproduces a per-frame `.obj` + corrected angles on one recorded walk; go/no-go decision written into `docs/smplx-decision.md`. Uses `pose_landmarker_full.task` models already checked in.

### Phase 6 — Kinetics extension contract (post-G5; no new infrastructure)

Per spec §13: keep as design-only. Write `docs/kinetics-extension.md` documenting exactly what a force plate / ground-reaction input (e.g. OpenCap-style markerless force estimation or clinical scale-based GRF approximation) would need to plug in — engine interface, schema additions, view changes — without implementing estimation today.

**AC:** doc reviewed, schema-compatible; no runtime code change.

### Phase 7 — Clinical rollout kit (2 days, after Phase 2/4)

| # | Task | Detail |
|---|---|---|
| 7.1 | Capture SOP | `docs/capture-sop.md`: camera distances/heights, plain-background setup, video lengths, playback-speed tip in `speed_hint`, name banner requirement (feeds export-time OCR), clinician height entry gate for anthropometry |
| 7.2 | Staff training | 1-hour walkthrough per view; clinician note-taking workflow; admin review/sign-off workflow |
| 7.3 | Family explainer | One-page Arabic+English patient leaflet linking to V1 easy-read |
| 7.4 | Validation record | 5–10 cases: engine verdict vs treating physiotherapist assessment → documented concordance/disagreements (feeds Phase 5 decision too) |

**AC:** BRC staff complete one real patient session each; captured SOP violations logged and fed back.

---

## 4. Timeline (suggested)

| Weeks | Phases running |
|---|---|
| W1 | 0 → 1 (baseline, tests, hardening) |
| W2 | 2 (5-view UI) |
| W3 | 3 + 4 (progression + deploy) |
| W4 | 5 (SMPL-X spike) ∥ 7 (rollout kit) |
| W5 | buffer + acceptance pass + sign-off drill |

≈ 4–6 weeks part-time solo. Phase 5 is the only genuinely uncertain one; it has its own decision gate and can be parked without hurting the rest.

---

## 5. Risks & mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| MediaPipe/Python version drift breaks engine | High | Pinned `requirements.txt` (Phase 0.2), golden tests (1.1), CI |
| View drift between screen and reports | Medium | Shared view-matrix module (2.1) — single source of truth |
| PHI exposure (videos, names via OCR) | High | Retention policy (4.4), consent notices (4.5), no third-party upload (2 Non-goals), httpOnly+Secure cookies, real JWT secret before live |
| SMPL-X heavy on CPU / license | Medium | Flagged optional (5.3); farm titles: it stays local-only; decision gate can park it |
| Single-file SQLite scale/concurrency | Low-Medium | Fine for one clinic; Render volume; backup drill; document Postgres migration path |
| Report/PDF regression when views refactor | Medium | Golden export tests: PDF/DOCX generated for fixture session per role in CI (add in 2.8) |

---

## 6. Definition of Done (project "full")

1. All 5 role views live and export-matched via the shared view matrix.
2. Golden engine tests + CI green; determinism proven.
3. Progression trends live for ≥ 3 sessions; baseline+deltas working.
4. Production deploy on HTTPS with backup/restore drill complete; consent + retention live.
5. SMPL-X spike concluded with a written go/no-go and (if go) pipeline cutover.
6. Capture SOP + staff training done; first real-clinic week completed with ≤ 2 SOP violations.
7. Audit view signs off a real session end-to-end (integrity ledger + OCR verification + reviewer sign-off recorded in `gait_sessions.review_*`).

---

*Traceability: every phase item above maps to either spec §14.2 stages 1–8, spec §14.3 gaps, `j.txt` (SMPL-X), or verified audit findings listed in §1.2 of this document. Nothing in this plan invents a data source the engine does not currently produce.*

---

## 8. Phase 2.5 — Clinical Scales: BBS / TUG / GMFCS / OGA (DELIVERED)

**Scope:** integrated the y.txt offline BBS spec verbatim plus TUG, GMFCS-E&R, and Rancho Los Amigos OGA as stored, engine-scored clinical records, with BBS × gait kinematics cross-validation surfaced in PDF/DOCX reports and a patient-dashboard scales summary. Status: **complete** (backend + admin UI + patient dashboard + report appendix + 23 pytest cases + end-to-end HTTP smoke test verified 2026-11-04).

### Delivered assets
- `python/bbs_engine.py` — `GaitLabBBSModule` (14 items, gait-belt flags, itemized scores, `mobility_band` low/medium/high, population fall cutoffs general/stroke/<49/>45, `crosscheck_bbs_against_gait`; verified PATIENT-8821 mock → 41/56 Low Fall Risk, stroke cutoff 49).
- `python/scales_registry.py` — `scale_payload('bbs'|'tug'|'gmfcs'|'oga')` with `OGA_SYSTEM` (Rancho segments/deviators/phases/sides), `GMFCS_LEVELS`/`GMFCS_AGE_BANDS` (CanChild attribution carried in payload), TUG population cutoffs (Shumway-Cook 13.5 s / Bischoff 12 s / stroke 14 s / le_amputee 19 s / hip OA 10 s / vestibular 11.1 s), 6 stub scales (6MWT/2MWT/10MWT/FAC/Tinetti/DGI/FAP/Iowa-LOA) returning `status: stub`.
- `python/scales_cli.py` — unified stdin-JSON CLI; BBS route path fixed to read stdin with ≤1 args; `list` subcommand verified.
- `python/cp_knee_classifier.py` — Sutherland–Davids walk-frame classifier (jump/crouch/stiff/recurvatum/not_classified), measured-based, zero-assessment `unassessed` when curve/stance boundary missing; 7 synthetic-case unit tests all pass.
- `python/gait_lab.py` Phase D edits: `--age-years/--gender/--context` CLI args; age-banded pediatric stance norms (toddler 42–55 / preschool 50–60 / early-school 53–62 / adult 58–62, Sutherland 1988 + GOS-ICH Alderson 2023 n=624); `cp_knee` block in results; `archetype_context` (age/gender/GMFCS/cp_knee) in results.
- `routes/scales.js` — `POST /:userId/:scaleType` (staff mutator), `GET /patient/:userId`, `GET /patient/:userId/latest/:scaleType`, `PATCH/DELETE /:id` (admin), `GET /engine-status`; `clinical_scales` table (`status CHECK assessed/unassessed/stub/reviewed`, FKs users + gait_sessions).
- `routes/gait.js` — `loadScalesForReport` + `crosscheckBbsGait` (zero-assumption: cross-check assessed only when both sides exist); Functional Assessment appendix added to both PDF and DOCX exports (BBs/TUG/GMFCS/OGA readings + BBS×gait cross-validation table).
- `public/admin-dashboard.html` + `public/js/admin.js` — Scales section (nav item + `#section-scales`), BBS 14-item form with belt flags, TUG/GMFCS/OGA forms, records table, details modal rendering engine payload verbatim.
- `public/dashboard.html` + `public/js/dashboard.js` — patient "Clinical Scales" card showing latest assessed results per scale type in plain language.
- `tests/test_bbs_engine.py`, `tests/test_cp_knee_classifier.py`, `tests/test_scales_registry.py` — 23 pytest cases passing (scoring totals, band boundaries, fall cutoffs, cross-check assessed/unassessed contract, classifier waveforms + boundaries, registry payloads, stub contract).
- `docs/references/SOURCES.md` — citations R1–R18 incl. R11 Sutherland&Davids 1993, R13 Sutherland mature gait, R17 Davids & Bagley 2014 (CP knee patterns), BBS (Berg 1989/1992/1995, stroke <49 Sn 92%), TUG (Shumway-Cook 2000; Bischoff 2003), GMFCS-E&R (Palisano 1997/2007, CanChild), pediatric norms (GOS-ICH/Hof).

### Verified end-to-end (HTTP smoke test, 2026-11-04, cleaned up after)
- POST BBS/TUG/GMFCS/OGA for patient 25 → all 201, `status: assessed`, payloads persisted flat; GET `/api/scales/patient/25` returns all four types.
- POST OGA with empty observations → `status: unassessed` with reason (zero-assumption contract).
- `node --check` clean on `routes/gait.js`, `routes/scales.js`, `public/js/admin.js`, `public/js/dashboard.js`; `python -m py_compile` clean on all edited Python files; `pytest tests -q`: 23 passed.

### Open (deferred to next phase)
- Report PDF/DOCX golden-output export tests per role (spec §14.3 gap).
- SMPL-X angle-correction spike (`j.txt`) — parked.
- WCAG AA contrast audit for "unassessed" states.

