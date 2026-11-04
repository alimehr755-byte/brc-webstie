# SMPL-X fitting spike — plan & decision gate (j.txt)

## What was built
`python/smplx_fit.py` — a CPU/offline SMPL-X body-model fitting module:
- `SmplxFitter` / `fit_frame(keypoints, out_dir, ...)` — fits SMPL-X pose+shape+weak-perspective-camera to 2D keypoints with a reprojection + pose/shape prior loss (LBFGS), outputs corrected 3D joint angles (knee flexion per side) and one `.obj` mesh per frame into `<out_dir>/smplx/`.
- Accepts OpenPose-25 (len 25) or MediaPipe-33 (len 33) keypoints; auto-detects by length. MediaPipe→OpenPose-25 mapping table is in `OPENPOSE_25_TO_MP` (neck derived as shoulder midpoint; foot/toe approximated where MediaPipe lacks a distinct landmark).
- Zero-assumption (spec P1): if SMPL-X model `.npz` files are missing, `smplx` isn't installed, or <6 keypoints are visible → `status: "unassessed"` with a reason. No angles are ever fabricated.

## Model files (not bundled — license-gated)
Download gender-specific SMPL-X models from smpl-x.is.tue.mpg.de (requires license acceptance) and place them under `python/smplx_models/`:
- `SMPLX_NEUTRAL.npz`, `SMPLX_MALE.npz`, `SMPLX_FEMALE.npz`
The module tries several candidate filenames/casings.

## Plug-in point (NOT wired into gait_lab.py)
Per j.txt, existing report logic is unchanged. The hook goes in `python/gait_lab.py` `analyze_sagittal()`, **after** MediaPipe landmarks are extracted into `series` (per-side hip/knee/ankle timeseries) and **before** angle smoothing / gait-cycle computation:

```python
# --- SMPL-X spike hook (OFF by default; see SPIKE_PLAN_SMPLX.md) ---
if USE_SMPLX:
    smplx_out = fit_frame(frame_keypoints_33, artifacts_dir,
                          model_dir="smplx_models", gender=patient_gender,
                          frame_idx=abs_index)
    if smplx_out["status"] == "assessed":
        # smplx_out["angles_deg"]["knee_flexion_L/R"] are the corrected 3D angles
        pass
```

`USE_SMPLX` must default to `False`; flipping it on requires model files present.

## Decision gate (before any cutover)
Compare SMPL-X corrected angles against the existing MediaPipe single-plane angles and, where available, treating-physiotherapist manual goniometry on 5–10 captured sessions:
- Mean absolute difference (SMPL-X vs MP) per joint, per side
- Whether SMPL-X changes any clinical anomaly flag (crouch/stiff-knee/recurvatum per `cp_knee_classifier.py`)
- Runtime per session (CPU) — must be tolerable for a laptop workflow
- Model-file procurement success (license acceptance, download, placement)

If the delta is small and runtime acceptable, cut over behind the `USE_SMPLX` flag; otherwise park the spike (already the current state).

## Status
PARKED — module written and zero-assumption paths verified (compile + missing-model test pass). Not wired into the report pipeline; no report logic changed.