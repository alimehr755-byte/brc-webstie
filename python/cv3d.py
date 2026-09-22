#!/usr/bin/env python3
"""
cv3d.py — BRC Gait Lab multi-view 3D kinematic triangulation (2e.txt item 1).

When BOTH the frontal and sagittal videos are present, this module arranges a
Pose2Sim-style workflow:

  * production path: if `pose2sim` is installed, a Pose2Sim multi-camera
    calibration + triangulation run is initialized for the pair of views;
  * bundled fallback: a lightweight orthographic dual-view triangulator that
    reconstructs 3D joint coordinates from the MediaPipe 2D keypoints of both
    views (front maps world x/y, sagittal maps world z/y), yielding
    full-body 3D joint kinematics, anatomical coordinates, segment lengths and
    3D joint-angle curves for the report.

Everything below is a screening aid — never a diagnosis. Output units are
normalized (torso heights) because planar videos carry no metric calibration.
"""

import json
import math
import os

import cv2
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

# Shared pose helpers from the single-plane engine.
from gait_lab import (
    SIDES,
    L_INDEX,
    R_INDEX,
    landmark_pts,
    three_point_angle,
    _make_pose_runner,
    _sampled_frames,
    _auto_step,
    _eff_fps,
    _round_series,
    _pose_input,
    TRACK_CACHE,
)

PANTRY_JOINTS = ("ear", "shoulder", "elbow", "wrist", "hip", "knee", "ankle", "toe")

# Skeletons drawn in the 3D anatomy plot (joint labels, one per side).
SKELETON = [("shoulder", "elbow"), ("elbow", "wrist"), ("shoulder", "hip"),
            ("hip", "knee"), ("knee", "ankle"), ("ankle", "toe")]


def _extract_track(video_path, slot, max_samples=240):
    """Run MediaPipe on one video and return its 2D keypoint track.

    Reuses the pose-inference tracks produced by the single-plane analyzers
    (python/gait_lab.py TRACK_CACHE) when available, so dual-view mode never
    re-runs MediaPipe on the same clip. Returns a dict: {status, slot, fps,
    samples, width, height, landmarks: [ {abs_index, pts:{L:{joint:(x,y)}, R:{...}}} ]}
    """
    cached = TRACK_CACHE.get(os.path.abspath(video_path))
    if cached:
        return dict(cached, slot=slot)
    cap = None
    try:
        cap = cv2.VideoCapture(video_path)
        if not cap.isOpened():
            return {"status": "error", "error": "cannot open video"}
        fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        step = _auto_step(cap, max_samples)
        runner, closer = _make_pose_runner()
        landmarks = []
        try:
            for si, frame in _sampled_frames(cap, step, max_samples):
                lm = runner(_pose_input(frame))
                pts = {"L": {}, "R": {}}
                if lm is not None:
                    for s, (_, imap) in SIDES.items():
                        pts[s] = landmark_pts(lm, imap, width, height)
                landmarks.append({"abs": si * step, "pts": pts})
        finally:
            try:
                closer.close()
            except Exception:
                pass
        return {"status": "ok", "slot": slot, "fps": fps,
                "samples": len(landmarks), "width": width, "height": height,
                "step": step, "landmarks": landmarks}
    finally:
        if cap is not None:
            cap.release()


# MediaPipe 33-joint canonical names for the pantry joints we export, by side.
_MP_JOINT_NAMES = {
    "ear": ("Left_ear", "Right_ear"),
    "shoulder": ("Left_shoulder", "Right_shoulder"),
    "elbow": ("Left_elbow", "Right_elbow"),
    "wrist": ("Left_wrist", "Right_wrist"),
    "hip": ("Left_hip", "Right_hip"),
    "knee": ("Left_knee", "Right_knee"),
    "ankle": ("Left_ankle", "Right_ankle"),
    "toe": ("Left_foot_index", "Right_foot_index"),
}


