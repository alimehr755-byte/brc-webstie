# SMPL-X Model Setup — BRC Gait Lab

This document explains how to obtain and install the **SMPL-X** body model files
needed by the optional hybrid refinement stage of the Gait Lab analysis engine.

> **What this enables.** The main engine already tracks the patient with
> **MediaPipe Pose** (2D keypoints). When the SMPL-X body model files are
> installed, a second stage (`python/smplx_refine.py`) fits the parametric
> SMPL-X body to those keypoint tracks frame-by-frame. Joint angles are then
> read from the anatomically-regularized fitted skeleton (not from raw planar
> projections) and segment lengths can be converted to real centimetres using
> the clinician-measured `height-cm`. This improves accuracy/precision of the
> reported kinematics.
>
> **This is strictly optional and graceful.** If the files are absent (or the
> `smplx`/`torch` Python packages are missing), the engine logs a clear notice
> and continues with the current MediaPipe-only analysis. Nothing breaks.

---

## 1. Why you must download the models manually

The SMPL-X body models are distributed by the **official SMPL-X project website**
under a **non-commercial research license**. Registration, reading, and
accepting those license terms is required — the files **cannot be
auto-downloaded by a script**, and no direct download URL is hardcoded anywhere
in this project.

---

## 2. Register an account and accept the license

1. Go to the **official SMPL-X project website** (the smpl-x repository /
   project page maintained by the Max Planck Institute for Intelligent Systems /
   Perceiving Systems group).
2. Click through to the **registration / download** page.
3. Create a free account (you generally only need a university / institute
   e-mail, depending on the current registration workflow).
4. Open the **model download / license** agreement linked on the page and read
   it carefully.
5. Tick the acceptance box for the **SMPL-X model (non-commercial research
   license)** and submit. The site then issues the model downloads for your
   registered account.

> Note for SMPL-X specifically: make sure you request/download **SMPL-X**
> (the full **body + face + hands** model). This is **not** SMPL and **not**
> SMPL+H — SMPL-X is the higher-resolution, fully parametric variant that the
> `smplx` Python package loads with `model_type='smplx'`.

---

## 3. Download the correct model files

On the downloads section, download the **SMPL-X model pack**. You will receive —
inside a `.zip` (the exact zip name can vary by release) — the following
`.npz` files, which are the ones this project uses:

| File                | Purpose                                                      | Expected size |
|---------------------|--------------------------------------------------------------|---------------|
| `SMPLX_NEUTRAL.npz` | Gender-neutral template (used for neutral fitting)           | several MB    |
| `SMPLX_MALE.npz`    | Male template                                                | several MB    |
| `SMPLX_FEMALE.npz`  | Female template                                              | several MB    |

Extract the `.zip` so you can see these `.npz` files.

---

## 4. Place the files in the expected folder layout

The `smplx` Python package expects `model_path` to point at a folder that
**contains** a `smplx/` subfolder with the `.npz` files inside. The Gait Lab
check script and engine use:

    gait lab/models/            <- model_path (parent)
    gait lab/models/smplx/      <- must contain:
        SMPLX_NEUTRAL.npz
        SMPLX_MALE.npz
        SMPLX_FEMALE.npz

So: copy the three extracted `.npz` files into
**`gait lab/models/smplx/`** (the folder already exists — it is kept in git via
a `.gitkeep`, and the `.npz` files are git-ignored so they can never be pushed).

Verify the final layout with:

    powershell:
      Get-ChildItem "gait lab\models\smplx"
    or bash:
      ls -la "gait lab/models/smplx"

---

## 5. Install the Python dependencies

SMPL-X fitting requires PyTorch (for autograd optimization during fitting) and
the `smplx` package. Install them **once** into the same Python environment the
server's gait engine uses:

    # CPU build of PyTorch (smallest; enough for the per-frame fitting):
    pip install torch --index-url https://download.pytorch.org/whl/cpu
    pip install smplx

> The project also ships a declared manifest at `python/requirements.txt` that
> includes the whole analysis stack — you can install everything from it:
>
>     pip install -r python/requirements.txt
>
> If you already have the rest of the stack installed, the two commands above
> are the only additions needed.

---

## 6. Verify the setup

Run the setup checker from anywhere:

    python "gait lab/check_smplx_setup.py"

It prints one labelled check at a time (✅/❌), tries to **actually load** the
model with `smplx.create(...)`, and ends with a summary. If anything is wrong
it prints a numbered list of exactly what to fix. It exits with a **non-zero
status code** when a check fails, so it can be used as a startup gate.

Expected healthy output ends with something like:

    ✔ All checks passed — SMPL-X hybrid refinement is ready to run.

---

## 7. How the engine picks it up

- At the start of a gait analysis, `python/gait_lab.py` probes availability
  automatically (reusing the same checks). If everything is in place it logs
  `SMPL-X refinement ON`; otherwise it logs `SMPL-X refinement disabled ...`
  and proceeds with MediaPipe-only analysis.
- When enabled, the analysis JSON gains a top-level `smplx` block containing
  the fitted-joint block, 3D joint angles and (when `height-cm` is supplied)
  segment lengths in cm.
- You can re-run the checker at any time; no server restart is required for the
  check itself, only for the analysis to pick up newly installed models.

---

## 8. License reminder

SMPL-X is distributed under a **non-commercial research license**. Use it in
this screening-tool context for research/evaluation only; production,
commercial, or clinical-certification use requires the appropriate license
from the model's owners. The Gait Lab system is a screening aid — never a
diagnosis.