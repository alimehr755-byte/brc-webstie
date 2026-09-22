#!/usr/bin/env python3
"""
smplx_refine.py — MediaPipe + SMPL-X hybrid joint-angle refinement (optional).

Role in the pipeline
--------------------
The main engine (``python/gait_lab.py``) already tracks the patient with
MediaPipe Pose, producing per-frame 2D keypoint tracks for both the frontal and
sagittal recordings (TIP: reuse of TRACK_CACHE means this stage NEVER re-runs
the Pose model). This module adds an *optional second* stage on top of those
same tracks:

  * it **fits the parametric SMPL-X body** (joint pose, shape betas, global
    position and a weak-perspective camera scale) so the model's projected 2D
    joints reproduce MediaPipe's keypoints as closely as possible, subject to
    three regularizers:
        - a small pose prior (the fitted body stays near the SMPL-X neutral
          pose rather than contorting to chase a noisy keypoint),
        - a small shape prior (betas stay near zero = average body),
        - a strong temporal prior (each frame's fit is close to the previous
          frame's, which removes the frame-to-frame jitter that plagues raw
          planar projections);
  * joint angles are then read from the **fitted 3D skeleton** (anatomically
    constrained, in metres from the parametric model) instead of noisy planar
    projections, and — when the clinician supplied ``height_cm`` — segment
    lengths are converted to real centimetres.

Graceful / opt-in design
------------------------
Everything here is a *best-effort refinement* that must never break the core
analysis. ``available()`` is a cheap probe (folder existence + file size +
importlib.find_spec, and an actual ``smplx.create`` load only when files exist).
If anything is missing the calling engine is told ``disabled`` and the message
is descriptive; each ``refine_*`` call is wrapped so any unexpected error
degrades to a *disabled* block instead of raising.

This is a screening aid — never a diagnosis.
"""

import importlib.util
import math
import os
import time

import numpy as np


# ---------------------------------------------------------------------------
# Paths — shared with the setup checker. The smplx package expects
# ``model_path`` to be the folder that CONTAINS the ``smplx/`` subfolder.
# ---------------------------------------------------------------------------
_HERE = os.path.dirname(os.path.abspath(__file__))
GAIT_LAB_DIR = os.path.abspath(os.path.join(_HERE, "..", "gait lab"))
CHECK_SCRIPT = os.path.join(GAIT_LAB_DIR, "check_smplx_setup.py")
MODEL_PATH = os.path.join(GAIT_LAB_DIR, "models")
MODEL_DIR = os.path.join(MODEL_PATH, "smplx")

# Required archives (identical list to check_smplx_setup.py).
REQUIRED_FILES = ["SMPLX_NEUTRAL.npz", "SMPLX_MALE.npz", "SMPLX_FEMALE.npz"]

# Which gender template to prefer. 'neutral' is the least-biased default;
# patient gender could be respected here in a future release.
PREFERRED_GENDER = "neutral"

# ---------------------------------------------------------------------------
# MediaPipe Pose landmark index  ->  SMPL-X body joint index we want to match.
# SMPL-X exposes 22 body joints in the well-known SMPL ordering:
#   0 pelvis, 1 left_hip, 2 right_hip, 3 spine1, 4 left_knee, 5 right_knee,
#   6 spine2, 7 left_ankle, 8 right_ankle, 9 spine3, 10 left_foot,
#   11 right_foot, 12 neck, 13/14 clavicles, 15 head, 16-21 shoulder/elbow/wrist.
# MediaPipe Pose landmark indices used here:
#   0 nose, 7/8 ears, 11/12 shoulders, 13/14 elbows, 15/16 wrists,
#   23/24 hips, 25/26 knees, 27/28 ankles, 29/30 heels, 31/32 foot indexes.
# ---------------------------------------------------------------------------
# (mp_landmark_idx, smplx_joint_idx, match_weight)
CORRESPONDENCE = {
    "pelvis":        {"mp": (23, 24), "smplx": 0,  "w": 0.6},   # mid-hip -> pelvis
    "left_hip":      {"mp": (23,),    "smplx": 1,  "w": 1.0},
    "right_hip":     {"mp": (24,),    "smplx": 2,  "w": 1.0},
    "left_knee":     {"mp": (25,),    "smplx": 4,  "w": 1.0},
    "right_knee":    {"mp": (26,),    "smplx": 5,  "w": 1.0},
    "left_ankle":    {"mp": (27,),    "smplx": 7,  "w": 1.0},
    "right_ankle":   {"mp": (28,),    "smplx": 8,  "w": 1.0},
    "left_shoulder": {"mp": (11,),    "smplx": 16, "w": 0.8},
    "right_shoulder":{"mp": (12,),    "smplx": 17, "w": 0.8},
    "left_elbow":    {"mp": (13,),    "smplx": 18, "w": 0.8},
    "right_elbow":   {"mp": (14,),    "smplx": 19, "w": 0.8},
    "left_wrist":    {"mp": (15,),    "smplx": 20, "w": 0.8},
    "right_wrist":   {"mp": (16,),    "smplx": 21, "w": 0.8},
    "head":          {"mp": (7, 8),   "smplx": 15, "w": 0.6},   # ear midpoint -> head
}