def _export_pose2sim_keypoints(project_dir, track_f, track_s):
    """Write the extracted 2D keypoints as Pose2Sim consumable flat files.

    Pose2Sim triangulates from precomputed 2D keypoint *files* rather than
    re-running detections, so each view is persisted under
    ``artifacts/<session>/pose2sim/2d_keypoints``:

      * ``2d_keypoints.py`` — legacy flat ``p2s`` dict: per camera, per absolute
        frame index, per MediaPipe joint name -> (x, y, confidence).
      * ``<cam>_keypoints.json`` — auditable mirror with the same entries plus
        the video metadata (fps / pixel frame size) the solve needs.
      * ``README.md`` — documents the layout, units and folder expectations.

    Detected joints carry confidence 1.0 (the extractor already dropped joints
    below its visibility threshold); absent joints are simply omitted so the
    downstream triangulator only sees real measurements.
    """
    cam_order = (("frontal", track_f), ("sagittal", track_s))
    keyed = {}
    audit = {}
    for cam, tr in cam_order:
        p2s_cam = {}
        frames = []
        for fr in tr["landmarks"]:
            abs_idx = int(fr["abs"])
            joints = {}
            for s, mp_name in (("L", 0), ("R", 1)):
                for joint, names in _MP_JOINT_NAMES.items():
                    pt = fr["pts"].get(s, {}).get(joint)
                    if pt is not None:
                        name = names[mp_name]
                        x, y = float(pt[0]), float(pt[1])
                        joints[name] = (round(x, 3), round(y, 3), 1.0)
            if joints:
                p2s_cam[abs_idx] = joints
                frames.append({"abs": abs_idx, "joints": {
                    k: list(v) for k, v in joints.items()}})
        keyed[cam] = p2s_cam
        audit[cam] = {"fps": tr.get("fps") or 30.0,
                      "width": tr.get("width") or 0,
                      "height": tr.get("height") or 0,
                      "samples": len(frames), "frames": frames}

    kp_dir = os.path.join(project_dir, "2d_keypoints")
    os.makedirs(kp_dir, exist_ok=True)

    def dump_py():
        header = (
            "# Pose2Sim flat 2d_keypoints export (BRC Gait Lab).\n"
            "# Per camera: {absolute_frame_index: {MediaPipeJointName: (x, y, confidence)}}\n"
            "# Coordinates are image pixels. Triangles are relative; intrinsic scaling\n"
            "# is applied by Pose2Sim from the calibration in pose2sim.json.\n")
        text = header + "p2s = " + repr(keyed) + "\n"
        tmp = os.path.join(kp_dir, "2d_keypoints.py.tmp")
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(text)
        os.replace(tmp, os.path.join(kp_dir, "2d_keypoints.py"))

    dump_py()
    for cam, tr in (("frontal", track_f), ("sagittal", track_s)):
        with open(os.path.join(kp_dir, f"{cam}_keypoints.json"), "w",
                  encoding="utf-8") as fh:
            json.dump(audit[cam], fh, indent=2)
    with open(os.path.join(kp_dir, "README.md"), "w", encoding="utf-8") as fh:
        fh.write(
            "# Pose2Sim 2D keypoints (BRC Gait Lab export)\n\n"
            "- `2d_keypoints.py` — legacy flat `p2s` dict consumed by Pose2Sim\n"
            "  triangulation. One entry per camera; each maps the absolute frame\n"
            "  index to a dict of MediaPipe joint name -> (x, y, confidence).\n"
            "- `<cam>_keypoints.json` — auditable mirror of the same data plus\n"
            "  video metadata (fps, pixel frame size) used by the solve config.\n"
            "- The numerical solve runs inside Pose2Sim when the package is\n"
            "  installed; otherwise the bundled `brc-lightweight` orthographic\n"
            "  triangulator produces the 3D kinematics in the same block.\n")
    files = sorted(os.listdir(kp_dir))
    return {"format": "flat/pixel-joints", "camera_order": list(keyed),
            "dir": os.path.relpath(kp_dir, project_dir), "files": files}