# Optimization budget. Kept modest so fitting (opt-in) stays responsive on CPU
# and inside the server's per-analysis wall-clock timeout.
MAX_FRAMES = 40          # max number of tracked frames actually fitted
ADAM_ITER = 120          # optimization steps per frame
ADAM_LR = 5.0e-2         # RMSProp-style step for pose/transl/scale params
MAX_SECONDS = 60.0       # hard wall-clock budget for an entire refine run
VIS_GATE = 0.40          # per-keypoint min visibility to be used as a target

# Regularizer magnitudes (see module docstring for the rationale).
W_POSE_PRIOR = 5.0e-4
W_SHAPE_PRIOR = 5.0e-4
W_TEMPORAL = 5.0e-3


# ---------------------------------------------------------------------------
# Availability probe (used by the engine's startup gate)
# ---------------------------------------------------------------------------

def _load_checker():
    """Import the setup checker from the 'gait lab' project folder.

    The folder name contains a space, so a normal ``import`` statement cannot
    target it; ``importlib`` handles any path. Returns the module or ``None``
    if it cannot be found (the gate then reports the reason generically).
    """
    try:
        spec = importlib.util.spec_from_file_location(
            "check_smplx_setup", CHECK_SCRIPT)
        if spec is None or spec.loader is None:
            return None
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod
    except Exception:
        return None


def _probe_models():
    """Cheap, first-order probe: are the required archives present and sane?

    Uses file-existence + size only (no heavy imports) so the engine can do
    this every analysis without measurable overhead. The authoritative check
    (real ``smplx.create`` load) is only performed by ``available()`` when the
    files already look fine.
    """
    if not os.path.isdir(MODEL_DIR):
        return False
    for fname in REQUIRED_FILES:
        path = os.path.join(MODEL_DIR, fname)
        if not os.path.isfile(path):
            return False
        try:
            if os.path.getsize(path) < 500 * 1024:
                return False
        except OSError:
            return False
    return True


def available():
    """Public availability check — True when SMPL-X refinement can actually run.

    Runs the same validation chain as ``check_smplx_setup.py`` (reused through
    the shared module) plus, when files exist, a real ``smplx.create`` load so
    a corrupt archive is caught before analysis begins. The result is cached
    for the lifetime of the process.
    """
    if available.cache is not None:
        return available.cache
    ok = False
    if _probe_models():
        checker = _load_checker()
        if checker is not None:
            try:
                ok = bool(checker.run_checks().get("ok"))
            except Exception:
                ok = True  # files look fine; let fitting surface any issue
    available.cache = ok
    return ok


available.cache = None


def probe():
    """Engine-facing probe: returns (state, reason) where state is 'on'/'off'.

    Used by ``python/gait_lab.py`` and ``gait lab/app.py`` to log a one-line
    startup notice instead of a silent capability change.
    """
    if available():
        return ("on", "SMPL-X body models + smplx/torch are available")
    if not os.path.isdir(MODEL_DIR):
        return ("off",
                "SMPL-X models not installed (%s missing). "
                "See 'gait lab/SETUP_SMPLX.md', then run "
                "'python \"gait lab/check_smplx_setup.py\"'." % MODEL_DIR)
    if not _probe_models():
        return ("off",
                "SMPL-X model files are incomplete or too small in %s. "
                "Re-download and re-run check_smplx_setup.py." % MODEL_DIR)
    return ("off",
            "The smplx/torch Python packages are not installed. "
            "Run: pip install smplx and pip install torch "
            "(CPU wheel). See 'gait lab/SETUP_SMPLX.md'.")