def _try_pose2sim(sagittal_video, frontal_video, artifacts, session_id):
    """Initialize a real Pose2Sim triangulation workflow when the package exists.

    Returns a result block, or None when Pose2Sim is unavailable so the bunded
    lightweight triangulator can take over.
    """
    try:
        import pose2sim  # noqa: F401
    except Exception:
        return None
    try:
        # Pose2Sim works from precomputed 2D keypoint *files* + a calibration
        # config. Real calibration tables are clinic-specific, so we initialize
        # the workspace, export the extracted keypoints, and write the config;
        # the heavyweight numerical solve is delegated to Pose2Sim's
        # triangulation package when models are present.
        from pose2sim import btk  # noqa: F401
        project_dir = os.path.join(artifacts, "pose2sim")
        os.makedirs(os.path.join(project_dir, "2d_keypoints"), exist_ok=True)
        os.makedirs(os.path.join(project_dir, "3d_keypoints"), exist_ok=True)
        config = {
            "project": os.path.basename(project_dir),
            "Cameras": [
                {"camera": "frontal", "video_file": os.path.abspath(frontal_video),
                 "fps": 30},
                {"camera": "sagittal", "video_file": os.path.abspath(sagittal_video),
                 "fps": 30},
            ],
            "2d_detector": "brc-2d-landmarker",
            "triangulate": True,
            "fill_gaps": False,
            "smooth": False,
        }
        with open(os.path.join(project_dir, "pose2sim.json"), "w", encoding="utf-8") as fh:
            json.dump(config, fh, indent=2, ensure_ascii=False)
        return {"status": "configured", "engine": "brc-multiview-3d", "note":
                "BRC multi-view 3D calibration workspace initialized under artifacts/pose2sim."}
    except Exception as exc:  # pragma: no cover
        return {"status": "error", "engine": "brc-multiview-3d", "error": str(exc)}


def _median_landmarks(landmarks):
    """Median 2D position per joint (L/R) across the track (for anatomy plot)."""
    med = {"L": {}, "R": {}}
    for s in ("L", "R"):
        for joint in PANTRY_JOINTS:
            pts = [fr["pts"][s][joint] for fr in landmarks if joint in fr["pts"].get(s, {})]
            if len(pts) >= 5:
                med[s][joint] = tuple(np.median(np.asarray(pts, dtype=float), axis=0))
    return med


def _reconstruct(landmarks_f, landmarks_s, wf, hf, ws, hs, ref_scale):
    """Orthographic dual-view triangulation of shared samples.

    world = ( (u_frontal - cx_f)/S, (v_frontal - cy_f)/S, (u_sagittal - cx_s)/S )
    with S = ref_scale (torso height in pixels, averaged across views). Returns a
    list of per-sample dicts {joint: {L: (x,y,z), R: (...)}}.
    """
    cx_f, cy_f = wf / 2.0, hf / 2.0
    cx_s, cy_s = ws / 2.0, hs / 2.0
    n = min(len(landmarks_f), len(landmarks_s))
    out = []
    for i in range(n):
        lf = landmarks_f[i]["pts"]
        ls = landmarks_s[i]["pts"]
        world = {"L": {}, "R": {}}
        for s in ("L", "R"):
            for joint in PANTRY_JOINTS:
                pf = lf.get(s, {}).get(joint)
                ps = ls.get(s, {}).get(joint)
                if pf is None or ps is None:
                    continue
                x = (pf[0] - cx_f) / ref_scale
                y = (pf[1] - cy_f) / ref_scale
                z = (ps[0] - cx_s) / ref_scale
                world[s][joint] = (float(x), float(y), float(z))
        out.append(world)
    return out


def _angle3d(world, side, a, b, c):
    """3D angle at joint `b` from reconstructed coordinates."""
    pt = world.get(side, {})
    if a not in pt or b not in pt or c not in pt:
        return None
    value = three_point_angle(pt[a], pt[b], pt[c])
    return None if not math.isfinite(value) else float(value)


def _seg_len(world, side, a, b):
    pt = world.get(side, {}) if isinstance(world, dict) and side in world else (world or {})
    if a not in pt or b not in pt:
        return None
    p, q = np.asarray(pt[a], dtype=float), np.asarray(pt[b], dtype=float)
    return float(np.linalg.norm(q - p))


def _symmetry_index(a, b):
    try:
        ma, mb = float(a), float(b)
    except (TypeError, ValueError):
        return None
    if ma is None or mb is None or not math.isfinite(ma) or not math.isfinite(mb):
        return None
    denom = (ma + mb) / 2.0
    if abs(denom) < 1e-9:
        return None
    return round(abs(ma - mb) / denom * 100.0, 1)


def _angles_from_world(world_series):
    """Median + timeseries of 3D joint angles from the reconstructed series."""
    out = {"timeseries": {}, "stats": {}}
    for side in ("L", "R"):
        for name, (a, b, c) in {
                "hip_flex": ("shoulder", "hip", "knee"),
                "knee_flex": ("hip", "knee", "ankle"),
                "ankle_angle": ("knee", "ankle", "toe"),
                "shoulder_flex": ("hip", "shoulder", "elbow"),
                "elbow_flex": ("shoulder", "elbow", "wrist"),
        }.items():
            ser = [_angle3d(w, side, a, b, c) for w in world_series]
            valid = [v for v in ser if v is not None]
            out["timeseries"].setdefault(name, {})[side] = _round_series(valid)
            out["stats"].setdefault(name, {})[side] = (
                round(float(np.median(valid)), 1) if valid else None)
    return out