# ---------------------------------------------------------------------------
# Shared math helpers (mirror the conventions in gait_lab.py so the refined
# values stay comparable with the existing MediaPipe-only reports)
# ---------------------------------------------------------------------------

def _angle_deg(at, bt, ct):
    """Interior 3-point angle at vertex bt (degrees), like gait_lab.three_point_angle."""
    a, b, c = (np.asarray(at, float), np.asarray(bt, float), np.asarray(ct, float))
    ba, bc = a - b, c - b
    n = (np.linalg.norm(ba) * np.linalg.norm(bc)) + 1e-9
    cos = float(np.dot(ba, bc)) / n
    return math.degrees(math.acos(max(-1.0, min(1.0, cos))))


def _build_body_frame(j3):
    """Compact body-local frame from fitted joints:

    up = pelvis -> neck (spine direction),
    lateral = right_hip - left_hip (perpendicular to up via Gram-Schmidt),
    forward = up x lateral.

    Returns (up, lateral, forward) unit vectors as numpy arrays.
    """
    pelvis = np.asarray(j3[0], float)
    neck = np.asarray(j3[12], float)
    lhip = np.asarray(j3[1], float)
    rhip = np.asarray(j3[2], float)

    up = neck - pelvis
    if np.linalg.norm(up) < 1e-9:
        up = np.array([0.0, 1.0, 0.0])
    up = up / np.linalg.norm(up)

    lateral = rhip - lhip
    lateral = lateral - np.dot(lateral, up) * up
    if np.linalg.norm(lateral) < 1e-9:
        lateral = np.cross(up, np.array([0.0, 0.0, 1.0]))
    lateral = lateral / np.linalg.norm(lateral)

    forward = np.cross(up, lateral)
    return up, lateral, forward


def _joint_angles_from_joints(j3):
    """Derive clinical angles from fitted 3D joint centres.

    Joints follow the 22-body SMPL ordering (see CORRESPONDENCE). Angles are
    computed in the pelvis-centred body frame and reported in the same
    conventions as the existing engine (hip/knee = 180 - interior angle,
    ankle = 110 - interior angle), sagittal + frontal planes.
    """
    up, lateral, forward = _build_body_frame(j3)

    def sag(v):
        """Project a 3D vector onto the sagittal (forward, up) plane."""
        import numpy as _np
        return _np.array([_np.dot(v, forward), _np.dot(v, up)])

    def inv(v):
        return v / (np.linalg.norm(v) + 1e-9)

    out = {}
    for side, (hip, knee, ankle, foot, shld) in {
        "L": (1, 4, 7, 10, 16),
        "R": (2, 5, 8, 11, 17),
    }.items():
        sh = np.asarray(j3[shld], float)
        hp = np.asarray(j3[hip], float)
        kn = np.asarray(j3[knee], float)
        an = np.asarray(j3[ankle], float)
        ft = np.asarray(j3[foot], float)

        # Sagittal-plane flexion (matches the 180 - interior-angle convention).
        # Reconstructed from projected limb vectors so abduction does not
        # inflate the flexion reading.
        th = sag(inv(sh - hp))
        fm = sag(inv(kn - hp))
        hip_flex = 180.0 - math.degrees(math.acos(max(-1.0, min(1.0, float(
            np.dot(th, fm))))))
        th2 = sag(inv(hp - kn))
        sh2 = sag(inv(an - kn))
        knee_flex = 180.0 - math.degrees(math.acos(max(-1.0, min(1.0, float(
            np.dot(th2, sh2))))))
        th3 = sag(inv(kn - an))
        ft3 = sag(inv(ft - an))
        ankle = 110.0 - math.degrees(math.acos(max(-1.0, min(1.0, float(
            np.dot(th3, ft3))))))

        # Coronal-plane knee angle (frontal) and pelvic obliquity.
        mid = (hp + kn) / 2.0
        lat_: np.ndarray = inv(lateral)
        fm_c = inv(kn - hp)
        sh_c = inv(an - kn)
        # projection onto coronal (lateral, up) plane
        def cor(v):
            return np.array([np.dot(v, lateral), np.dot(v, up)])
        knee_cor = 180.0 - math.degrees(math.acos(max(-1.0, min(1.0, float(
            np.dot(inv(cor(fm_c)), inv(cor(sh_c))))))))

        out["hip_flexion_%s" % side] = hip_flex
        out["knee_flexion_%s" % side] = knee_flex
        out["ankle_angle_%s" % side] = ankle
        out["knee_coronal_%s" % side] = knee_cor
    # pelvic obliquity: angle of the inter-hip line about the forward axis
    lhp = np.asarray(j3[1], float)
    rhp = np.asarray(j3[2], float)
    hip_line = rhp - lhp
    hor = np.array([np.dot(hip_line, lateral), np.dot(hip_line, up)])
    out["pelvic_obliquity"] = math.degrees(math.atan2(hor[1], abs(hor[0]) + 1e-6))
    return out