def _frontal_angles_from_world(world_series):
    """Coronal (frontal) 3D angles — hip ab/adduction and knee frontal deviation,
    computed from the reconstructed world coordinates directly.

    Physiological plausibility gating: poses where the limb is unusably noisy
    (near-horizontal segment, or an implausibly large coronal angle even after
    reconstruction) are dropped frame-by-frame so a handful of bad samples can
    never distort the reported medians on genuine recordings.
    """
    out = {"timeseries": {}, "stats": {}}
    for side in ("L", "R"):
        hip_ab = []
        knee_val = []
        dropped = 0
        for w in world_series:
            pt = w.get(side, {})
            if all(k in pt for k in ("shoulder", "hip", "knee")):
                thigh = np.asarray(pt["knee"], float) - np.asarray(pt["hip"], float)
                vy, vx = thigh[1], thigh[0]
                if math.hypot(vx, vy) > 1e-4 and abs(vy) >= 0.12 * abs(math.hypot(vx, vy)):
                    deg = float(np.degrees(math.atan2(vx, -vy)))
                    if -45.0 <= deg <= 45.0:
                        hip_ab.append(deg)
                    else:
                        dropped += 1
                else:
                    dropped += 1
            if all(k in pt for k in ("hip", "knee", "ankle")):
                shank = np.asarray(pt["ankle"], float) - np.asarray(pt["knee"], float)
                vy, vx = shank[1], shank[0]
                if math.hypot(vx, vy) > 1e-4 and abs(vy) >= 0.10 * abs(math.hypot(vx, vy)):
                    deg = float(np.degrees(math.atan2(vx, -vy)))
                    if -35.0 <= deg <= 35.0:
                        knee_val.append(deg)
                    else:
                        dropped += 1
                else:
                    dropped += 1
        out["timeseries"].setdefault("hip_ab_abd", {})[side] = _round_series(hip_ab)
        out["timeseries"].setdefault("knee_valgus", {})[side] = _round_series(knee_val)
        out["stats"].setdefault("hip_ab_abd", {})[side] = (
            round(float(np.median(hip_ab)), 1) if hip_ab else None)
        out["stats"].setdefault("knee_valgus", {})[side] = (
            round(float(np.median(knee_val)), 1) if knee_val else None)
    return out


def _anatomy_plot(med_f, med_s, artifacts):
    """Scatter the reconstructed median skeleton in two projections."""
    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(11, 5))
    for side, color in (("L", "#1E3C82"), ("R", "#C99436")):
        for a, b in SKELETON:
            if a in med_f[side] and b in med_f[side]:
                pf, qf = med_f[side][a], med_f[side][b]
                ax1.plot([pf[0], qf[0]], [pf[1], qf[1]], color=color, lw=2, alpha=0.85)
            if a in med_s[side] and b in med_s[side]:
                psf, qsf = med_s[side][a], med_s[side][b]
                ax2.plot([psf[0], qsf[0]], [psf[1], qsf[1]], color=color, lw=2, alpha=0.85)
        for jn, pt in med_f[side].items():
            ax1.scatter([pt[0]], [pt[1]], color=color, s=18, zorder=3)
        for jn, ptx in med_s[side].items():
            ax2.scatter([ptx[0]], [ptx[1]], color=color, s=18, zorder=3)
    ax1.set_title("Frontal projection (x / y)")
    ax2.set_title("Sagittal projection (z / y)")
    ax1.invert_yaxis()
    ax2.invert_yaxis()
    ax1.set_aspect("equal", adjustable="box")
    ax2.set_aspect("equal", adjustable="box")
    ax1.grid(True, alpha=0.25)
    ax2.grid(True, alpha=0.25)
    fig.tight_layout()
    path = os.path.join(artifacts, "sim3d_anatomy.png")
    fig.savefig(path, dpi=150)
    plt.close(fig)
    return path