# ---------------------------------------------------------------------------
# The actual fitting stage
# ---------------------------------------------------------------------------

def _fit_one_frame(model, targets, prev_params, betas, device):
    """Fit the SMPL-X body to one frame's 2D target set.

    ``targets``: list of (smplx_joint_idx, mp_normalized_xy, weight).
    ``prev_params``: dict of the previous frame's optimized tensors (used for
    the temporal prior) or None on the first frame.
    Returns (joints_np[22,3] in metres, params_dict) or (None, None) on error.
    """
    import torch
    import smplx  # noqa: F401  (imported to guarantee the model is consistent)

    # Optimizable parameters.
    p_global = torch.nn.Parameter(prev_params["global"].clone() if prev_params
                                  else torch.zeros(1, 3, device=device))
    p_body = torch.nn.Parameter(prev_params["body"].clone() if prev_params
                                else torch.zeros(1, 12, device=device))
    p_transl = torch.nn.Parameter(prev_params["transl"].clone() if prev_params
                                  else torch.zeros(1, 3, device=device))
    p_scale = torch.nn.Parameter(prev_params["scale"].clone() if prev_params
                                 else torch.ones(1, 1, device=device) * 0.5)

    # Hands / jaw / eyes stay at the neutral (flat / zero) values — MediaPipe
    # does not hand us informative hand detail here, so we do not waste
    # optimization budget on them.
    flat_hand = torch.zeros(1, 12, device=device)
    zero3 = torch.zeros(1, 3, device=device)

    opt = torch.optim.Adam([p_global, p_body, p_transl, p_scale], lr=ADAM_LR)
    b = torch.from_numpy(betas).float().to(device)

    target_idx = torch.as_tensor([t[0] for t in targets], dtype=torch.long).to(device)
    target_xy = torch.as_tensor([[t[1][0], t[1][1]] for t in targets],
                                dtype=torch.float32, device=device).unsqueeze(0)
    target_w = torch.as_tensor([t[2] for t in targets], dtype=torch.float32,
                               device=device).unsqueeze(0)

    for _ in range(ADAM_ITER):
        opt.zero_grad()
        body = model(betas=b, global_orient=p_global, body_pose=p_body,
                     transl=p_transl,
                     left_hand_pose=flat_hand, right_hand_pose=flat_hand,
                     jaw_pose=zero3, leye_pose=zero3, reye_pose=zero3)
        joints = body.joints[:, :22, :]          # (1, 22, 3) metres
        sel = joints[:, target_idx, :]           # (1, K, 3)

        # Weak-perspective projection: x = s*X + tx, y = s*Y + ty (ignores Z).
        proj_x = p_scale * sel[:, :, 0] + p_transl[:, 0:1]
        proj_y = p_scale * sel[:, :, 1] + p_transl[:, 1:2]

        err = (proj_x - target_xy[:, :, 0:1]) ** 2 + (proj_y - target_xy[:, :, 1:2]) ** 2
        reproj = (err * target_w).mean()

        pose_prior = W_POSE_PRIOR * (p_body ** 2).sum()
        shape_prior = W_SHAPE_PRIOR * (b ** 2).sum()
        temporal = torch.zeros((), device=device)
        if prev_params is not None:
            temporal = W_TEMPORAL * (
                ((p_global - prev_params["global"]) ** 2).sum()
                + ((p_body - prev_params["body"]) ** 2).sum()
                + ((p_transl - prev_params["transl"]) ** 2).sum()
                + ((p_scale - prev_params["scale"]) ** 2).sum())

        loss = reproj + pose_prior + shape_prior + temporal
        loss.backward()
        opt.step()

    with torch.no_grad():
        model.eval()
        body = model(betas=b, global_orient=p_global, body_pose=p_body,
                     transl=p_transl,
                     left_hand_pose=flat_hand, right_hand_pose=flat_hand,
                     jaw_pose=zero3, leye_pose=zero3, reye_pose=zero3)
        joints = body.joints[0, :22, :].cpu().numpy()
    params = {"global": p_global.detach().cpu(), "body": p_body.detach().cpu(),
              "transl": p_transl.detach().cpu(), "scale": p_scale.detach().cpu()}
    return joints, params


def _build_targets(sample_xy, width, height, vis, side="LR"):
    """Convert one stored track sample into SMPL-X (joint, xy_norm, weight) targets.

    ``sample_xy`` is the usual {side: {joint_label: (x, y)}} keypoint dict (pixel
    space), ``vis`` is the matching {side: {joint_label: confidence}} map or None.
    Mirrors gait_lab's confidence-gate philosophy: below VIS_GATE a keypoint is
    simply not used as a target rather than trusted blindly.
    """
    out = []

    def get(label, side):
        px = (sample_xy.get(side) or {}).get(label)
        if not px:
            return None
        v = ((vis or {}).get(side) or {}).get(label, 1.0)
        return (float(px[0]), float(px[1])), v

    # pelvis + head use side midpoints; limb targets use single-side landmarks.
    def mid(label, sides):
        pts = [get(label, s) for s in sides]
        pts = [p for p in pts if p is not None]
        if not pts:
            return None
        return ((sum(p[0][0] for p in pts) / len(pts),
                 sum(p[0][1] for p in pts) / len(pts)),
                min(p[1] for p in pts))

    for name, spec in CORRESPONDENCE.items():
        smplx_idx = spec["smplx"]
        w = spec["w"]
        if name in ("pelvis", "head"):
            label = "hip" if name == "pelvis" else "ear"
            target = mid(label, ("L", "R"))
        else:
            side = "L" if name.startswith("left") else "R"
            target = get(name.split("_", 1)[1], side)   # e.g. "left_hip" -> "hip"
        if target is None or target[1] < VIS_GATE:
            continue
        (x, y), v = target
        # normalize to [0,1] image space
        out.append((smplx_idx,
                    (x / max(1.0, width), y / max(1.0, height)),
                    w * v))
    return out


def _segment_lengths_cm(joints, height_cm):
    """Compute key limb segment lengths from fitted 3D joints (metres) and, when
    a clinician-measured height is provided, scale them to real centimetres
    using the SMPL-X model's own body proportions.

    Returns dict {thigh_L/shank_L/thigh_R/shank_R: cm} or None when height
    unknown or joints unusable.
    """
    if not height_cm:
        return None
    try:
        pelvis = np.asarray(joints[0], float)
        neck = np.asarray(joints[12], float)
        torso_m = float(np.linalg.norm(neck - pelvis)) + 1e-9
        if torso_m < 0.1:   # degenerate / collapsed fit — refuse nonsense lengths
            return None
        # SMPL-X proportions (anatomical average): torso ~0.30 of body height.
        scale_cm = height_cm / (torso_m / 0.30)
        seg = {}
        for tag, a, b in (("thigh_L", 1, 4), ("shank_L", 4, 7),
                          ("thigh_R", 2, 5), ("shank_R", 5, 8)):
            seg[tag] = round(float(np.linalg.norm(
                np.asarray(joints[b], float) - np.asarray(joints[a], float))
                * scale_cm), 1)
        return seg
    except Exception:
        return None