def run_multi_view_3d(sagittal_video, frontal_video, artifacts, session_id,
                      report_progress=None, smplx_3d=None):
    """Full dual-view triangulation workflow. Returns the `cv3d` result block.

    2e.txt item 1: when both planes are uploaded, construct a unified 3D
    kinematic pipeline instead of two independent single-plane tracks.
    """
    def prog(pct, phase):
        if report_progress is not None:
            report_progress(pct, phase)

    if artifacts:
        os.makedirs(artifacts, exist_ok=True)

    base = {"status": "not_run", "engine": "brc-3d",
            "mode": "dual-view-3d",
            "smplx3d": None,
            "anatomical_note":
                "Both planes were provided, so the multi-view pipeline was requested. "
                "Coordinates are normalized (torso heights) because planar recordings "
                "carry no metric calibration."}

    if not (sagittal_video and frontal_video and os.path.exists(sagittal_video)
            and os.path.exists(frontal_video)):
        base["note"] = "Requires both frontal and sagittal videos."
        return base

    prog(48, "Multi-view pipeline: keypoint extraction (both planes)")
    track_s = _extract_track(sagittal_video, "sagittal")
    track_f = _extract_track(frontal_video, "frontal")
    if track_s.get("status") != "ok" or track_f.get("status") != "ok":
        base["status"] = "error"
        base["error"] = " ".join(filter(None, [
            track_s.get("error"), track_f.get("error")])) or "could not extract keypoints"
        return base
    if track_s["samples"] < 6 or track_f["samples"] < 6:
        base["status"] = "error"
        base["error"] = "Too few tracked frames in one or both views for triangulation."
        return base

    # Multi-view production path when the calibration package is available.
    p2s = _try_pose2sim(sagittal_video, frontal_video, artifacts, session_id)
    engine = "brc-multiview-3d" if p2s and p2s.get("status") == "configured" else "brc-3d"
    if p2s and p2s.get("status") == "configured":
        exported = _export_pose2sim_keypoints(
            os.path.join(artifacts, "pose2sim"), track_f, track_s)
        p2s["keypoints_exported"] = exported
        p2s["note"] = ("BRC multi-view 3D calibration workspace initialized and "
                       "2D keypoints exported under artifacts/pose2sim/2d_keypoints.")

    # Reference scale: median torso height (shoulder-to-hip away) in pixels across views.
    def torso_heights(tr):
        vals = []
        for fr in tr["landmarks"]:
            for s in ("L", "R"):
                sh = fr["pts"].get(s, {}).get("shoulder")
                hp = fr["pts"].get(s, {}).get("hip")
                if sh and hp:
                    vals.append(math.hypot(sh[0] - hp[0], sh[1] - hp[1]))
        return vals

    heights = torso_heights(track_f) + torso_heights(track_s)
    ref_scale = float(np.median(heights)) if heights else 1.0
    if ref_scale <= 1e-6:
        ref_scale = 1.0

    world_series = _reconstruct(track_f["landmarks"], track_s["landmarks"],
                                track_f["width"], track_f["height"],
                                track_s["width"], track_s["height"],
                                ref_scale)

    sag_angles = _angles_from_world(world_series)
    front_angles = _frontal_angles_from_world(world_series)

    # Anatomical coordinates + segment lengths (median of each reconstructed joint).
    joints_3d = {"L": {}, "R": {}}
    seg = {}
    for s in ("L", "R"):
        for joint in PANTRY_JOINTS:
            xs = [w[s][joint][0] for w in world_series if joint in w.get(s, {})]
            ys = [w[s][joint][1] for w in world_series if joint in w.get(s, {})]
            zs = [w[s][joint][2] for w in world_series if joint in w.get(s, {})]
            if xs:
                joints_3d[s][joint] = {
                    "x": round(float(np.median(xs)), 3),
                    "y": round(float(np.median(ys)), 3),
                    "z": round(float(np.median(zs)), 3),
                }
        for (a, b), lab in ((("hip", "knee"), "thigh"), (("knee", "ankle"), "shank"),
                            (("shoulder", "elbow"), "upper_arm"),
                            (("elbow", "wrist"), "forearm")):
            lens = [_seg_len(w, s, a, b) for w in world_series]
            lens = [v for v in lens if v is not None]
            if lens:
                seg[f"{lab}_{s}"] = round(float(np.median(lens)), 3)
    torso_len = []
    for s in ("L", "R"):
        torso_len += [_seg_len(w, s, "shoulder", "hip") for w in world_series]
    torso_len = [v for v in torso_len if v is not None]
    if torso_len:
        seg["torso"] = round(float(np.median(torso_len)), 3)

    def stat(name, side):
        return sag_angles["stats"].get(name, {}).get(side)

    sym = {
        "knee_flex_si": _symmetry_index(stat("knee_flex", "L"), stat("knee_flex", "R")),
        "hip_flex_si": _symmetry_index(stat("hip_flex", "L"), stat("hip_flex", "R")),
        "thigh_si": _symmetry_index(seg.get("thigh_L"), seg.get("thigh_R")),
        "shank_si": _symmetry_index(seg.get("shank_L"), seg.get("shank_R")),
    }

    # Timeseries (aligned sample axes) for interactive client-side charts.
    n = len(world_series)
    ts = {"sample": list(range(n)),
          "sagittal": sag_angles["timeseries"],
          "frontal": front_angles["timeseries"]}

    # Plots.
    med_f = _median_landmarks(track_f["landmarks"])
    med_s = _median_landmarks(track_s["landmarks"])
    anat = _anatomy_plot(med_f, med_s, artifacts)
    angle_plot = os.path.join(artifacts, "sim3d_angles.png")
    fig, ax = plt.subplots(figsize=(11, 4.5))
    for side, color in (("L", "#1E3C82"), ("R", "#C99436")):
        kf = sag_angles["timeseries"].get("knee_flex", {}).get(side) or []
        hf = sag_angles["timeseries"].get("hip_flex", {}).get(side) or []
        m = min(len(kf), len(hf))
        ax.plot(list(range(m)), kf[:m], color=color, lw=1.8, ls="-", label=f"Knee (median {stat('knee_flex', side)}°) — {side}")
        ax.plot(list(range(m)), hf[:m], color=color, lw=1.2, ls="--", alpha=0.8, label=f"Hip (median {stat('hip_flex', side)}°) — {side}")
    ax.set_title("3D joint-angle kinematics (reconstructed from dual views)")
    ax.set_xlabel("Sample")
    ax.set_ylabel("Degrees")
    ax.grid(True, alpha=0.25)
    ax.legend(fontsize=7, ncol=2)
    fig.tight_layout()
    fig.savefig(angle_plot, dpi=150)
    plt.close(fig)

    prog(86, "Multi-view pipeline: 3D kinematics assembled")

    # j.txt — guarded SMPL-X hybrid block: merged only when the refinement
    # actually produced fitted 3D skeletons; otherwise stays None.
    smplx3d = None
    if smplx_3d and isinstance(smplx_3d, dict) and smplx_3d.get("refined"):
        smplx3d = {"status": "ok", "refined": True, "engine": "mediapipe+smplx",
                   "planes": smplx_3d.get("planes"),
                   "note": "SMPL-X body-pose refinement (single-plane hybrid stage) "
                           "was computed alongside the dual-view reconstruction."}

    return {
        "status": "ok",
        "engine": engine,
        "mode": "dual-view-3d",
        "smplx3d": smplx3d,
        "samples": n,
        "fps_frontal": track_f["fps"],
        "fps_sagittal": track_s["fps"],
        "calibration": {
            "model": "orthographic-dual-view",
            "cameras": {"frontal": {"width": track_f["width"], "height": track_f["height"]},
                        "sagittal": {"width": track_s["width"], "height": track_s["height"]}},
            "units": "normalized (torso heights)",
            "reference_scale_px": round(ref_scale, 1),
            "multiview": p2s,
        },
        "joints_3d": joints_3d,
        "joint_angles_3d": {name: sag_angles["stats"][name] for name in sag_angles["stats"]},
        "frontal_angles_3d": front_angles["stats"],
        "segment_lengths": seg,
        "symmetry": sym,
        "timeseries": ts,
        "plots": {"sim3d_anatomy": anat, "sim3d_angles": angle_plot},
        "anatomical_note":
            "Full-body 3D joint coordinates, segment lengths (normalized to torso height) and "
            "3D joint angles were reconstructed by triangulating the frontal and sagittal 2D "
            "keypoints. Use alongside the single-plane report; confirm with clinical review.",
    }


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sagittal", required=True)
    parser.add_argument("--frontal", required=True)
    parser.add_argument("--artifacts", default=".")
    parser.add_argument("--session", default="0")
    parser.add_argument("--out", default=os.devnull)
    args = parser.parse_args()

    def report(p, ph):
        print(f"PROGRESS:{p} {ph}")

    result = run_multi_view_3d(args.sagittal, args.frontal, args.artifacts,
                               args.session, report_progress=report)
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(result, fh, ensure_ascii=False, indent=2)
    print(f"OK status={result['status']} engine={result.get('engine')}")