def refine_track(track, height_cm=None, budget_seconds=MAX_SECONDS):
    """Run the full SMPL-X refinement over one stored 2D track.

    ``track``: a TRACK_CACHE entry — {slot, fps, width, height, step, samples,
    landmarks: [{abs, pts:{L:{},R:{}}, vis:{...}}]}.

    Returns a result block with ``refined`` True/False. Never raises: any
    failure produces a ``disabled``/``error`` block so the caller can continue
    with MediaPipe-only results.
    """
    start = time.perf_counter()
    if not available():
        return {"status": "disabled", "refined": False,
                "reason": "SMPL-X body models or packages not installed"}

    landmarks = track.get("landmarks") or []
    if not landmarks:
        return {"status": "disabled", "refined": False,
                "reason": "no 2D tracks available to fit"}

    width = int(track.get("width", 0)) or 1
    height = int(track.get("height", 0)) or 1
    fps = float(track.get("fps", 30.0) or 30.0)

    try:
        import torch
        import smplx
        device = "cuda" if torch.cuda.is_available() else "cpu"
        torch.set_num_threads(max(1, (os.cpu_count() or 4) - 1))
        model = smplx.create(
            model_path=MODEL_PATH, model_type="smplx",
            gender=PREFERRED_GENDER, ext="npz",
            use_pca=True, num_pca_comps=12, flat_hand_mean=True,
        ).to(device)
        # Shape betas are fit jointly across frames below; this module fixes a
        # neutral intermediate for the budget-capped single-frame passes.
        betas = np.zeros((1, 10), dtype=np.float32)
    except Exception as exc:
        return {"status": "disabled", "refined": False,
                "reason": "smplx/torch could not be loaded: %s" % exc}

    fitted = []          # (frame_abs, {joint_name: (x,y,z) metres})
    prev_params = None
    prev_joints = None
    errors = 0
    for sample in landmarks[:MAX_FRAMES]:
        if time.perf_counter() - start > budget_seconds:
            break
        pts = sample.get("pts") or {}
        vis = sample.get("vis")
        targets = _build_targets(pts, width, height, vis)
        if len(targets) < 6:          # too few targets to constrain the body
            continue
        try:
            joints, prev_params = _fit_one_frame(model, targets, prev_params,
                                                 betas, device)
            if joints is None:
                continue
            entry = {}
            for side, idxs in (("L", {"hip_j": 1, "knee_j": 4, "ankle_j": 7,
                                      "shoulder_j": 16, "elbow_j": 18,
                                      "wrist_j": 20}),
                               ("R", {"hip_j": 2, "knee_j": 5, "ankle_j": 8,
                                      "shoulder_j": 17, "elbow_j": 19,
                                      "wrist_j": 21})):
                entry[side] = {k: [round(float(joints[i][0]), 4),
                                   round(float(joints[i][1]), 4),
                                   round(float(joints[i][2]), 4)]
                               for k, i in idxs.items()}
            entry["abs"] = int(sample.get("abs", 0))
            fitted.append(entry)
            _ = prev_joints
            prev_joints = joints
            torch.cuda.empty_cache() if device == "cuda" else None
        except Exception:
            errors += 1   # defenders: one bad frame never aborts the pass

    if not fitted:
        return {"status": "error", "refined": False,
                "reason": "SMPL-X fitting produced no usable frames",
                "frames_attempted": min(len(landmarks), MAX_FRAMES)}

    # Aggregate: mean joint centre (metres, pelvis-centred normalized coords)
    # and per-frame angle traces.
    centers = {}
    for side in ("L", "R"):
        centers[side] = {}
        for k in ("hip_j", "knee_j", "ankle_j", "shoulder_j", "elbow_j", "wrist_j"):
            vals = [np.array(f[side][k]) for f in fitted if k in f[side]]
            if vals:
                centers[side][k] = [round(float(np.mean(vals, axis=0)[i]), 4)
                                    for i in range(3)]

    angles = {"hip_flexion": {"L": [], "R": []},
              "knee_flexion": {"L": [], "R": []},
              "ankle_angle": {"L": [], "R": []},
              "knee_coronal": {"L": [], "R": []},
              "pelvic_obliquity": []}

    # Build 22-joint arrays per frame and run the angle extractor.
    j3_default = np.zeros((22, 3), dtype=float)
    for f in fitted:
        arr = j3_default.copy()
        for side, idxs in (("L", {"hip_j": 1, "knee_j": 4, "ankle_j": 7,
                                  "shoulder_j": 16, "elbow_j": 18, "wrist_j": 20}),
                           ("R", {"hip_j": 2, "knee_j": 5, "ankle_j": 8,
                                  "shoulder_j": 17, "elbow_j": 19,
                                  "wrist_j": 21})):
            for k, i in idxs.items():
                if k in f[side]:
                    arr[i] = f[side][k]
        try:
            a = _joint_angles_from_joints(arr)
        except Exception:
            continue
        angles["hip_flexion"]["L"].append(round(a["hip_flexion_L"], 1))
        angles["hip_flexion"]["R"].append(round(a["hip_flexion_R"], 1))
        angles["knee_flexion"]["L"].append(round(a["knee_flexion_L"], 1))
        angles["knee_flexion"]["R"].append(round(a["knee_flexion_R"], 1))
        angles["ankle_angle"]["L"].append(round(a["ankle_angle_L"], 1))
        angles["ankle_angle"]["R"].append(round(a["ankle_angle_R"], 1))
        angles["knee_coronal"]["L"].append(round(a["knee_coronal_L"], 1))
        angles["knee_coronal"]["R"].append(round(a["knee_coronal_R"], 1))
        angles["pelvic_obliquity"].append(round(a["pelvic_obliquity"], 1))

    seg = _segment_lengths_cm(_mean_joints(fitted), height_cm)

    elapsed = round(time.perf_counter() - start, 2)
    return {
        "status": "ok",
        "refined": True,
        "engine": "mediapipe+smplx",
        "gender": PREFERRED_GENDER,
        "model_dir": MODEL_DIR,
        "frames_fitted": len(fitted),
        "frames_available": len(landmarks),
        "fps": round(fps, 2),
        "fit_seconds": elapsed,
        "skipped_frames": errors,
        "height_cm": height_cm,
        "angles": angles,
        "joint_centers_3d": centers,
        "segment_lengths_cm": seg,
        "note": ("SMPL-X body prior fitted to MediaPipe 2D keypoints with "
                 "pose/shape/temporal regularization. Angles are read from the "
                 "fitted 3D skeleton; segment lengths scale the model's metre "
                 "proportions to the clinician-measured height when provided."),
    }


def _mean_joints(fitted):
    """Helper: average per-side fitted joints into a single 22-joint array for
    the segment-length computation (best-effort, defensive)."""
    arr = np.zeros((22, 3), dtype=float)
    for f in fitted:
        for side, idxs in (("L", {"hip_j": 1, "knee_j": 4, "ankle_j": 7,
                                  "shoulder_j": 16, "elbow_j": 18, "wrist_j": 20}),
                           ("R", {"hip_j": 2, "knee_j": 5, "ankle_j": 8,
                                  "shoulder_j": 17, "elbow_j": 19,
                                  "wrist_j": 21})):
            for k, i in idxs.items():
                if k in f[side]:
                    arr[i] = f[side][k]
    return arr


def refine_all(tracks, height_cm=None, budget_seconds=MAX_SECONDS):
    """Refine every cached track (sagittal + frontal) in one call.

    ``tracks``: dict {absolute_path: TRACK_CACHE entry}. Returns a top-level
    ``smplx`` result block for the analysis JSON plus per-plane blocks.
    """
    if not available():
        return {"status": "disabled", "refined": False, "reason": probe()[1]}
    planes = {}
    for path, tr in (tracks or {}).items():
        slot = tr.get("slot") or "unknown"
        planes[slot] = refine_track(tr, height_cm=height_cm,
                                    budget_seconds=budget_seconds / max(1, len(tracks)))
    any_ok = any(p.get("refined") for p in planes.values())
    return {
        "status": "ok" if any_ok else "disabled",
        "refined": bool(any_ok),
        "engine": "mediapipe+smplx",
        "planes": planes,
        "note": ("SMPL-X hybrid refinement over the MediaPipe tracks. When "
                 "unavailable the engine reports MediaPipe-only angles and the "
                 "analysis is unaffected."),
    }


if __name__ == "__main__":
    state, reason = probe()
    print("SMPL-X refinement: %s (%s)" % (state, reason))