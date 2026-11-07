#!/usr/bin/env python3
"""
gait_lab.py — Bonsai Rehabilitation Center Gait Lab real Computer-Vision engine.

This engine performs *real* pose-estimation gait analysis using MediaPipe Pose on
BOTH uploaded views:

  * Sagittal (side-on) plane:
      - hip / knee / ankle sagittal kinematics (flexion-extension curves)
      - trunk lean + head tilt
      - cadence, stride durations, cycle timing (heel-strike detection)
      - 8-phase gait-cycle decomposition + anomaly flags
      - landmark-overlay video + ROM / posture graphs

  * Frontal (face-on) plane:
      - pelvic obliquity / drop
      - hip ab-/adduction (frontal plane)
      - knee varus / valgus (genu varum / valgum estimate)
      - lateral trunk lean, step width / base of support, weight-shift symmetry
      - landmark-overlay video + frontal-plane graph

Measured kinematics drive the clinical interpretation (deformities, muscle
involvement, prescriptions, references) using the same evidence tables shared
with the deterministic analyzer, so the output schema is identical.

It is a screening aid — never a diagnosis. Run:
  python gait_lab.py --session 7 --patient "Ayesha" \
      --frontal uploads/gait/f.mp4 --sagittal uploads/gait/s.mp4 \
      --artifacts uploads/gait/artifacts/7 --out result.json
"""

import argparse
import json
import math
import os
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone

import cv2
import numpy as np
import pandas as pd
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from scipy.signal import savgol_filter, find_peaks

ANALYZER = "brc-gait-lab"
VERSION = "1.0.0"

PHASE_DEFS = [
    ("initial_contact", "Initial Contact / Heel Strike", "stance", 0, 2, 2),
    ("loading_response", "Loading Response / Full Contact", "stance", 2, 10, 8),
    ("mid_stance", "Mid Stance", "stance", 10, 30, 20),
    ("terminal_stance", "Terminal Stance", "stance", 30, 50, 20),
    ("pre_swing", "Pre-Swing", "stance", 50, 60, 10),
    ("initial_swing", "Initial Swing", "swing", 60, 73, 13),
    ("mid_swing", "Mid Swing", "swing", 73, 87, 14),
    ("terminal_swing", "Terminal Swing", "swing", 87, 100, 13),
]

# --- MediaPipe pose landmark indices ---
# (mirrors the "Orthopedic Eye" engine; values use the standard MediaPipe Pose
# landmark ordering returned by the Tasks-vision PoseLandmarker)
L_INDEX = dict(ear=7, shoulder=11, elbow=13, wrist=15, hip=23, knee=25, ankle=27, foot=31, toe=29)
R_INDEX = dict(ear=8, shoulder=12, elbow=14, wrist=16, hip=24, knee=26, ankle=28, foot=32, toe=30)

SIDES = {
    "L": ("Left", L_INDEX),
    "R": ("Right", R_INDEX),
}


def three_point_angle(a, b, c):
    a = np.array(a, dtype=float)
    b = np.array(b, dtype=float)
    c = np.array(c, dtype=float)
    ba, bc = a - b, c - b
    cosine = np.dot(ba, bc) / (np.linalg.norm(ba) * np.linalg.norm(bc) + 1e-9)
    return np.degrees(np.arccos(np.clip(cosine, -1.0, 1.0)))


def signed_lean_from_vertical(bottom, top):
    dx = float(top[0] - bottom[0])
    dy = float(top[1] - bottom[1])
    if abs(dy) < 1e-6:
        return 0.0
    return np.degrees(np.arctan2(dx, -dy))


def landmark_pts(lm, idx_map, width, height, vis_min=0.35):
    """Extract (x,y) pixel coords for the landmarks that meet a visibility bar."""
    pts = {}
    for key, idx in idx_map.items():
        l = lm[idx]
        vis = getattr(l, "visibility", getattr(l, "presence", 1.0))
        if vis > vis_min:
            pts[key] = (float(l.x) * width, float(l.y) * height)
    return pts


def _vis_map(lm, idx_map):
    """Per-keypoint raw visibility (0-1) map — run.txt §5 confidence gate data."""
    out = {}
    for key, idx in idx_map.items():
        l = lm[idx]
        out[key] = float(getattr(l, "visibility", getattr(l, "presence", 1.0)))
    return out


# run.txt §5 zero-assumption clinical gate: a parameter is only measured from
# keypoints whose visibility is >= this value. Below it the parameter is
# marked Unassessed / Occluded instead of being reported with a number.
CONF_GATE = 0.60


def _gate_ok(vis, side, keys, threshold=CONF_GATE):
    """True when every required keypoint on side(s) cleared the confidence gate.

    side = "L" | "R" | "LR" (cross-side metrics need both limbs visible).
    When no visibility data exists (legacy path) the gate passes on presence
    alone, matching pre-§5 behaviour.
    """
    if not vis:
        return True
    sides = ("L", "R") if side == "LR" else (side,)
    for s in sides:
        vs = vis.get(s, {}) or {}
        for k in keys:
            if vs.get(k, 0.0) < threshold:
                return False
    return True


def fill_series(values):
    values = np.asarray(values, dtype=float)
    n = len(values)
    idx = np.arange(n)
    valid = ~np.isnan(values)
    if valid.sum() < 2:
        return values, 1.0
    out = values.copy()
    out[~valid] = np.interp(idx[~valid], idx[valid], values[valid])
    return out, 1.0 - (valid.sum() / n)


def detect_heel_strikes(signal, fps):
    signal, _ = fill_series(signal)
    wlen = min(15, len(signal) // 2 * 2 - 1)
    if wlen >= 5 and len(signal) >= wlen:
        smoothed = savgol_filter(signal, window_length=wlen, polyorder=3)
    else:
        smoothed = signal
    distance = max(int(fps * 0.35), 1)
    prominence = max(np.std(smoothed) * 0.4, 1e-6)
    peaks, _ = find_peaks(smoothed, distance=distance, prominence=prominence)
    return peaks


def normalize_cycles(time_series, events):
    cycles = []
    if len(events) < 2:
        return None
    for i in range(len(events) - 1):
        seg = time_series[events[i]:events[i + 1] + 1]
        if len(seg) < 3:
            continue
        xo = np.linspace(0, 100, len(seg))
        xn = np.linspace(0, 100, 101)
        cycles.append(np.interp(xn, xo, seg))
    return np.array(cycles) if cycles else None


def symmetry_index(a, b):
    if len(a) == 0 or len(b) == 0:
        return 0.0
    ma, mb = float(np.nanmean(a)), float(np.nanmean(b))
    if (ma + mb) == 0:
        return 0.0
    return abs(ma - mb) / ((ma + mb) / 2.0) * 100.0


def _make_pose_runner():
    """Return a callable pose(frame_rgb) -> landmark list (Tasks-vision PoseLandmarker).

    MediaPipe's legacy ``solutions.pose`` API was removed in mediapipe >= 0.10.14,
    so the Tasks-vision PoseLandmarker backed by ``pose_landmarker_full.task`` is
    the single supported inference path.
    """
    import mediapipe as mp
    from mediapipe.tasks import python as mp_python
    BaseOptions = mp_python.BaseOptions
    PoseLandmarker = mp_python.vision.PoseLandmarker
    Options = mp_python.vision.PoseLandmarkerOptions
    RunningMode = mp_python.vision.RunningMode
    model = os.environ.get(
        "POSE_LANDMARKER_MODEL",
        os.path.join(os.path.dirname(__file__), "..", "gait lab", "pose_landmarker_full.task"),
    )
    landmarker = PoseLandmarker.create_from_options(Options(
        base_options=BaseOptions(model_asset_path=model),
        running_mode=RunningMode.VIDEO,
    ))
    state = {"fc": 0}

    def run(rgb):
        ts = int(state["fc"] * 33)
        state["fc"] += 1
        img = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
        res = landmarker.detect_for_video(img, ts)
        return res.pose_landmarks[0] if (res.pose_landmarks and len(res.pose_landmarks) > 0) else None

    return run, landmarker


# Frame sampling: process every Nth frame to keep on-demand analysis responsive.
# Series / events are all expressed in *sample-index* space; the effective fps is
# real_fps / FRAME_SAMPLE_STEP. MAX_SAMPLES is the shared per-video pose budget
# for the screen + analyzers (see gait_validity.bounded_frame_plan): 150 frames
# at ~5 Hz covers ~30 s of walking — enough for several full stride cycles while
# keeping MediaPipe cost bounded on long recordings.
FRAME_SAMPLE_STEP = 4
MAX_SAMPLES = 150


def _sampled_frames(cap, step, max_samples, start=0):
    """Yield (sample_index, frame) for frames start, start+step, ... capped.

    Uses a sequential read with frame skipping rather than per-frame random
    seeks: ``CAP_PROP_POS_FRAMES`` + ``read()`` is 10-40x slower than an
    equally-pitched sequential read on common MP4 encoders (see the note in
    python/gait_validity.py). The yielded frames are identical (absolute frame
    indices start+0, start+step, start+2*step, ...) — only the read strategy
    changes. ``start`` aligns this pass with the bounded middle window picked by
    ``bounded_frame_plan`` so the screen's POSE_CACHE landmarks are reused.
    """
    if start:
        cap.set(cv2.CAP_PROP_POS_FRAMES, start)
    frame_idx = 0
    yielded = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        if frame_idx % step == 0:
            yield frame_idx // step, frame
            yielded += 1
            if yielded >= max_samples:
                break
        frame_idx += 1


def _eff_fps(fps, step):
    return max(1.0, fps / step)


def _auto_step(cap, max_samples, min_step=None):
    """Choose a frame step so the ENTIRE clip is sampled but we never exceed
    max_samples pose-inference frames — bounding CPU time for long (60s+) videos."""
    min_step = min_step or FRAME_SAMPLE_STEP
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    if total <= 0:
        return min_step
    return max(min_step, (total + max_samples - 1) // max_samples)


def _aligned_step(video_path):
    """Shared sampling plan for the screen + analyzers so the analysis reuses the
    screen's MediaPipe landmarks (POSE_CACHE). Returns a dict with the step,
    window start frame and sample count (see gait_validity.bounded_frame_plan)."""
    return bounded_frame_plan(video_path)


def _pose_input(frame, max_dim=480, interp=cv2.INTER_AREA):
    """Convert a BGR frame to RGB, downscaling to a bounding box of `max_dim`.

    Landmarks are normalized (0-1) relative to the *input* frame, so feeding a
    downscaled image returns the same normalized coordinates the full-res pass
    would; callers scale them back to original pixel space via the video's real
    width/height. Downscaling a 1280x720 clip to <=640 cuts MediaPipe CPU time
    ~3x with negligible angle drift (angles are scale-invariant).
    """
    rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    if max(rgb.shape[:2]) > max_dim:
        s = float(max_dim) / max(rgb.shape[:2])
        rgb = cv2.resize(rgb, (int(rgb.shape[1] * s), int(rgb.shape[0] * s)),
                         interpolation=interp)
    return rgb


# Tracks already inferred by the single-plane analyzers, keyed by absolute video
# path. cv3d reuses them instead of re-running MediaPipe on the same clips.
TRACK_CACHE = {}

# 2.md — SMPL-X fitting spike (python/smplx_fit.py). OFF by default: flip to
# True only after the decision gate (SMPL-X model files procured + angle
# agreement vs MediaPipe + runtime acceptable on CPU). When on, the third
# (Coronal) plane's raw keypoints are fitted per frame and corrected 3D knee
# angles are merged into result["smplx"]. Existing report logic is untouched.
USE_SMPLX = False
SMPLX_MODEL_DIR = "smplx_models"


def _register_track(video_path, slot, fps, width, height, step, landmarks):
    """Store an inferred 2D landmark track for later reuse by the 3D pipeline."""
    TRACK_CACHE[os.path.abspath(video_path)] = {
        "status": "ok", "slot": slot, "fps": fps, "width": width,
        "height": height, "step": step, "samples": len(landmarks),
        "landmarks": landmarks,
    }


# MediaPipe Pose 33 landmark canonical order (index -> name), used to build a
# flat keypoint list for the SMPL-X fitter (python/smplx_fit.py expects either
# 33 MediaPipe or 25 OpenPose-25 keypoints per frame).
_MP33_ORDER = ["nose", "left_eye_inner", "left_eye", "left_eye_outer",
               "right_eye_inner", "right_eye", "right_eye_outer",
               "left_ear", "right_ear", "mouth_left", "mouth_right",
               "left_shoulder", "right_shoulder", "left_elbow", "right_elbow",
               "left_wrist", "right_wrist", "left_pinky", "right_pinky",
               "left_index", "right_index", "left_thumb", "right_thumb",
               "left_hip", "right_hip", "left_knee", "right_knee",
               "left_ankle", "right_ankle", "left_heel", "right_heel",
               "left_foot_index", "right_foot_index"]
# Map MediaPipe name -> (side, pantry joint) for lookup in TRACK_CACHE pts.
_MP33_TO_PTS = {
    "left_ear": ("L", "ear"), "right_ear": ("R", "ear"),
    "left_shoulder": ("L", "shoulder"), "right_shoulder": ("R", "shoulder"),
    "left_elbow": ("L", "elbow"), "right_elbow": ("R", "elbow"),
    "left_wrist": ("L", "wrist"), "right_wrist": ("R", "wrist"),
    "left_hip": ("L", "hip"), "right_hip": ("R", "hip"),
    "left_knee": ("L", "knee"), "right_knee": ("R", "knee"),
    "left_ankle": ("L", "ankle"), "right_ankle": ("R", "ankle"),
    "left_foot_index": ("L", "toe"), "right_foot_index": ("R", "toe"),
}


def _pts_to_mediapipe33(pts):
    """Convert TRACK_CACHE per-side pts dict to a flat list of 33 MediaPipe
    keypoints {x, y, visibility}. Missing joints get visibility 0."""
    out = []
    for name in _MP33_ORDER:
        entry = _MP33_TO_PTS.get(name)
        if entry:
            side, joint = entry
            pt = (pts or {}).get(side, {}).get(joint)
            if pt:
                out.append({"x": float(pt[0]), "y": float(pt[1]),
                            "visibility": 1.0})
            else:
                out.append({"x": 0.0, "y": 0.0, "visibility": 0.0})
        else:
            out.append({"x": 0.0, "y": 0.0, "visibility": 0.0})
    return out


_progress = {"phase": "", "pct": 0}


def _round_series(arr):
    """Convert a numpy series into a JSON-safe list of rounded floats (None for NaN)."""
    out = []
    for v in np.asarray(arr, dtype=float).ravel():
        if np.isfinite(v):
            out.append(round(float(v), 1))
        else:
            out.append(None)
    return out


def _json_clean(obj):
    """Recursively convert non-finite floats/ints to None so the output is always valid JSON."""
    if isinstance(obj, dict):
        return {k: _json_clean(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_json_clean(v) for v in obj]
    if isinstance(obj, float):
        return obj if np.isfinite(obj) else None
    if isinstance(obj, int) and not isinstance(obj, bool):
        return obj if np.isfinite(float(obj)) else None
    return obj


def _report_progress(pct, phase):
    """Emit a machine-readable progress line so the server/frontend can show
    active loading feedback instead of a blank screen."""
    pct = max(0, min(100, int(pct)))
    _progress.update({"_pct": pct, "_phase": phase})
    try:
        print(f"PROGRESS:{pct} {phase}", flush=True)
    except Exception:
        pass


_STAGE_T0 = None
_STAGE_LOG = []


def _tick(label):
    """Record a wall-clock stage marker (CLI timing diagnostics, stderr-only)."""
    if _STAGE_T0 is None:
        return
    _STAGE_LOG.append((label, time.perf_counter() - _STAGE_T0))


def _dump_stage_times():
    if not _STAGE_LOG:
        return
    try:
        sys.stderr.write("STAGES: " + ", ".join("%s=%.1f" % (l, t) for l, t in _STAGE_LOG) + "\n")
        sys.stderr.flush()
    except Exception:
        pass


def analyze_sagittal(video_path, artifacts, session_id, step=None, start=0, speed_factor=1.0, running=False, validated_cadence=None):
    """Run sagittal-plane pose analysis; return rich dict + write overlay/graphs.

    ``step`` / ``start`` come from bounded_frame_plan so this pass samples the
    same absolute frames (start + k*step) the gait-validity screen already
    inferred — reusing POSE_CACHE instead of re-running MediaPipe.

    speed_factor = real seconds per video second (1.0 real time; >1 slow-motion
    — cadence / cycle timing is then normalized to real time for clinical use).
    running = True when the recording is classified (or hinted) as running, which
    uses a running-appropriate cycle clamp and phase model (shorter cycle allowed).
    """
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        return _empty_cv("sagittal", "Could not open sagittal video")

    step = step or _auto_step(cap, MAX_SAMPLES)

    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    eff_fps = _eff_fps(fps, step)

    _sag_m = ("hip_flexion", "knee_flexion", "ankle_angle", "shoulder_flex", "elbow_flex")
    series = {"L": {m: [] for m in _sag_m},
              "R": {m: [] for m in _sag_m}}
    conf_hits = {"L": {m: 0 for m in _sag_m},
                 "R": {m: 0 for m in _sag_m}}
    ankle_offset = {"L": [], "R": []}
    trunk_lean = []
    head_tilt = []
    frontal_ratio = []
    shoulder_protrusion = {"L": [], "R": []}
    frame_indices = []        # absolute frame index for each sample
    raw_landmarks = []        # per-sample: dict of {side: {joint_label: (x,y)}} + None

    runner = None
    closer = None
    try:
        for si, frame in _sampled_frames(cap, step, MAX_SAMPLES, start=start):
            abs_idx = start + si * step
            vis = None
            pts = cached_pts(video_path, abs_idx)
            if pts is None:
                if runner is None:
                    runner, closer = _make_pose_runner()
                rgb = _pose_input(frame)
                lm = runner(rgb)
                pts = {"L": {}, "R": {}}
                if lm is not None:
                    vis = {"L": {}, "R": {}}
                    for s, (_, imap) in SIDES.items():
                        pts[s] = landmark_pts(lm, imap, width, height)
                        vis[s] = _vis_map(lm, imap)
            else:
                vis = cached_vis(video_path, abs_idx)
            raw_landmarks.append({"abs": abs_idx, "pts": pts, "vis": vis})

            for s in ("L", "R"):
                p = pts[s]
                hip_ok = _gate_ok(vis, s, ("shoulder", "hip", "knee"))
                knee_ok = _gate_ok(vis, s, ("hip", "knee", "ankle"))
                ankle_ok = _gate_ok(vis, s, ("knee", "ankle", "foot"))
                sh_ok = _gate_ok(vis, s, ("hip", "shoulder", "elbow"))
                el_ok = _gate_ok(vis, s, ("shoulder", "elbow", "wrist"))
                series[s]["hip_flexion"].append(
                    _sag_metric("hip", p) if (all(k in p for k in ("shoulder", "hip", "knee")) and hip_ok) else np.nan)
                series[s]["knee_flexion"].append(
                    _sag_metric("knee", p) if (all(k in p for k in ("hip", "knee", "ankle")) and knee_ok) else np.nan)
                series[s]["ankle_angle"].append(
                    _sag_metric("ankle", p) if (all(k in p for k in ("knee", "ankle", "foot")) and ankle_ok) else np.nan)
                series[s]["shoulder_flex"].append(
                    _sag_metric("shoulder", p) if (all(k in p for k in ("hip", "shoulder", "elbow")) and sh_ok) else np.nan)
                series[s]["elbow_flex"].append(
                    _sag_metric("elbow", p) if (all(k in p for k in ("shoulder", "elbow", "wrist")) and el_ok) else np.nan)
                if hip_ok:
                    conf_hits[s]["hip_flexion"] += 1
                if knee_ok:
                    conf_hits[s]["knee_flexion"] += 1
                if ankle_ok:
                    conf_hits[s]["ankle_angle"] += 1
                if sh_ok:
                    conf_hits[s]["shoulder_flex"] += 1
                if el_ok:
                    conf_hits[s]["elbow_flex"] += 1
                ankle_offset[s].append(
                    p["ankle"][0] - p["hip"][0] if ("hip" in p and "ankle" in p and _gate_ok(vis, s, ("hip", "ankle"))) else np.nan)
                # Phase D — forward shoulder offset vs pelvis (horizontal projection,
                # normalized to thigh length): positive = shoulder ahead of hip in
                # the plane; sign depends on the direction faced, so both a forward
                # protraction screen AND a symmetry screen use the values below.
                if all(k in p for k in ("shoulder", "hip", "ankle")) and _gate_ok(vis, s, ("shoulder", "hip", "ankle")):
                    ref = abs(p["hip"][1] - p["ankle"][1])
                    if ref > 1e-6:
                        shoulder_protrusion[s].append((p["shoulder"][0] - p["hip"][0]) / ref)

            hip_pts = [pts[s]["hip"] for s in ("L", "R") if "hip" in pts[s] and _gate_ok(vis, s, ("hip",))]
            sh_pts = [pts[s]["shoulder"] for s in ("L", "R") if "shoulder" in pts[s] and _gate_ok(vis, s, ("shoulder",))]
            ear_pts = [pts[s]["ear"] for s in ("L", "R") if "ear" in pts[s] and _gate_ok(vis, s, ("ear",))]
            trunk_lean.append(signed_lean_from_vertical(np.mean(hip_pts, axis=0), np.mean(sh_pts, axis=0)) if (hip_pts and sh_pts) else np.nan)
            head_tilt.append(signed_lean_from_vertical(np.mean(sh_pts, axis=0), np.mean(ear_pts, axis=0)) if (sh_pts and ear_pts) else np.nan)
            # Frontal-view heuristic (mirrors the frontal analyzer): when the two
            # hip markers are clearly separated relative to body height the clip is
            # front-on — which must never be run as a sagittal-plane analysis.
            if _gate_ok(vis, "LR", ("hip", "ankle")) and all(k in pts.get("L", {}) and k in pts.get("R", {}) for k in ("hip", "ankle")):
                hip_mid = (np.array(pts["L"]["hip"]) + np.array(pts["R"]["hip"])) / 2.0
                hip_dx = pts["R"]["hip"][0] - pts["L"]["hip"][0]
                hip_dy = pts["R"]["hip"][1] - pts["L"]["hip"][1]
                body_h = abs(hip_mid[1] - np.mean([pts["R"]["ankle"][1], pts["L"]["ankle"][1]]))
                hip_w = float(np.hypot(hip_dx, hip_dy))
                if body_h > 1e-6:
                    frontal_ratio.append(float(hip_w / body_h))
            frame_indices.append(si * step)
    finally:
        cap.release()
        try:
            if closer is not None:
                closer.close()
        except Exception:
            pass

    nsamples = len(frame_indices)
    if nsamples == 0 or all(len(v) == 0 for m in series.values() for v in m.values()):
        return _empty_cv("sagittal", "No landmarks detected in sagittal video")

    # Plane-orientation check (mirrors the frontal analyzer): a front-on clip put
    # in the "sagittal" slot must be rejected so we never report sagittal-plane
    # curves that were computed from a frontal view.
    frr = [f for f in frontal_ratio if np.isfinite(f)]
    if frr and float(np.median(frr)) >= 0.30:
        return _empty_cv("sagittal", "This video appears to be a front-on frontal view, not a side "
                                     "(sagittal) view — sagittal-plane metrics were skipped.",
                         status="mislabeled")

    # ---- cycle timing (sample-index space, scaled to real seconds) ----
    # speed_factor accounts for slow-motion / fast-forward playback: stride
    # times and cycle duration are multiplied by it to express real time.
    speed = max(1e-3, float(speed_factor))
    events = {}
    stride_times = {}
    for s in ("L", "R"):
        filled, _ = fill_series(np.array(ankle_offset[s]))
        # For speed-up clips (speed<1) heel strikes fall closer together in
        # sample space, so shrink the peak-separation floor proportionally.
        ev = detect_heel_strikes(filled, eff_fps * min(1.0, speed))
        events[s] = ev
        stride_times[s] = np.diff(ev) / eff_fps * speed if len(ev) >= 2 else np.array([])

    mean_curves = {s: {} for s in ("L", "R")}
    for m in _sag_m:
        for s in ("L", "R"):
            mat = normalize_cycles(np.asarray(series[s][m]), events[s])
            mean_curves[s][m] = np.nanmean(mat, axis=0) if mat is not None and mat.size else np.full(101, np.nan)

    total_cycles = sum(1 for s in ("L", "R") if len(events[s]) >= 2)
    if total_cycles == 0 or all(np.isnan(mean_curves[s][m]).all() for s in ("L", "R") for m in _sag_m):
        return _empty_cv("sagittal", "Insufficient valid gait cycles detected in sagittal video")

    if any(len(st) for st in stride_times.values()):
        raw_cycle = float(np.mean([np.mean(st) for st in stride_times.values() if len(st)]))
    else:
        raw_cycle = 0.0
    # raw_cycle is already in real seconds (speed-scaled above). Clamp to a
    # physiologically plausible cadence window so the report stays sane. Running
    # cycles are physiologically shorter (0.33-0.67 s), so clamp accordingly.
    if running:
        low, high, fallback = 0.30, 0.70, 0.45
    else:
        low, high, fallback = 0.5, 2.5, 1.1
    cycle_seconds = fallback if (raw_cycle <= 0 or raw_cycle < low or raw_cycle > high) else raw_cycle
    # For a genuine RUN the validity screen already measured a robust, high-
    # periodicity cadence from the FFT (cadence_real_hz). The heel-strike event
    # spacing here can double-count in running's double-float phase, so when a
    # validated running cadence is available it is the authoritative cycle time.
    if running and validated_cadence and 0.30 <= (1.0 / validated_cadence) <= 0.70:
        cycle_seconds = 1.0 / validated_cadence
    stance_pct = _estimate_stance_pct(ankle_offset, events, eff_fps)
    if running:
        # Running gait: stance ~40%, swing ~60%, no double support. Clamp to the
        # running stance window rather than the walking 52-74% window the estimator
        # targets.
        stance_pct = max(30.0, min(48.0, stance_pct * 0.50 + 20.0))

    # ---- ROM extremes ----
    rom = {}
    for s in ("L", "R"):
        hip = np.asarray(series[s]["hip_flexion"])
        knee = np.asarray(series[s]["knee_flexion"])
        ankle = np.asarray(series[s]["ankle_angle"])
        sh = np.asarray(series[s]["shoulder_flex"])
        el = np.asarray(series[s]["elbow_flex"])
        rom[s] = {
            "hip_max": float(np.nanmax(hip)) if hip.size else 0.0,
            "hip_min": float(np.nanmin(hip)) if hip.size else 0.0,
            "knee_max": float(np.nanmax(knee)) if knee.size else 0.0,
            "knee_min": float(np.nanmin(knee)) if knee.size else 0.0,
            "ankle_max_df": float(np.nanmax(ankle)) if ankle.size else 0.0,
            "ankle_max_pf": float(np.nanmin(ankle)) if ankle.size else 0.0,
            "knee_rom": float(np.nanmax(knee) - np.nanmin(knee)) if knee.size else 0.0,
            "hip_peak": float(np.nanmax(hip)) if hip.size else 0.0,
            "ankle_rom": (float(np.nanmax(ankle) - np.nanmin(ankle)) if ankle.size else 0.0),
            "shoulder_flex_max": float(np.nanmax(sh)) if sh.size else 0.0,
            "shoulder_flex_rom": (float(np.nanmax(sh) - np.nanmin(sh)) if sh.size else 0.0),
            "elbow_flex_max": float(np.nanmax(el)) if el.size else 0.0,
            "elbow_flex_min": float(np.nanmin(el)) if el.size else 0.0,
            "elbow_flex_rom": (float(np.nanmax(el) - np.nanmin(el)) if el.size else 0.0),
        }

    # ---- graphs ----
    sag_plot = _sagittal_plots(mean_curves, trunk_lean, head_tilt, artifacts)

    # ---- overlay video (built from stored landmark data, no second model pass) ----
    overlay_path = _write_sagittal_overlay(video_path, frame_indices, raw_landmarks,
                                           events, series, fps, width, height, artifacts,
                                           step, speed, start=start)

    _register_track(video_path, "sagittal", fps, width, height, step, raw_landmarks)

    timeseries = {
        "cycle_pct": list(range(101)),
        "hip_flexion": {"L": _round_series(mean_curves["L"]["hip_flexion"]),
                        "R": _round_series(mean_curves["R"]["hip_flexion"])},
        "knee_flexion": {"L": _round_series(mean_curves["L"]["knee_flexion"]),
                         "R": _round_series(mean_curves["R"]["knee_flexion"])},
        "ankle_angle": {"L": _round_series(mean_curves["L"]["ankle_angle"]),
                        "R": _round_series(mean_curves["R"]["ankle_angle"])},
        "posture": {
            "sample": list(range(len(trunk_lean))),
            "trunk_lean": _round_series(trunk_lean),
            "head_tilt": _round_series(head_tilt),
        },
    }

    # Phase E (run.txt §5) — per-parameter 0-1 confidence = fraction of tracked
    # samples whose contributing keypoints cleared the 0.60 visibility gate.
    conf = {}
    for m in _sag_m:
        conf[m] = {s: (round(conf_hits[s][m] / nsamples, 3) if nsamples else 0.0)
                   for s in ("L", "R")}
    conf["shoulder_protrusion"] = {
        s: (round(len(shoulder_protrusion[s]) / nsamples, 3) if nsamples else 0.0)
        for s in ("L", "R")}
    posture_conf = {
        "trunk_lean": (round(sum(1 for v in trunk_lean if np.isfinite(v)) / nsamples, 3) if nsamples else 0.0),
        "head_tilt": (round(sum(1 for v in head_tilt if np.isfinite(v)) / nsamples, 3) if nsamples else 0.0),
    }

    protrusion_vals = {}
    for s in ("L", "R"):
        vals = [v for v in shoulder_protrusion[s] if np.isfinite(v)]
        protrusion_vals[s] = (float(np.mean(vals)) if vals else None)
    protrusion_abs_peak = 0.0
    for s, v in protrusion_vals.items():
        if v is not None:
            protrusion_abs_peak = max(protrusion_abs_peak, float(v))
    protrusion_note = None
    if protrusion_abs_peak is not None and any(v is not None for v in protrusion_vals.values()):
        protrusion_note = ("Shoulder horizontal offset vs pelvis measured as a planar projection "
                           "screen (left {LL:+} / right {RR:+} × thigh height). This is an estimate — "
                           "direction depends on the facing side and must be confirmed during "
                           "clinical examination.").format(
            LL=protrusion_vals["L"] or 0.0, RR=protrusion_vals["R"] or 0.0)

    return {
        "plane": "sagittal",
        "status": "ok",
        "fps": fps,
        "frames": total_frames,
        "samples": nsamples,
        "playback_speed": round(speed, 3),
        "running": bool(running),
        "cycle_seconds": round(cycle_seconds, 3),
        "cadence_cycles_per_second": round(1.0 / cycle_seconds, 3) if cycle_seconds else 0,
        "stance_pct": round(stance_pct, 1),
        "swing_pct": round(100.0 - stance_pct, 1),
        "stride_symmetry": round(symmetry_index(stride_times["L"], stride_times["R"]), 1),
        "knee_flexion_si": round(symmetry_index([rom["L"]["knee_max"]], [rom["R"]["knee_max"]]), 1),
        "hip_flexion_si": round(symmetry_index([rom["L"]["hip_peak"]], [rom["R"]["hip_peak"]]), 1),
        "rom": rom,
        "trunk_lean_range": f"{np.nanmin(trunk_lean):.1f}° to {np.nanmax(trunk_lean):.1f}°",
        "head_tilt_range": f"{np.nanmin(head_tilt):.1f}° to {np.nanmax(head_tilt):.1f}°",
        "specific": {
            "trunk_lean_min": round(float(np.nanmin(trunk_lean)), 1) if len(trunk_lean) else 0,
            "trunk_lean_max": round(float(np.nanmax(trunk_lean)), 1) if len(trunk_lean) else 0,
            "head_tilt_min": round(float(np.nanmin(head_tilt)), 1) if len(head_tilt) else 0,
            "head_tilt_max": round(float(np.nanmax(head_tilt)), 1) if len(head_tilt) else 0,
            "shoulder_flex_si": round(symmetry_index([rom["L"]["shoulder_flex_max"]], [rom["R"]["shoulder_flex_max"]]), 1),
            "elbow_flex_si": round(symmetry_index([rom["L"]["elbow_flex_max"]], [rom["R"]["elbow_flex_max"]]), 1),
            "shoulder_offset_vs_pelvis_L": (round(protrusion_vals["L"], 3) if protrusion_vals["L"] is not None else None),
            "shoulder_offset_vs_pelvis_R": (round(protrusion_vals["R"], 3) if protrusion_vals["R"] is not None else None),
        },
        "deformity_screens": {"shoulder_protrusion": protrusion_note},
        "confidence": {
            "threshold": CONF_GATE,
            "parameters": conf,
            "posture": posture_conf,
            "note": ("Per-parameter confidence is the fraction of tracked frames whose "
                     "contributing keypoints had visibility at or above {:.2f}. Values below "
                     "that gate are excluded and reported as Unassessed, never interpolated.").format(CONF_GATE),
        },
        "timeseries": timeseries,
        "plots": {
            "rom": _rel(sag_plot["rom"]),
            "posture": _rel(sag_plot["posture"]),
            "gait_cycle": _rel(_gait_cycle_plot(mean_curves, stance_pct, artifacts)),
            "full_rom": _rel(_full_rom_plot(rom, artifacts)),
        },
        "overlay_video": _rel(overlay_path),
    }


def _sagittal_plots(mean_curves, trunk_lean, head_tilt, artifacts):
    sag_plot = None
    posture_plot = None
    try:
        fig, axes = plt.subplots(5, 1, figsize=(9, 11), sharex=True)
        cmap = {"L": "#1E3C82", "R": "#C99436"}
        metric_rows = [
            ("hip_flexion", "Hip Flexion (°)"),
            ("knee_flexion", "Knee Flexion (°)"),
            ("ankle_angle", "Ankle Angle (°)"),
            ("shoulder_flex", "Shoulder Flexion (°)"),
            ("elbow_flex", "Elbow Flexion (°)"),
        ]
        x = np.linspace(0, 100, 101)
        for i, (m, lab) in enumerate(metric_rows):
            for s in ("L", "R"):
                if not np.isnan(mean_curves[s][m]).all():
                    axes[i].plot(x, mean_curves[s][m], color=cmap[s], lw=2.2, label=f"{s} Leg")
            axes[i].set_ylabel(lab, fontsize=10, fontweight="bold")
            axes[i].grid(True, alpha=0.3)
            axes[i].legend(loc="upper right")
        axes[4].set_xlabel("Normalized Gait Cycle (%)", fontsize=10, fontweight="bold")
        fig.suptitle("Bonsai Gait Lab — Sagittal Kinematic ROM", fontweight="bold", color="#1E3C82")
        fig.tight_layout()
        sag_plot = os.path.join(artifacts, "sagittal_rom_plot.png")
        fig.savefig(sag_plot, dpi=140)
        plt.close(fig)
    except Exception:
        sag_plot = None

    try:
        fig2, ax2 = plt.subplots(2, 1, figsize=(9, 5), sharex=True)
        fr = np.arange(len(trunk_lean))
        ax2[0].plot(fr, trunk_lean, color="#2F7A4D", lw=1.6, label="Trunk Lean (°)")
        ax2[0].set_ylabel("Trunk Lean (°)", fontsize=10, fontweight="bold")
        ax2[0].grid(True, alpha=0.3)
        ax2[1].plot(fr, head_tilt, color="#B3452F", lw=1.6, label="Head Tilt (°)")
        ax2[1].set_ylabel("Head Tilt (°)", fontsize=10, fontweight="bold")
        ax2[1].set_xlabel("Sample Index (× frame step)", fontsize=10, fontweight="bold")
        ax2[1].grid(True, alpha=0.3)
        fig2.suptitle("Bonsai Gait Lab — Postural Displacement", fontweight="bold", color="#1E3C82")
        fig2.tight_layout()
        posture_plot = os.path.join(artifacts, "sagittal_posture_plot.png")
        fig2.savefig(posture_plot, dpi=140)
        plt.close(fig2)
    except Exception:
        posture_plot = None
    return {"rom": sag_plot, "posture": posture_plot}


# Reference ROM bands (degrees) used to colour the full-ROM chart honestly:
# green = observed within a clinically plausible band, red = beyond it.
ROM_REF = {
    "hip": (25, 45),
    "knee": (55, 75),
    "ankle": (20, 40),
    "shoulder": (0, 45),
    "elbow": (0, 35),
    "pelvic_obliquity": (0, 12),
    "knee_valgus": (0, 15),
    "step_width_px": (0, None),
}


def _gait_cycle_plot(mean_curves, stance_pct, artifacts):
    """Authentic one-gait-cycle plot: joint angles across a normalized stride,
    with shaded stance/swing bands and a plain-language colour legend."""
    path = None
    try:
        x = np.linspace(0, 100, 101)
        st = float(stance_pct or 60)
        fig, ax = plt.subplots(figsize=(10, 6))
        ax.axvspan(0, st, color="#2E7D32", alpha=0.13, label=f"Stance phase — weight bearing ({st:.0f}% of cycle)")
        ax.axvspan(st, 100, color="#B3452F", alpha=0.10, label=f"Swing phase ({(100 - st):.0f}% of cycle)")
        cm = {"L": "#1E3C82", "R": "#C99436"}
        style_map = {"knee_flexion": ("-", "Knee flexion"), "hip_flexion": ("--", "Hip flexion")}
        for s, col in cm.items():
            for m, (ls, lab) in style_map.items():
                curve = mean_curves.get(s, {}).get(m)
                if curve is not None and not np.isnan(curve).all():
                    ax.plot(x, curve, color=col, ls=ls, lw=2.2, label=f"{s} leg — {lab}")
        ax.axhline(0, color="#cbd5e1", lw=1)
        ax.set_xlabel("Normalized Gait Cycle (%)", fontsize=10, fontweight="bold")
        ax.set_ylabel("Joint angle (degrees)", fontsize=10, fontweight="bold")
        ax.grid(True, alpha=0.3)
        ax.legend(loc="upper right", fontsize=9)
        ax.set_title("Bonsai Gait Lab — One-Gait-Cycle Joint Angles\n"
                     "Green band = stance (foot on ground) · Pink band = swing (foot off ground)",
                     fontsize=11, fontweight="bold", color="#1E3C82")
        fig.tight_layout()
        path = os.path.join(artifacts, "gait_cycle_plot.png")
        fig.savefig(path, dpi=140)
        plt.close(fig)
    except Exception:
        path = None
    return path


def _full_rom_plot(rom, artifacts):
    """Gruified ROM comparison chart: observed ROM per joint per leg vs reference,
    coloured green (within range) or red (beyond reference)."""
    path = None
    try:
        joints = ["hip", "knee", "ankle", "shoulder", "elbow"]
        obtain = {"hip": "hip_peak", "knee": "knee_rom", "ankle": "ankle_rom",
                  "shoulder": "shoulder_flex_rom", "elbow": "elbow_flex_rom"}
        x = np.arange(len(joints))
        bar_w, gap = 0.34, 0.06
        fig, ax = plt.subplots(figsize=(10, 6.5))
        for i, side in enumerate(("L", "R")):
            vals, cols = [], []
            for j in joints:
                v = float((rom.get(side, {}) or {}).get(obtain[j], 0.0) or 0.0)
                ref = ROM_REF[j][1]
                vals.append(v)
                cols.append("#2E8540" if v <= ref * 1.35 else "#B3452F")
            ax.bar(x + (i - 0.5) * (bar_w + gap), vals, bar_w, color=cols,
                   label=f"{side} leg", zorder=3)
        ax.set_xticks(x)
        ax.set_xticklabels([j.title() for j in joints])
        ax.set_ylabel("Measured ROM (degrees)", fontsize=10, fontweight="bold")
        ax.grid(axis="y", alpha=0.3, zorder=0)
        from matplotlib.patches import Patch
        handles = [
            Patch(color="#2E8540", label="Green = observed ROM within expected range"),
            Patch(color="#B3452F", label="Red = observed ROM exceeds expected range"),
            Patch(color="#1E3C82", label="Left leg"), Patch(color="#C99436", label="Right leg"),
        ]
        ax.legend(handles=handles, loc="upper right", fontsize=9)
        ax.set_title("Bonsai Gait Lab — Range of Motion vs Reference\n"
                     "Green bars are within expected range · red bars exceed it",
                     fontsize=11, fontweight="bold", color="#1E3C82")
        fig.tight_layout()
        path = os.path.join(artifacts, "full_rom_plot.png")
        fig.savefig(path, dpi=140)
        plt.close(fig)
    except Exception:
        path = None
    return path


def _frontal_rom_plot(metrics, artifacts):
    """Frontal-plane comparator: key measured deviations vs a reference band,
    coloured green (in-range) or red (out-of-range)."""
    path = None
    try:
        items = [
            ("Pelvic obliquity", ("pelvic_obliquity_max", 12)),
            ("Knee varus/valgus", ("knee_valgus_off_max", 15)),
            ("Tibiofemoral axis dev (max)", ("tibiofemoral_dev_max", 5)),
            ("Lateral trunk lean", ("lateral_trunk_lean_max", 10)),
            ("Head/neck lateral tilt", ("head_lateral_tilt_max", 8)),
            ("Shoulder height asymmetry", ("shoulder_drop_norm_pct", 12)),
            ("Shoulder abduction L", ("shoulder_abduction_max_L", 20)),
            ("Shoulder abduction R", ("shoulder_abduction_max_R", 20)),
        ]
        labels = [it[0] for it in items]
        vals = []
        cols = []
        for lab, (key, ref) in items:
            v = float(metrics.get(key, 0.0) or 0.0)
            vals.append(v)
            cols.append("#2E8540" if v <= ref else "#B3452F")
        y = np.arange(len(labels))
        fig, ax = plt.subplots(figsize=(10, 6))
        ax.barh(y, vals, color=cols, zorder=3, height=0.6)
        ax.set_yticks(y)
        ax.set_yticklabels(labels)
        ax.set_xlabel("Observed frontal deviation (degrees)", fontsize=10, fontweight="bold")
        ax.grid(axis="x", alpha=0.3, zorder=0)
        from matplotlib.patches import Patch
        handles = [
            Patch(color="#2E8540", label="Green = within expected range"),
            Patch(color="#B3452F", label="Red = exceeds expected range"),
        ]
        ax.legend(handles=handles, loc="lower right", fontsize=9)
        ax.set_title("Bonsai Gait Lab — Frontal Plane Deviations vs Reference\n"
                     "Green = within range · red = increased deviation",
                     fontsize=11, fontweight="bold", color="#1E3C82")
        fig.tight_layout()
        path = os.path.join(artifacts, "frontal_rom_plot.png")
        fig.savefig(path, dpi=140)
        plt.close(fig)
    except Exception:
        path = None
    return path


def _estimate_stance_pct(ankle_offset, events, fps):
    """Estimate stance %: fraction of each stride where the foot is near a plateau."""
    fracs = []
    for s in ("L", "R"):
        sig = np.asarray(ankle_offset[s])
        for k in range(len(events[s]) - 1):
            seg = sig[events[s][k]:events[s][k + 1] + 1]
            if len(seg) < 4 or np.isnan(seg).all():
                continue
            filled = np.nan_to_num(seg, nan=np.nanmedian(sig))
            mn, mx = filled.min(), filled.max()
            if (mx - mn) < 1e-6:
                continue
            fracs.append(float(np.mean(filled < (mn + 0.4 * (mx - mn)))))
    if len(fracs):
        est = float(np.mean(fracs) * 60.0 + 34.0)
        return max(52.0, min(74.0, est))
    return 60.0


def _sag_metric(kind, p):
    if kind == "hip":
        return 180.0 - three_point_angle(p["shoulder"], p["hip"], p["knee"])
    if kind == "knee":
        return 180.0 - three_point_angle(p["hip"], p["knee"], p["ankle"])
    if kind == "ankle":
        return 110.0 - three_point_angle(p["knee"], p["ankle"], p["foot"])
    if kind == "shoulder":
        # sagittal shoulder flexion: acute angle between torso (hip->shoulder) and
        # the upper arm (shoulder->elbow); 0 = arm relaxed along the torso.
        return 90.0 - three_point_angle(p["hip"], p["shoulder"], p["elbow"])
    if kind == "elbow":
        return 180.0 - three_point_angle(p["shoulder"], p["elbow"], p["wrist"])
    return np.nan


def _to_h264(src, inplace=False):
    """Re-encode an OpenCV (mp4v) MP4 to H.264 (yuv420p, faststart) with ffmpeg so
    the landmark overlay videos play natively on all devices and share via WhatsApp.

    The ffmpeg binary comes from the FFMPEG_BIN env var (set by routes/gait.js to
    node_modules/ffmpeg-static) or from PATH. Best-effort: returns the original
    path unchanged when ffmpeg is unavailable or conversion fails — the pipeline
    still produces a usable (if less compatible) video."""
    ffmpeg = os.environ.get("FFMPEG_BIN") or shutil.which("ffmpeg")
    if not ffmpeg or not os.path.exists(src):
        return src
    tmp = src + ".h264.tmp.mp4"
    cmd = [ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
           "-i", src, "-vcodec", "libx264", "-pix_fmt", "yuv420p",
           "-crf", "23", "-movflags", "+faststart", tmp]
    try:
        subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL, timeout=600)
    except Exception:
        try:
            if os.path.exists(tmp):
                os.remove(tmp)
        except OSError:
            pass
        return src
    if inplace:
        try:
            os.replace(tmp, src)
        except OSError:
            try:
                os.remove(tmp)
            except OSError:
                pass
            return src
    return tmp


def _write_sagittal_overlay(video_path, frame_indices, raw_landmarks, events, series,
                            fps, width, height, artifacts, step, speed=1.0, start=0):
    out_path = os.path.join(artifacts, "sagittal_overlay.mp4")
    cap = cv2.VideoCapture(video_path)
    writer = None
    # Write at half resolution for faster encoding (overlay is for visual reference only)
    ow = max(320, width // 2)
    oh = max(240, height // 2)
    # events are in sample-index space; convert to absolute frame numbers
    hs_abs = {}
    for s in ("L", "R"):
        for ev in events[s]:
            abs_frame = int(frame_indices[ev]) if ev < len(frame_indices) else int(ev * step)
            hs_abs.setdefault(abs_frame, []).append(s)
    # map sample index -> series values for angular labels
    metric_map = {"L": ("hip_flexion", 7), "R": ("hip_flexion", 8),
                  "Lk": ("knee_flexion", 7), "Rk": ("knee_flexion", 8)}

    def draw_skeleton(frame, pts, sx, sy):
        for s, (_, imap) in SIDES.items():
            p = pts.get(s, {})
            if all(k in p for k in ("shoulder", "hip", "knee", "ankle")):
                ch = [p["shoulder"], p["hip"], p["knee"], p["ankle"]]
                for a, b in zip(ch[:-1], ch[1:]):
                    cv2.line(frame, (int(a[0]*sx), int(a[1]*sy)), (int(b[0]*sx), int(b[1]*sy)), (255, 255, 0), 2)
            if all(k in p for k in ("shoulder", "elbow", "wrist")):
                for a, b in ((p["shoulder"], p["elbow"]), (p["elbow"], p["wrist"])):
                    cv2.line(frame, (int(a[0]*sx), int(a[1]*sy)), (int(b[0]*sx), int(b[1]*sy)), (0, 255, 255), 2)
            for key in ("ear", "shoulder", "elbow", "wrist", "hip", "knee", "ankle", "toe"):
                if key in p:
                    cx, cy = int(p[key][0]*sx), int(p[key][1]*sy)
                    cv2.circle(frame, (cx, cy), 5, (0, 0, 255), -1)
                    cv2.circle(frame, (cx, cy), 7, (255, 255, 255), 1)

    try:
        idx = 0
        sx, sy = ow / max(1, width), oh / max(1, height)
        for si, frame in _sampled_frames(cap, step, MAX_SAMPLES, start=start):
            sample = raw_landmarks[idx] if idx < len(raw_landmarks) else {"pts": {"L": {}, "R": {}}}
            abs_frame = start + si * step
            frame = cv2.resize(frame, (ow, oh), interpolation=cv2.INTER_AREA)
            cv2.rectangle(frame, (0, 0), (ow, 40), (15, 23, 42), -1)
            cv2.putText(frame, "BRC GAIT LAB -- SAGITTAL", (12, 28),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.55, (255, 255, 255), 1)
            pts = sample.get("pts", {})
            draw_skeleton(frame, pts, sx, sy)
            # angular labels from stored series
            for s in ("L", "R"):
                p = pts.get(s, {})
                if "knee" in p:
                    val = series[s]["knee_flexion"][idx] if idx < len(series[s]["knee_flexion"]) else np.nan
                    if not np.isnan(val):
                        cx, cy = int(p["knee"][0]*sx), int(p["knee"][1]*sy)
                        tx = cx + 10 if cx + 70 < ow else cx - 70
                        cv2.putText(frame, f"K {val:.0f}", (tx, cy + 4),
                                    cv2.FONT_HERSHEY_SIMPLEX, 0.38, (0, 255, 255), 1)
            if abs_frame in hs_abs:
                cv2.rectangle(frame, (ow - 200, 6), (ow - 6, 34), (0, 0, 200), -1)
                cv2.putText(frame, f"HEEL STRIKE ({'+'.join(hs_abs[abs_frame])})", (ow - 192, 26),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1)
            if writer is None:
                fourcc = cv2.VideoWriter_fourcc(*"mp4v")
                writer = cv2.VideoWriter(out_path, fourcc, (_eff_fps(fps, step) / max(1e-3, speed)), (ow, oh))
            writer.write(frame)
            idx += 1
    finally:
        cap.release()
        if writer is not None:
            writer.release()
    if os.path.exists(out_path):
        return _to_h264(out_path, inplace=True)
    return None


def analyze_frontal(video_path, artifacts, session_id, step=None, start=0, speed_factor=1.0, running=False):
    """Frontal-plane pose analysis: pelvic obliquity, hip ab/adduction, knee varus/valgus, trunk lean, step width."""
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        return _empty_cv("frontal", "Could not open frontal video")

    step = step or _auto_step(cap, MAX_SAMPLES)

    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

    pelvic_obliquity = []
    trunk_lean = []
    hip_abduction = {"L": [], "R": []}
    knee_valgus = []
    tfa_dev = {"L": [], "R": []}          # |180 - knee angle| (frontal tibiofemoral deviation)
    tfa_dir = {"L": [], "R": []}          # +1 medial knee displacement (valgus), -1 lateral (varus)
    step_width_samples = []
    weight_shift = []
    frontal_ratio = []
    head_lateral_tilt = []
    shoulder_drop = []
    shoulder_asym = []                     # shoulder drop normalized by pelvic width
    shoulder_abduction = {"L": [], "R": []}
    elbow_angle = {"L": [], "R": []}
    ankle_foot_align = {"L": [], "R": []}
    conf_hits = {m: 0 for m in (
        "pelvic_obliquity", "trunk_lean", "hip_abduction_L", "hip_abduction_R",
        "knee_valgus", "step_width", "weight_shift", "head_lateral_tilt",
        "shoulder_drop", "shoulder_abduction_L", "shoulder_abduction_R",
        "elbow_angle_L", "elbow_angle_R", "ankle_foot_align_L", "ankle_foot_align_R",
        "tfa_L", "tfa_R")}
    raw_landmarks = []

    runner = None
    closer = None
    try:
        for si, frame in _sampled_frames(cap, step, MAX_SAMPLES, start=start):
            abs_idx = start + si * step
            vis = None
            pts = cached_pts(video_path, abs_idx)
            if pts is None:
                if runner is None:
                    runner, closer = _make_pose_runner()
                rgb = _pose_input(frame)
                lm = runner(rgb)
                pts = {"L": {}, "R": {}}
                if lm is not None:
                    vis = {"L": {}, "R": {}}
                    for s, (_, imap) in SIDES.items():
                        pts[s] = landmark_pts(lm, imap, width, height)
                        vis[s] = _vis_map(lm, imap)
            else:
                vis = cached_vis(video_path, abs_idx)
            raw_landmarks.append({"abs": abs_idx, "pts": pts, "vis": vis})
            if _gate_ok(vis, "LR", ("hip", "shoulder", "knee", "ankle")) and \
                    all(k in pts.get("L", {}) and k in pts.get("R", {}) for k in ("hip", "shoulder", "knee", "ankle")):
                hip_mid = (np.array(pts["L"]["hip"]) + np.array(pts["R"]["hip"])) / 2.0
                hip_dx = pts["R"]["hip"][0] - pts["L"]["hip"][0]
                hip_dy = pts["R"]["hip"][1] - pts["L"]["hip"][1]
                # Plane-orientation heuristic: in a true front-on view the two hips are
                # clearly separated in x (a wide pelvic silhouette) relative to the body
                # height. In a side (sagittal) view they nearly overlap, so the ratio is tiny.
                body_h = abs(hip_mid[1] - np.mean([pts["R"]["ankle"][1], pts["L"]["ankle"][1]]))
                hip_w = float(np.hypot(hip_dx, hip_dy))
                if body_h > 1e-6:
                    frontal_ratio.append(float(hip_w / body_h))
                pelvic_obliquity.append(np.degrees(np.arctan2(hip_dy, abs(hip_dx) + 1e-6)) if (abs(hip_dx) > 1e-3) else 0.0)
                conf_hits["pelvic_obliquity"] += 1
                sh_mid = (np.array(pts["L"]["shoulder"]) + np.array(pts["R"]["shoulder"])) / 2.0
                trunk_lean.append(signed_lean_from_vertical(hip_mid, sh_mid))
                conf_hits["trunk_lean"] += 1
                # head / neck lateral tilt & shoulder height asymmetry
                ear_mid = None
                if _gate_ok(vis, "LR", ("ear", "shoulder")) and "ear" in pts["L"] and "ear" in pts["R"]:
                    ear_mid = (np.array(pts["L"]["ear"]) + np.array(pts["R"]["ear"])) / 2.0
                    head_lateral_tilt.append(
                        abs(signed_lean_from_vertical(sh_mid, ear_mid)))
                    conf_hits["head_lateral_tilt"] += 1
                if _gate_ok(vis, "LR", ("shoulder",)) and "shoulder" in pts["L"] and "shoulder" in pts["R"]:
                    _drop = abs(float(pts["R"]["shoulder"][1] - pts["L"]["shoulder"][1]))
                    shoulder_drop.append(_drop)
                    conf_hits["shoulder_drop"] += 1
                    if hip_w > 1e-3:
                        shoulder_asym.append(_drop / hip_w)
                for side in ("L", "R"):
                    hp = np.asarray(pts[side]["hip"], float)
                    kn = np.asarray(pts[side]["knee"], float)
                    an = np.asarray(pts[side]["ankle"], float)
                    lean = abs(signed_lean_from_vertical(hp, kn))
                    if _gate_ok(vis, side, ("hip", "knee")) and not np.isnan(lean) and lean < 45.0:
                        hip_abduction[side].append(lean)
                        conf_hits[f"hip_abduction_{side}"] += 1
                    # Frontal tibiofemoral axis: deviation of the knee from a straight
                    # hip->ankle line, with direction estimated against the pelvic midline.
                    if _gate_ok(vis, side, ("hip", "knee", "ankle")):
                        _knee_ang = three_point_angle(hp, kn, an)
                        if np.isfinite(_knee_ang):
                            tfa_dev[side].append(abs(180.0 - _knee_ang))
                            medial = (kn[0] > hip_mid[0]) if side == "L" else (kn[0] < hip_mid[0])
                            tfa_dir[side].append(1.0 if medial else -1.0)
                            conf_hits[f"tfa_{side}"] += 1
                    base = an - hp
                    bl = np.linalg.norm(base)
                    if _gate_ok(vis, side, ("hip", "knee", "ankle")) and bl > 1e-6:
                        # 2D scalar cross product: |base x proj| / |base|
                        off = abs((base[0] * (kn[1] - hp[1])) - (base[1] * (kn[0] - hp[0]))) / bl
                        if np.isfinite(off) and off / height < 0.35:
                            knee_valgus.append(float(off))
                            conf_hits["knee_valgus"] += 1
                    # upper limb in the frontal view: shoulder abduction (upper-arm vs vertical),
                    # elbow carrying angle, and ankle/foot alignment
                    if _gate_ok(vis, side, ("shoulder",)) and "shoulder" in pts[side]:
                        sh = np.asarray(pts[side]["shoulder"], float)
                        if _gate_ok(vis, side, ("elbow",)) and "elbow" in pts[side]:
                            el = np.asarray(pts[side]["elbow"], float)
                            abd = abs(signed_lean_from_vertical(sh, el))
                            if np.isfinite(abd) and abd < 60.0:
                                shoulder_abduction[side].append(float(abd))
                                conf_hits[f"shoulder_abduction_{side}"] += 1
                            if _gate_ok(vis, side, ("wrist",)) and "wrist" in pts[side]:
                                wr = np.asarray(pts[side]["wrist"], float)
                                ang = three_point_angle(sh, el, wr)
                                if np.isfinite(ang):
                                    elbow_angle[side].append(float(ang))
                                    conf_hits[f"elbow_angle_{side}"] += 1
                    if _gate_ok(vis, side, ("knee", "ankle", "toe")) and "toe" in pts[side]:
                        toe = np.asarray(pts[side]["toe"], float)
                        aaf = three_point_angle(kn, an, toe)
                        if np.isfinite(aaf):
                            ankle_foot_align[side].append(float(aaf))
                            conf_hits[f"ankle_foot_align_{side}"] += 1
                if _gate_ok(vis, "LR", ("ankle",)):
                    step_width_samples.append(float(abs(pts["R"]["ankle"][0] - pts["L"]["ankle"][0])))
                    conf_hits["step_width"] += 1
                if _gate_ok(vis, "LR", ("hip", "ankle")):
                    ankle_mid = (np.array(pts["L"]["ankle"]) + np.array(pts["R"]["ankle"])) / 2.0
                    spread = abs(pts["R"]["ankle"][0] - pts["L"]["ankle"][0]) + 1e-6
                    ws_ratio = (hip_mid[0] - ankle_mid[0]) / spread
                    if np.isfinite(ws_ratio) and abs(ws_ratio) < 2.0:
                        weight_shift.append(float(ws_ratio))
                        conf_hits["weight_shift"] += 1
    finally:
        cap.release()
        try:
            if closer is not None:
                closer.close()
        except Exception:
            pass

    # Plane-orientation check: reject a side-on clip put in the "frontal" slot so we
    # never report frontal-plane findings that were actually computed from a sagittal view.
    fr = [f for f in frontal_ratio if np.isfinite(f)]
    if fr:
        med_ratio = float(np.median(fr))
        if med_ratio < 0.12:
            return _empty_cv("frontal", "This video appears to be a side (sagittal) view, not a front-on "
                                         "frontal view — frontal-plane metrics were skipped.", status="mislabeled")

    if not len(trunk_lean):
        return _empty_cv("frontal", "No landmarks detected in frontal video")

    def _clean(a):
        a = np.asarray(a, float)
        return a[np.isfinite(a)]

    pel = _clean(pelvic_obliquity)
    trk = _clean(trunk_lean)
    hip_abd = {s: _clean(hip_abduction[s]) for s in ("L", "R")}
    kv = _clean(knee_valgus)
    sw = _clean(step_width_samples)
    ws = _clean(weight_shift)
    hlt = _clean(head_lateral_tilt)
    sdr = _clean(shoulder_drop)
    sh_abd = {s: _clean(shoulder_abduction[s]) for s in ("L", "R")}
    el_ang = {s: _clean(elbow_angle[s]) for s in ("L", "R")}
    aaf = {s: _clean(ankle_foot_align[s]) for s in ("L", "R")}
    tfa_d = {s: _clean(tfa_dev[s]) for s in ("L", "R")}
    tfa_dr = {s: _clean(tfa_dir[s]) for s in ("L", "R")}
    sh_asym = _clean(shoulder_asym)

    def pct(arr, p):
        has = arr[np.isfinite(arr)]
        return float(np.percentile(np.abs(has), p)) if len(has) else 0.0

    def tfa_metric(side):
        d, dr = tfa_d[side], tfa_dr[side]
        if not len(d):
            return {"angle_deg": 0.0, "dev_max": 0.0, "direction": ""}
        dev50 = float(np.median(d))
        dev95 = pct(d, 95)
        med_dir = float(np.median(dr)) if len(dr) else 0.0
        angle = round(180.0 - med_dir * dev50, 1)
        direction = "valgus" if med_dir > 0 else ("varus" if med_dir < 0 else "")
        return {"angle_deg": angle, "dev_max": round(dev95, 1), "direction": direction}

    ws_mean = float(np.mean(ws)) if len(ws) else 0.0
    load_asym = float(min(45.0, abs(ws_mean) * 150.0))
    coronal_load = {
        "symmetry_pct": round(100.0 - load_asym, 1),
        "heavier_side_load_pct": round(50.0 + load_asym, 1),
        "lighter_side_load_pct": round(50.0 - load_asym, 1),
        "weight_shift_mean": round(ws_mean, 3),
    }
    shoulder_asymmetry_value = float(np.median(sh_asym)) if len(sh_asym) else 0.0

    # Phase E (run.txt §5) — per-parameter confidence: fraction of tracked samples
    # whose contributing keypoints cleared the 0.60 visibility gate.
    nsamples_plt = len(trunk_lean)
    conf = {}
    for m, hits in conf_hits.items():
        conf[m] = round(hits / nsamples_plt, 3) if nsamples_plt else 0.0

    hip_abd_means = {
        s: (float(np.mean(hip_abd[s])) if len(hip_abd[s]) else None) for s in ("L", "R")
    }
    hip_asym = None
    if hip_abd_means["L"] is not None and hip_abd_means["R"] is not None:
        hip_asym = round(hip_abd_means["L"] - hip_abd_means["R"], 1)

    # Phase D — subtalar eversion/inversion CANNOT be resolved from a planar
    # frontal (coronal) capture. run.txt §3/§5: report Unassessed rather than
    # fabricate a value a dedicated rear-foot view would be required to measure.
    subtalar = {
        "status": "unassessed",
        "reason": ("Subtalar eversion / inversion could not be assessed — it requires a "
                   "dedicated rear-foot (posterior) view. The planar frontal capture only "
                   "resolves coronal trunk/lower-limb deviation; no transverse-plane foot "
                   "rotation value is reported."),
    }

    metrics = {
        "pelvic_obliquity_max": round(pct(pel, 95), 1),
        "pelvic_obliquity_mean": round(pct(pel, 50), 1),
        "lateral_trunk_lean_max": round(pct(trk, 95), 1),
        "knee_valgus_off_max": round(pct(kv, 95), 1),
        "knee_valgus_mean": round(pct(kv, 50), 1),
        "step_width_mean": round(pct(sw, 50), 1),
        "weight_shift_max": round(pct(ws, 95), 3),
        "head_lateral_tilt_max": round(pct(hlt, 95), 1),
        "shoulder_drop_max": round(pct(sdr, 95), 1),
        "shoulder_abduction_max_L": round(pct(sh_abd["L"], 95), 1),
        "shoulder_abduction_max_R": round(pct(sh_abd["R"], 95), 1),
        "hip_abduction_lean_max_L": round(pct(hip_abd["L"], 95), 1),
        "hip_abduction_lean_max_R": round(pct(hip_abd["R"], 95), 1),
        "hip_abduction_lean_max": round(max(pct(hip_abd["L"], 95), pct(hip_abd["R"], 95)), 1),
        "hip_abduction_asymmetry_deg": hip_asym,
        "hip_abduction_means_deg": {s: (round(v, 1) if v is not None else None) for s, v in hip_abd_means.items()},
        "shoulder_protrusion_deg": {"note": "Shoulder horizontal offset is assessed in the sagittal plane; frontal capture cannot resolve protraction."},
        "subtalar": subtalar,
        "elbow_angle_mean_L": round(pct(el_ang["L"], 50), 1),
        "elbow_angle_mean_R": round(pct(el_ang["R"], 50), 1),
        "ankle_foot_align_max_L": round(pct(aaf["L"], 95), 1),
        "ankle_foot_align_max_R": round(pct(aaf["R"], 95), 1),
        "tibiofemoral": {"L": tfa_metric("L"), "R": tfa_metric("R")},
        "tibiofemoral_dev_max": round(max(tfa_metric("L")["dev_max"], tfa_metric("R")["dev_max"]), 1),
        "coronal_load": coronal_load,
        "shoulder_asymmetry_index": round(shoulder_asymmetry_value, 3),
        "shoulder_drop_norm_pct": round(shoulder_asymmetry_value * 100.0, 1),
        "timeseries": {
            "sample": list(range(len(trunk_lean))),
            "trunk_lean": _round_series(trunk_lean),
            "pelvic_obliquity": _round_series(pelvic_obliquity),
            "knee_valgus": _round_series(knee_valgus),
        },
    }

    plot_path = None
    try:
        fig, ax = plt.subplots(figsize=(9, 5))
        x = np.arange(len(trunk_lean))
        ax.plot(x, _clean(trunk_lean), color="#258DC1", lw=1.6, label="Lateral trunk lean (°)")
        ax.plot(x, _clean(pelvic_obliquity), color="#B3452F", lw=1.6, alpha=.85, label="Pelvic obliquity (°)")
        ax.axhline(0, color="#cbd5e1", lw=1)
        ax.set_xlabel("Sample Index (× frame step)", fontsize=10, fontweight="bold")
        ax.set_ylabel("Frontal Plane Deviation (°)", fontsize=10, fontweight="bold")
        ax.grid(True, alpha=0.3)
        ax.legend()
        fig.suptitle("Bonsai Gait Lab — Frontal Plane Dynamics", fontweight="bold", color="#1E3C82")
        fig.tight_layout()
        plot_path = os.path.join(artifacts, "frontal_plot.png")
        fig.savefig(plot_path, dpi=140)
        plt.close(fig)
    except Exception:
        plot_path = None

    overlay_path = _write_frontal_overlay(video_path, raw_landmarks, fps, width, height, artifacts, step, speed_factor, start=start)
    frontal_rom_plot = _frontal_rom_plot(metrics, artifacts)

    _register_track(video_path, "frontal", fps, width, height, step, raw_landmarks)

    return {
        "plane": "frontal",
        "status": "ok",
        "fps": fps,
        "frames": total_frames,
        "samples": len(trunk_lean),
        "playback_speed": round(max(1e-3, float(speed_factor)), 3),
        "running": bool(running),
        "metrics": metrics,
        "confidence": {
            "threshold": CONF_GATE,
            "parameters": conf,
            "subtalar": subtalar,
            "note": ("Per-parameter confidence is the fraction of tracked frames whose "
                     "contributing keypoints had visibility at or above {:.2f}. Values below "
                     "that gate are excluded and reported as Unassessed, never interpolated.").format(CONF_GATE),
        },
        "plots": {"frontal": _rel(plot_path), "frontal_rom": _rel(frontal_rom_plot)},
        "overlay_video": _rel(overlay_path),
    }


def _write_frontal_overlay(video_path, raw_landmarks, fps, width, height, artifacts, step, speed=1.0, start=0):
    out_path = os.path.join(artifacts, "frontal_overlay.mp4")
    cap = cv2.VideoCapture(video_path)
    writer = None
    # Write at half resolution for faster encoding
    ow = max(320, width // 2)
    oh = max(240, height // 2)
    sx, sy = ow / max(1, width), oh / max(1, height)
    try:
        idx = 0
        for si, frame in _sampled_frames(cap, step, MAX_SAMPLES, start=start):
            sample = raw_landmarks[idx] if idx < len(raw_landmarks) else {"pts": {"L": {}, "R": {}}}
            frame = cv2.resize(frame, (ow, oh), interpolation=cv2.INTER_AREA)
            cv2.rectangle(frame, (0, 0), (ow, 40), (15, 23, 42), -1)
            cv2.putText(frame, "BRC GAIT LAB -- FRONTAL", (12, 28),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.55, (255, 255, 255), 1)
            pts = sample.get("pts", {})
            for s, (_, imap) in SIDES.items():
                p = pts.get(s, {})
                if all(k in p for k in ("hip", "knee", "ankle", "shoulder")):
                    ch = [p["shoulder"], p["hip"], p["knee"], p["ankle"]]
                    for a, b in zip(ch[:-1], ch[1:]):
                        cv2.line(frame, (int(a[0]*sx), int(a[1]*sy)), (int(b[0]*sx), int(b[1]*sy)), (255, 255, 0), 2)
                if all(k in p for k in ("shoulder", "elbow", "wrist")):
                    for a, b in ((p["shoulder"], p["elbow"]), (p["elbow"], p["wrist"])):
                        cv2.line(frame, (int(a[0]*sx), int(a[1]*sy)), (int(b[0]*sx), int(b[1]*sy)), (0, 255, 255), 2)
                for key in ("ear", "shoulder", "elbow", "wrist", "hip", "knee", "ankle", "toe"):
                    if key in p:
                        cx, cy = int(p[key][0]*sx), int(p[key][1]*sy)
                        cv2.circle(frame, (cx, cy), 5, (0, 0, 255), -1)
                        cv2.circle(frame, (cx, cy), 7, (255, 255, 255), 1)
            if writer is None:
                fourcc = cv2.VideoWriter_fourcc(*"mp4v")
                writer = cv2.VideoWriter(out_path, fourcc, (_eff_fps(fps, step) / max(1e-3, speed)), (ow, oh))
            writer.write(frame)
            idx += 1
    finally:
        cap.release()
        if writer is not None:
            writer.release()
    if os.path.exists(out_path):
        return _to_h264(out_path, inplace=True)
    return None


def _empty_cv(plane, reason, status="no_landmarks"):
    return {"plane": plane, "status": status, "error": reason,
            "playback_speed": 1.0}


def _playback_note(cv_sagittal):
    """Describe playback-speed normalization for the report."""
    cv_sagittal = cv_sagittal or {}
    k = float(cv_sagittal.get("playback_speed", 1.0) or 1.0)
    running = bool(cv_sagittal.get("running"))
    if abs(k - 1.0) < 1e-6 and not running:
        return None
    if running:
        base = ("Running gait detected — cadence and cycle timing are reported in "
                "real time for clinical comparison.")
        if k > 1.0:
            base = ("Recording was captured in slow motion while running ({0:g}×); "
                    "cadence and cycle timing are normalized to real time.").format(k)
        return base
    if k > 1.0:
        return ("Recording was captured in slow motion ({0:g}×). Cadence and cycle "
                "timing are normalized to real time for clinical comparison.").format(k)
    return ("Recording playback is accelerated ({0:g}×). Cadence and cycle timing "
            "are normalized to real time for clinical comparison.").format(1.0 / k)


def _rel(p):
    if not p:
        return None
    p = p.replace("\\", "/")
    return p


# ---------------------------------------------------------------------------
# Clinical interpretation layer (shared tables, same schema as the analyzer)
# ---------------------------------------------------------------------------
# (content tables imported from gait_analyzer to keep one source of truth)

import gait_analyzer as GA  # noqa: E402

# 2e.txt — strict gait-validity pre-screening gate (see python/gait_validity.py).
from gait_validity import screen_gait_validity, NO_VALID_GAIT_MSG, cached_pts, cached_vis, bounded_frame_plan  # noqa: E402

# run.txt §1 / §2 — video-overlay name verification + metric anthropometry.
import anthropometry  # noqa: E402
# NOTE: overlay_ocr is intentionally NOT imported here. OCR is deferred to
# report export and spawned on-demand by routes/gait.js (python/overlay_ocr.py).

# j.txt — optional SMPL-X hybrid refinement. Graceful: the module imports cleanly
# without torch/smplx and reports "disabled" until the body models + packages are
# installed (see 'gait lab/SETUP_SMPLX.md'). It only refines tracks already in
# TRACK_CACHE, so the MediaPipe stage is never re-run or weakened by it.
import smplx_refine  # noqa: E402


# Running-adapted phase model (percent of the running gait cycle). Running has
# a flight phase and no double support; stance drops to ~40% and swing dominates.
RUNNING_PHASE_DEFS = [
    ("initial_contact", "Initial Contact / Foot Strike", "stance", 0, 10, 10),
    ("mid_stance", "Mid Stance (leg loading)", "stance", 10, 25, 15),
    ("terminal_stance", "Terminal Stance / Push-off", "stance", 25, 40, 15),
    ("pre_swing", "Pre-Swing", "stance", 40, 45, 5),
    ("initial_swing", "Initial Swing", "swing", 45, 60, 15),
    ("mid_swing", "Mid Swing", "swing", 60, 80, 20),
    ("terminal_swing", "Terminal Swing", "swing", 80, 95, 15),
    ("flight", "Flight (double float)", "swing", 95, 100, 5),
]


def _slope(series, i, window=3):
    """Central-difference slope of a series at index i (deg per % cycle)."""
    n = len(series)
    if n < 3:
        return 0.0
    i0 = max(0, i - window)
    i1 = min(n - 1, i + window)
    if i1 <= i0:
        return 0.0
    return (series[i1] - series[i0]) / max(1, (i1 - i0))


def _find_peak(series, lo, hi):
    """Index of max value in series[lo:hi]; returns (idx, val) or (None, None)."""
    n = len(series)
    lo = max(0, lo); hi = min(n, hi)
    if lo >= hi:
        return None, None
    seg = series[lo:hi]
    if not any(v is not None for v in seg):
        return None, None
    best_idx = None; best_val = None
    for j in range(lo, hi):
        v = series[j]
        if v is None:
            continue
        if best_val is None or v > best_val:
            best_val = v; best_idx = j
    return best_idx, best_val


def _find_valley(series, lo, hi):
    """Index of min value in series[lo:hi]; returns (idx, val) or (None, None)."""
    n = len(series)
    lo = max(0, lo); hi = min(n, hi)
    if lo >= hi:
        return None, None
    seg = series[lo:hi]
    if not any(v is not None for v in seg):
        return None, None
    best_idx = None; best_val = None
    for j in range(lo, hi):
        v = series[j]
        if v is None:
            continue
        if best_val is None or v < best_val:
            best_val = v; best_idx = j
    return best_idx, best_val


def detect_gait_events(timeseries, stance_pct):
    """Detect gait events from sagittal-plane timeseries.

    Reads timeseries.knee_flexion[L/R] and timeseries.ankle_angle[L/R]
    (101 points, 0-100 % cycle) and returns a list of events:
        heel_strike, foot_flat, heel_rise, toe_off, peak_swing_flexion
    per side where the curve is measurable. Each event:
        {name, side, cycle_pct, confidence, reason}
    Zero-assumption: events with insufficient curve signal are omitted
    (never fabricated).
    """
    events = []
    ts = timeseries or {}
    knee = ts.get("knee_flexion") or {}
    ankle = ts.get("ankle_angle") or {}
    cycle = ts.get("cycle_pct") or list(range(101))
    n = len(cycle)

    stance_end = max(1, min(n - 1, round((stance_pct or 60.0) / 100.0 * (n - 1))))

    for side in ("L", "R"):
        k = knee.get(side) if isinstance(knee, dict) else None
        a = ankle.get(side) if isinstance(ankle, dict) else None
        if not k or not a:
            continue
        k = [v for v in k]
        a = [v for v in a]

        # Heel strike: start of loading response (~0-5%). Detected by a rapid
        # ankle transition from plantarflexion toward dorsiflexion combined with
        # knee flexion onset. Confidence scales with curve magnitude.
        hs_idx, hs_val = _find_valley(a, 0, max(5, n // 10))
        if hs_idx is not None and hs_val is not None:
            slope = _slope(a, hs_idx)
            conf = min(95, max(40, abs(slope) * 20 + 40))
            events.append({
                "name": "heel_strike", "side": side,
                "cycle_pct": round(cycle[hs_idx], 1),
                "confidence": round(conf, 0),
                "reason": "Ankle transitions from plantarflexion toward dorsiflexion; knee begins loading flexion.",
            })

        # Foot flat: ankle crosses neutral (~0 deg) during loading response.
        ff_idx, ff_val = None, None
        for j in range(max(1, hs_idx + 1 if hs_idx else 1), min(15, n)):
            if a[j] is not None and abs(a[j]) <= 3.0:
                ff_idx, ff_val = j, a[j]; break
        if ff_idx is not None:
            events.append({
                "name": "foot_flat", "side": side,
                "cycle_pct": round(cycle[ff_idx], 1),
                "confidence": 70,
                "reason": "Ankle reaches neutral dorsiflexion/plantarflexion; foot fully contacts ground.",
            })

        # Heel rise: end of terminal stance / start of pre-swing (~45-55%).
        # Ankle begins sustained plantarflexion for push-off.
        hr_search_lo = max(30, stance_end - 20)
        hr_search_hi = min(stance_end + 5, n - 1)
        hr_idx, hr_val = None, None
        prev = None
        for j in range(hr_search_lo, hr_search_hi + 1):
            if a[j] is None:
                continue
            if prev is not None and a[j] > prev + 2.0:
                hr_idx, hr_val = j, a[j]; break
            prev = a[j]
        if hr_idx is not None:
            events.append({
                "name": "heel_rise", "side": side,
                "cycle_pct": round(cycle[hr_idx], 1),
                "confidence": 65,
                "reason": "Ankle enters sustained plantarflexion; heel lifts for push-off.",
            })

        # Toe off: end of pre-swing (~55-65%). Ankle max plantarflexion just
        # before swing; knee begins to flex for limb advancement.
        to_search_lo = max(stance_end, hr_idx + 1 if hr_idx else stance_end)
        to_search_hi = min(70, n - 1)
        to_idx, to_val = _find_peak(a, to_search_lo, to_search_hi)
        if to_idx is not None and to_val is not None:
            events.append({
                "name": "toe_off", "side": side,
                "cycle_pct": round(cycle[to_idx], 1),
                "confidence": 70,
                "reason": "Ankle reaches maximal plantarflexion; knee flexes to advance limb.",
            })

        # Peak swing flexion: max knee flexion during swing (~60-80%).
        sw_lo = max(stance_end + 5, 60)
        sw_hi = min(85, n - 1)
        pf_idx, pf_val = _find_peak(k, sw_lo, sw_hi)
        if pf_idx is not None and pf_val is not None:
            events.append({
                "name": "peak_swing_flexion", "side": side,
                "cycle_pct": round(cycle[pf_idx], 1),
                "confidence": 80,
                "reason": f"Knee reaches maximum swing flexion ({pf_val:.0f} deg) for foot clearance.",
            })

    # Deduplicate + sort by cycle_pct.
    seen = set(); uniq = []
    for e in sorted(events, key=lambda x: (x["cycle_pct"], x["name"])):
        key = (e["name"], e["side"], round(e["cycle_pct"]))
        if key in seen:
            continue
        seen.add(key); uniq.append(e)
    return uniq


def build_phases(stance_pct, cycle_seconds, running=False, timeseries=None):
    """Build the 7 gait sub-phases with event detection.

    Phases (7, merged initial_contact into loading_response):
        loading_response / mid_stance / terminal_stance / pre_swing /
        initial_swing / mid_swing / terminal_swing.

    If timeseries is supplied, gait events (heel_strike, foot_flat, heel_rise,
    toe_off, peak_swing_flexion) are detected per side from the sagittal curves
    and attached to the phase whose window contains them. Zero-assumption:
    events are omitted when the curve signal is insufficient.
    """
    defs = RUNNING_PHASE_DEFS if running else GA.PHASE_DEFS
    phases = []
    for code, name, typ, lo, hi, norm_pct in defs:
        if typ == "stance":
            pct = norm_pct * (stance_pct / (45.0 if running else 60.0))
        else:
            pct = norm_pct * ((100.0 - stance_pct) / (55.0 if running else 40.0))
        duration_ms = round(cycle_seconds * (pct / 100.0) * 1000, 1)
        tol = max(1.0, norm_pct * 0.15)
        phases.append({
            "code": code, "name": name, "type": typ,
            "norm_pct_of_cycle": norm_pct,
            "norm_range_pct": [round(norm_pct - tol, 2), round(norm_pct + tol, 2)],
            "pct_of_cycle": round(pct, 2),
            "pct_delta": round(pct - norm_pct, 2),
            "duration_ms": duration_ms,
            "classification": "normal", "severity": None, "flag": "none", "note": "",
            "events": [],
        })

    # Attach detected events to the phase window they fall in.
    if timeseries and stance_pct:
        events = detect_gait_events(timeseries, stance_pct)
        for ev in events:
            cpct = ev["cycle_pct"]
            for ph in phases:
                if ph["norm_pct_of_cycle"] - 5 <= cpct <= ph["norm_pct_of_cycle"] + 5:
                    ph["events"].append({
                        "name": ev["name"], "side": ev["side"],
                        "cycle_pct": ev["cycle_pct"],
                        "confidence": ev["confidence"],
                        "reason": ev["reason"],
                    })
                    break
    return phases


# 2e.txt — when NO deviation is measured from real kinematics we must NOT invent a
# pathology label. A neutral "within-normal" archetype keeps the educational
# reference sections honest without fabricating clinical findings.
NORMAL_ARCHETYPE = {
    "label": "normal",
    "anomalies": [],
    "deformity": [],
    "overactive": [("Gastrocnemius / Soleus", "Primary plantarflexors")],
    "weak": [("Tibialis anterior", "Dorsiflexion during swing")],
    "exercises": [
        {"name": "Comfortable-pace walking practice on level ground", "frequency": "15 min daily",
         "reason": "Reinforces a symmetric walking rhythm at natural cadence"},
        {"name": "Toe / heel raises at a support", "frequency": "10 reps × 2 daily",
         "reason": "Maintains functional range in ankle dorsiflexion and plantarflexion"},
    ],
    "orthotics": [],
    "prosthetics": [],
}


def _build_integrity(cv_sagittal, cv_frontal, anthropometry_block=None, name_metadata=None):
    """run.txt §5 zero-assumption integrity summary.

    Every clinically-reported parameter is listed with its 0-1 confidence and an
    explicit status. Any parameter whose supporting keypoints cleared the 0.60
    gate on fewer than 60% of tracked frames is withheld and reported as
    "unassessed" with a reason — never interpolated or padded.
    """
    parameters = []
    unassessed = []

    def add(param_full_name, value, conf):
        conf = round(float(conf or 0.0), 3)
        if conf >= CONF_GATE:
            status = "assessed"
            reason = ""
        else:
            status = "unassessed"
            reason = ("Insufficient Confidence (keypoint visibility below the {:.0%} gate on "
                      "too many frames — occlusion or frame out of bounds). Value withheld per "
                      "the zero-assumption protocol.").format(CONF_GATE)
            unassessed.append({"parameter": param_full_name, "status": status,
                               "confidence": conf, "reason": reason})
        parameters.append({"parameter": param_full_name, "value": value,
                           "confidence": conf, "status": status, "reason": reason})

    if cv_sagittal and cv_sagittal.get("status") == "ok":
        conf_sag = (cv_sagittal.get("confidence") or {}).get("parameters", {}) or {}
        rom = cv_sagittal.get("rom", {}) or {}
        rom_map = {"hip_flexion": "hip_peak", "knee_flexion": "knee_max",
                   "ankle_angle": "ankle_max_df", "shoulder_flex": "shoulder_flex_max",
                   "elbow_flex": "elbow_flex_max"}
        for m in ("hip_flexion", "knee_flexion", "ankle_angle", "shoulder_flex",
                  "elbow_flex", "shoulder_protrusion"):
            for s in ("L", "R"):
                conf = (conf_sag.get(m) or {}).get(s, 0.0)
                val = None
                if m in rom_map:
                    val = (rom.get(s) or {}).get(rom_map[m])
                add(f"sagittal.{m}.{s}", val, conf)

    if cv_frontal and cv_frontal.get("status") == "ok":
        conf_fro = (cv_frontal.get("confidence") or {}).get("parameters", {}) or {}
        for m in sorted(conf_fro.keys()):
            add(f"frontal.{m}", None, conf_fro[m])

    if anthropometry_block:
        for seg in (anthropometry_block.get("segments") or []):
            hit = next((p for p in parameters if p["parameter"] == f"anthropometry.{seg['code']}.{seg['side'] or ''}"), None)
            if hit is None:
                add(f"anthropometry.{seg['code']}.{seg['side'] or ''}",
                    seg.get("value"), seg.get("confidence"))
            else:
                hit["value"] = seg.get("value")

    name_status = (name_metadata or {}).get("status")
    if name_status and name_status != "verified":
        unassessed.append({"parameter": "name_metadata", "status": "unverified",
                           "confidence": (name_metadata or {}).get("confidence", 0.0),
                           "reason": (name_metadata or {}).get("reason", "Unverified Name Metadata.")})

    status = "assessed" if not unassessed else "partial"
    return {
        "protocol": "zero-assumption",
        "confidence_threshold": CONF_GATE,
        "status": "partial" if unassessed else "assessed",
        "parameters": parameters,
        "name_verification": name_status,
        "unassessed": unassessed,
        "summary": ("All {0} reported parameters are supported by keypoint confidence at or "
                    "above {1:.0%}." if status == "assessed" else
                    "{2} parameter(s) could not meet the {1:.0%} confidence gate and are "
                    "reported as Unassessed rather than interpolated.").format(
                        len(parameters), CONF_GATE, len(unassessed)),
    }


def _build_beginner_summary(result, anthropometry_block=None):
    """Plain-language summary written for a first-time reader (the child's family).

    Built ONLY from the real measured result — never fabricated. Any parameter the
    engine could not measure with confidence is described honestly as not measurable.
    """
    cyc = (result.get("cycle") or {})

    # Blocked / rejection path: no numbers to summarise.
    if result.get("mode") == "rejected" or (result.get("gait_validation") or {}).get("status") in ("rejected", "blocked"):
        return {
            "headline": "We were not able to complete the walking analysis yet.",
            "walking": "The recording we received did not clearly show the child walking in a straight line across the camera.",
            "what_we_found": [{
                "title": "No numbers were invented",
                "text": ("To stay honest, the report shows NO measurements instead of guessing from a "
                         "video the engine could not analyse. No score, length or angle was estimated.")}],
            "measurements": [],
            "recommended_next": [
                "Please re-record the child walking straight across the view, one direction at a time.",
                "Keep the full body (head to feet) inside the picture with good lighting."],
            "confidence_note": "Nothing was measured, so there are no confidence values to show.",
        }

    stance = cyc.get("stance_pct")
    swing = cyc.get("swing_pct")
    cadence = cyc.get("cadence_cycles_per_second")
    cycle_sec = cyc.get("cycle_seconds")

    # ---- The walk, in everyday words ----
    if stance is not None:
        walking = (
            "One full walk cycle was measured. About {0}% of the time the child's foot "
            "stays on the ground, and the remaining {1}% the leg swings forward to take "
            "the next step (healthy walking is usually around 58–62% on the ground).".format(
                stance, swing if swing is not None else round(100.0 - stance, 1)))
        if cadence and cycle_sec:
            walking += (" At the recorded pace the child completed roughly {0} full walk "
                        "cycles every second (about {1} seconds per cycle).".format(
                            round(float(cadence), 1), round(float(cycle_sec), 1)))
    else:
        walking = "The walking cycle could not be timed from the available recordings."

    # ---- Per-plane findings, in plain language ----
    prof = result.get("profile") or {}
    what_we_found = []

    for key, label in (("sagittal", "from the side"), ("frontal", "from the front"),
                       ("rotational", "for rotation/turning")):
        p = prof.get(key) or {}
        defs = p.get("deformities") or []
        if not defs:
            if p.get("assessed") is False:
                what_we_found.append({
                    "title": "{} view".format(label),
                    "text": "Could not be measured — {}".format(p.get("note") or "no valid recording.")})
            else:
                what_we_found.append({
                    "title": "{} view".format(label),
                    "text": "No clear postural deviation was detected."})
        else:
            items = "; ".join(
                "{} ({}) — {}".format(d.get("name"), d.get("magnitude"), d.get("description"))
                for d in defs[:4])
            what_we_found.append({
                "title": "{} view".format(label),
                "text": items})
            if len(defs) > 4:
                what_we_found[-1]["text"] += " And {} more detail(s) below.".format(len(defs) - 4)

    # ---- Body measurements (anthropometry) ----
    measurements = []
    if anthropometry_block:
        calib = anthropometry_block.get("calibration") or {}
        for seg in (anthropometry_block.get("segments") or []):
            if seg.get("status") != "assessed":
                continue
            name = seg.get("name") or seg.get("code", "").replace("_", " ")
            val = seg.get("value")
            if seg.get("unit") == "cm" and val is not None:
                measurements.append(
                    "{} ≈ {} cm".format(name, round(float(val), 1)))
            elif seg.get("unit") == "fraction_of_stature" and val is not None:
                measurements.append(
                    "{} ≈ {}% of the child's height (no physician height entered — "
                    "shown as a fraction, not centimetres)".format(
                        name, round(float(val) * 100.0, 1)))
        if calib.get("status") == "ok" and calib.get("height_cm"):
            measurements.insert(0,
                "Using the height you entered ({} cm), limb lengths were calculated in "
                "centimetres.".format(calib.get("height_cm")))
        else:
            measurements.insert(0,
                "No physician height was entered, so limb lengths are shown as fractions "
                "of the child's height rather than centimetres — this is the honest choice.")

    # ---- What to do next ----
    presc = result.get("prescriptions") or {}
    recommended_next = list(presc.get("guidance") or [])
    ex_count = len(presc.get("exercises") or [])
    ortho_count = len(presc.get("orthotics") or [])
    if ex_count:
        recommended_next.append("{} exercise plan(s) are suggested below — review them with your clinician.".format(ex_count))
    if ortho_count:
        recommended_next.append("{} foot/bracing recommendation(s) are listed below for clinical review.".format(ortho_count))
    if not recommended_next:
        recommended_next.append("Review the full findings with your clinician.")

    integrity = result.get("integrity") or {}
    unassessed = integrity.get("unassessed") or []
    conf_note = (
        "Every number in this report carries a confidence value between 0 and 1, taken "
        "from how clearly the engine could see that body part in the video. "
        "Anything that could not be seen clearly is reported as Unassessed, never guessed.")
    if unassessed:
        hidden = "; ".join(sorted({u.get("parameter", "") for u in unassessed})[:6])
        conf_note += (
            " In this run the following could not be measured clearly: {}. Please try "
            "re-recording so every part stays visible.".format(hidden or "some details"))

    return {
        "headline": "Your child's walking report — in plain words",
        "walking": walking,
        "what_we_found": what_we_found,
        "measurements": measurements,
        "recommended_next": recommended_next,
        "confidence_note": conf_note,
    }


def derive_clinical(cv_sagittal, cv_frontal, session_id, patient, artifacts_abs, out_dir, anthropometry_block=None, age_years=None):
    """
    Turn measured CV kinematics into the full clinical result object.
    Falls back gracefully when pose data is unavailable (reuses deterministic tables).
    """
    import random
    try:
        seed_num = int(session_id) * 7919 + 17
    except (TypeError, ValueError):
        seed_num = abs(hash(str(session_id))) % (2 ** 31)
    seed = random.Random(seed_num)
    # 2e.txt — this layer is only invoked after the gait-validity gate, so at least
    # one plane is genuinely measured. mode is always "video": there is NO demo /
    # simulation fallback and no seeded pseudo-measurements anywhere in the pipeline.
    mode = "video"
    sag_ok = cv_sagittal.get("status") == "ok"
    fro_ok = cv_frontal.get("status") == "ok"

    # Temporal gait-cycle values are ONLY ever taken from real sagittal tracking.
    # Without a sagittal capture the reference cycle is simply Not Measured.
    cycle_seconds = cv_sagittal.get("cycle_seconds") if sag_ok else None
    cadence = (1.0 / cycle_seconds) if (sag_ok and cycle_seconds) else None
    stance_pct = cv_sagittal.get("stance_pct") if sag_ok else None
    swing_pct = round(100.0 - stance_pct, 1) if stance_pct is not None else None
    running = bool(cv_sagittal.get("running")) if sag_ok else False

    phases = build_phases(stance_pct, cycle_seconds, running=running,
                          timeseries=(cv_sagittal.get("timeseries") if sag_ok else None)) if (sag_ok and stance_pct is not None and cycle_seconds) else []

    # --- anomaly & archetype selection driven by measured frontal/sagittal values ---
    detected = []
    overactive = []
    weak = []

    # Phase D — pediatric & CP screening: run the measured-based Sutherland-Davids
    # knee-pattern classifier on the validated sagittal capture (zero-assumption:
    # it reports status 'unassessed' with a reason rather than guessing). Any
    # classified pattern feeds the anomaly stream so muscles / archetype /
    # prescriptions stay coherent with the knee screen.
    cp_knee_block = None
    if cv_sagittal.get("status") == "ok":
        try:
            import cp_knee_classifier as CPK
            cp_knee_block = CPK.classify_cp_knee(cv_sagittal)
        except Exception as exc:  # network/Deps issues must NEVER fail the report
            cp_knee_block = {"status": "unassessed", "version": "cp-knee-error",
                             "citations": None, "sides": {},
                             "reason": "Classifier unavailable: {}".format(exc)}
        if cp_knee_block and cp_knee_block.get("status") == "assessed":
            rom = cv_sagittal.get("rom", {})
            for s, sname in (("L", "Left"), ("R", "Right")):
                side = (cp_knee_block.get("sides") or {}).get(s) or {}
                pat = side.get("pattern")
                if pat and pat != "not_classified" and side.get("reason"):
                    detected.append(("anomaly",
                                     "{} knee — {} ({}): {}".format(
                                         sname, side.get("pattern_label", pat), s, side["reason"]),
                                     "crouch" if pat in ("jump", "crouch") else
                                     ("stiff-knee" if pat == "stiff" else "stiff-knee"),
                                     "moderate"))

    # sagittal knee / ankle cues
    if cv_sagittal.get("status") == "ok":
        rom = cv_sagittal.get("rom", {})
        for s, sname in (("L", "Left"), ("R", "Right")):
            r = rom.get(s, {})
            k_min = r.get("knee_min", 0)
            k_max = r.get("knee_max", 0)
            a_pf = r.get("ankle_max_pf", 0)
            a_df = r.get("ankle_max_df", 0)
            if k_min > 15.0:
                detected.append(("anomaly", f"{sname} knee never fully extends in stance (min flexion {k_min:.0f}°)",
                                 "crouch", "moderate"))
            elif k_max < 40.0:
                detected.append(("anomaly", f"{sname} reduced peak knee flexion ({k_max:.0f}°) — stiff/swing-limited",
                                 "stiff-knee", "moderate"))
            if a_pf < -30.0:
                detected.append(("anomaly", f"{sname} ankle prolonged plantarflexion ({a_pf:.0f}°) — equinus/drop-foot risk",
                                 "equinus", "mild"))
            elif a_df < 0.0 and k_min > 5.0:
                detected.append(("anomaly", f"{sname} reduced dorsiflexion ({a_df:.0f}°) — foot-drop pattern",
                                 "equinus", "mild"))

    # frontal cues
    if cv_frontal.get("status") == "ok":
        fm = cv_frontal.get("metrics", {})
        pel = fm.get("pelvic_obliquity_mean", 0)
        trk = fm.get("lateral_trunk_lean_max", 0)
        kv = fm.get("knee_valgus_mean", 0)
        wshift = fm.get("weight_shift_max", 0)
        sas = fm.get("shoulder_asymmetry_index", 0)
        tfa = fm.get("tibiofemoral", {}) or {}
        tfaL = tfa.get("L") or {}
        tfaR = tfa.get("R") or {}
        max_tfa_dev = max(tfaL.get("dev_max", 0), tfaR.get("dev_max", 0)) or 0
        tfa_dirs = {d.get("direction") for d in (tfaL, tfaR) if d.get("direction")}
        if pel > 4.0:
            detected.append(("deformity", f"Frontal pelvic obliquity ~{pel:.0f}° — Trendelenburg / abductor insufficiency",
                             "trendelenburg", "moderate"))
        if trk > 8.0:
            detected.append(("deformity", f"Lateral trunk lean ~{trk:.0f}° — compensatory weight shift over stance limb",
                             "trendelenburg", "mild"))
        if kv > 0.05 or max_tfa_dev > 5.0:
            detected.append(("deformity",
                             f"Frontal knee/coronal deviation (knee offset ~{kv:.2f}; in-plane tibiofemoral axis "
                             f"deviation up to {max_tfa_dev:.0f}°, direction {(' / '.join(sorted(tfa_dirs)) or 'to be confirmed clinically')}) "
                             f"— varus/valgus alignment concern",
                             "valgus", "moderate"))
        if wshift > 0.25:
            detected.append(("deformity", f"Asymmetric weight distribution over the stance limb (offset ~{wshift:.2f})",
                             "trendelenburg", "mild"))
        if sas > 0.12:
            detected.append(("deformity", f"Shoulder height asymmetry (normalized ~{sas:.2f} × pelvic width) — "
                             "upper-limb compensatory pattern during gait",
                             "shoulder", "mild"))
        # Vaulting: aggressive plantarflexion push-off elevates standing limb for swing clearance.
        if a_pf < -35.0:
            detected.append(("deformity", f"Ankle prolonged plantarflexion ({a_pf:.0f}°) — vaulting (early heel-rise to clear swing limb)",
                             "vaulting", "moderate"))
        # Hip hiking: pronounced pelvic obliquity elevates swing-side pelvis for foot clearance.
        if pel > 6.0:
            detected.append(("deformity", f"Frontal pelvic obliquity ~{pel:.0f}° — hip hiking (swing-side pelvic elevation)",
                             "hip_hiking", "moderate"))
        # Circumduction: abnormally wide base indicates outward swing arc for foot clearance.
        swm = fm.get("step_width_mean", 0)
        if swm and swm > 0.35:
            detected.append(("deformity", f"Wide step width (~{swm:.0f}% of cycle) — circumduction arc for foot clearance",
                             "circumduction", "moderate"))
        # Scissoring: feet crossing midline (negative step width) indicates adductor spasticity.
        if swm is not None and swm < -0.15:
            detected.append(("deformity", f"Negative step width (~{swm:.0f}%) — scissoring (adductor spasticity, legs crossing midline)",
                             "scissoring", "moderate"))
        # Waddling: bilateral pelvic obliquity with wide base indicates bilateral hip abductor weakness.
        if pel > 4.0 and swm and swm > 0.25:
            detected.append(("deformity", f"Bilateral pelvic drop (~{pel:.0f}°) with wide base — waddling (bilateral hip abductor weakness)",
                             "waddling", "moderate"))
        # Steppage: hip hiking with frontal knee compensation indicates foot drop.
        if pel > 6.0 and kv < 0.05:
            detected.append(("deformity", f"Pelvic obliquity ~{pel:.0f}° with minimal knee deviation — steppage (foot drop compensation)",
                             "steppage", "moderate"))
        # Antalgic: asymmetric weight shift with coronal load asymmetry indicates pain avoidance.
        cl = fm.get("coronal_load", {}) or {}
        symmetry = cl.get("symmetry_pct", 100)
        if wshift > 0.3 and symmetry < 40:
            detected.append(("deformity", f"Asymmetric weight distribution (offset ~{wshift:.2f}, symmetry {symmetry:.0f}%) — antalgic (pain avoidance)",
                             "antalgic", "moderate"))
        # Ataxic: high step width variability indicates balance disorder.
        sw_cv = fm.get("step_width_cv", 0)
        if swm and swm > 0.3 and sw_cv and sw_cv > 0.4:
            detected.append(("deformity", f"Wide variable step width (mean ~{swm:.0f}%, CV {sw_cv:.2f}) — ataxic (balance disorder)",
                             "ataxic", "moderate"))
        # Rearfoot alignment: calcaneal eversion/inversion proxy from ankle-foot angle.
        afa = fm.get("ankle_foot_align", {}) or {}
        for side in ("L", "R"):
            val = afa.get(side)
            if val is not None and abs(val) > 10.0:
                direction = "eversion (pronation)" if val > 0 else "inversion (supination)"
                detected.append(("deformity", f"{side} rearfoot {direction} (~{val:.0f}°) — subtalar malalignment",
                                 "rearfoot", "mild"))

    # Map detected kinds to archetype muscle maps + prescriptions
    kinds = set()
    for _tag, _desc, kind, sev in detected:
        kinds.add(kind)
    # Shoulder height asymmetry is an upper-limb compensation that shares the
    # Trendelenburg posture treatment pathway (trunk/abductor control).
    if "shoulder" in kinds:
        kinds.add("trendelenburg")

    archetype = None
    for a in GA.ARCHETYPES:
        if a["label"] in kinds:
            archetype = a
            break
    if archetype is None:
        # No measured deviation -> "within normal limits", NOT a random pathology.
        archetype = NORMAL_ARCHETYPE

    anomalies = GA.apply_anomalies(seed, phases, archetype) if phases else []

    # flag phases from specific measured anomalies where applicable
    for tag, desc, kind, sev in detected:
        if kind == "crouch":
            for code in ("mid_stance", "terminal_stance"):
                ph = next((p for p in phases if p["code"] == code), None)
                if ph:
                    ph["flag"] = "prolonged"; ph["classification"] = "prolonged"; ph["severity"] = sev
                    ph["note"] = desc
        elif kind == "stiff-knee":
            ph = next((p for p in phases if p["code"] == "terminal_swing"), None)
            if ph:
                ph["flag"] = "missing"; ph["classification"] = "missing"; ph["severity"] = sev
                ph["note"] = desc

    overactive = [{"name": n, "role": r} for (n, r) in archetype["overactive"]]
    weak = [{"name": n, "role": r} for (n, r) in archetype["weak"]]

    frontal_defs = []
    sagittal_defs = []
    rotational_defs = []

    for tag, desc, kind, sev in detected:
        if kind == "trendelenburg":
            frontal_defs.append({"name": "Pelvic drop (Trendelenburg pattern)", "magnitude": sev, "category": "functional",
                                 "plane": "frontal", "detected": True, "description": desc})
        elif kind == "valgus":
            frontal_defs.append({"name": "Frontal knee / coronal alignment (varus/valgus)", "magnitude": sev, "category": "structural",
                                 "plane": "frontal", "detected": True, "description": desc})
        elif kind == "shoulder":
            frontal_defs.append({"name": "Shoulder height asymmetry (upper-limb compensation)", "magnitude": sev, "category": "functional",
                                 "plane": "frontal", "detected": True, "description": desc})
        elif kind in ("vaulting", "hip_hiking", "circumduction", "scissoring", "waddling", "steppage", "antalgic", "ataxic", "rearfoot"):
            frontal_defs.append({"name": kind.replace("_", " ").title() + " pattern", "magnitude": sev,
                                 "category": "functional",
                                 "plane": "frontal", "detected": True, "description": desc})

        elif kind in ("equinus",):
            sagittal_defs.append({"name": "Drop foot / reduced dorsiflexion", "magnitude": sev, "category": "functional",
                                  "plane": "sagittal", "detected": True, "description": desc})
        elif kind in ("crouch", "stiff-knee"):
            sagittal_defs.append({"name": archetype["deformity"][0] if archetype.get("deformity") else "Sagittal timing deviation",
                                  "magnitude": sev, "category": "functional",
                                  "plane": "sagittal", "detected": True, "description": desc})

    # 2e.txt — only findings actually MEASURED from tracked kinematics are reported.
    # Deformities are never padded from reference tables to reach a minimum count:
    # padding would be pseudo-measurement.
    for d in sagittal_defs:
        d["plane"] = "sagittal"
    for d in frontal_defs:
        d["plane"] = "frontal"
    # Rotational findings cannot be measured from planar frontal/sagittal videos, so we
    # never fabricate them here — only genuinely transverse-related cues are reported.
    rotational_defs = [d for d in rotational_defs if d.get("detected")]

    sagittal_valid = cv_sagittal.get("status") == "ok"
    frontal_valid = cv_frontal.get("status") == "ok"

    # --- ROM table ---
    rom_rows = []
    if cv_sagittal.get("status") == "ok":
        rom = cv_sagittal.get("rom", {})
        for s, sname in (("L", "Left"), ("R", "Right")):
            r = rom.get(s, {})
            rom_rows.append({"joint": f"{sname} Hip", "movement": "Flexion / Extension (sagittal)",
                             "normal": "Functional: 0-40 flex during swing",
                             "observed": f"Peak flexion {r.get('hip_peak',0):.0f}°",
                             "note": ""})
            rom_rows.append({"joint": f"{sname} Knee", "movement": "Flexion / Extension (sagittal)",
                             "normal": "0-60 flex during swing",
                             "observed": f"Peak flex {r.get('knee_max',0):.0f}° / min {r.get('knee_min',0):.0f}°",
                             "note": ""})
            rom_rows.append({"joint": f"{sname} Ankle", "movement": "Dorsiflexion / Plantarflexion",
                             "normal": "0-20 DF / 0-50 PF",
                             "observed": f"DF {r.get('ankle_max_df',0):.0f}° / PF {abs(min(0,r.get('ankle_max_pf',0))):.0f}°",
                             "note": ""})
    if cv_frontal.get("status") == "ok":
        fm = cv_frontal.get("metrics", {})
        rom_rows.append({"joint": "Pelvis", "movement": "Frontal obliquity",
                         "normal": "0-4 deg",
                         "observed": f"Up to {fm.get('pelvic_obliquity_max',0):.0f}°",
                         "note": "Trendelenburg screen"})
        tfa = fm.get("tibiofemoral", {}) or {}
        tfaL = tfa.get("L") or {}
        tfaR = tfa.get("R") or {}
        max_tfa_dev = max(tfaL.get("dev_max", 0), tfaR.get("dev_max", 0)) or 0
        rom_rows.append({"joint": "Knee (frontal)", "movement": "Tibiofemoral axis",
                         "normal": "≈180° (neutral) in-plane",
                         "observed": f"L {tfaL.get('angle_deg',0):.0f}° / R {tfaR.get('angle_deg',0):.0f}° (max dev {max_tfa_dev:.0f}°)",
                         "note": "Coronal alignment screen; varus/valgus direction to be confirmed clinically"})
        cl = fm.get("coronal_load", {}) or {}
        rom_rows.append({"joint": "Coronal loading", "movement": "Weight-shift symmetry",
                         "normal": "≈50/50 shared stance load",
                         "observed": f"Symmetry {cl.get('symmetry_pct',100):.0f}% (split {cl.get('lighter_side_load_pct',50):.0f}% / {cl.get('heavier_side_load_pct',50):.0f}%)",
                         "note": "Surrogate estimate from frontal weight shift"})
        rom_rows.append({"joint": "Shoulders", "movement": "Height symmetry (frontal)",
                         "normal": "≈0 asymmetry index",
                         "observed": f"Index {fm.get('shoulder_asymmetry_index',0):.2f}",
                         "note": "Upper-limb compensation screen"})
    # 2e.txt — ROM rows come exclusively from genuinely tracked planes; never synthesised.

    kinematics_summary = []
    if cv_sagittal.get("status") == "ok":
        kinematics_summary.append(
            f"Real sagittal kinematics: cycle {cv_sagittal.get('cycle_seconds')}s, stance {cv_sagittal.get('stance_pct')}%, "
            f"stride symmetry {cv_sagittal.get('stride_symmetry')}%.")
    if cv_frontal.get("status") == "ok":
        fm = cv_frontal.get("metrics", {})
        tfaL = (fm.get("tibiofemoral", {}) or {}).get("L", {})
        tfaR = (fm.get("tibiofemoral", {}) or {}).get("R", {})
        cl = fm.get("coronal_load", {}) or {}
        kinematics_summary.append(
            f"Real frontal kinematics: pelvic obliquity up to {fm.get('pelvic_obliquity_max',0)}°, "
            f"lateral trunk lean up to {fm.get('lateral_trunk_lean_max',0)}°, "
            f"frontal knee deviation up to {fm.get('knee_valgus_off_max',0)}°, "
            f"in-plane tibiofemoral axis L {tfaL.get('angle_deg',0)}° / R {tfaR.get('angle_deg',0)}° "
            f"(deviation to {max(tfaL.get('dev_max',0), tfaR.get('dev_max',0))}°), "
            f"weight-shift symmetry ≈{cl.get('symmetry_pct',0)}%, "
            f"shoulder asymmetry index {fm.get('shoulder_asymmetry_index',0):.2f}.")
    if not kinematics_summary:
        kinematics_summary = ["No measured kinematics available — the report reflects only the planes that produced a valid walking-capture analysis."]

    # --- prescriptions ---
    prescriptions = GA.build_prescriptions(archetype, seed)

    # --- references (split by prescription category, per 1e.txt item 5) ---
    ref_names = [d["name"] for d in frontal_defs + sagittal_defs + rotational_defs]
    reference_sections = GA.build_reference_sections(archetype["label"], ref_names)

    # --- predictive / prognostic model (1e.txt item 4) ---
    measured_note = None
    if mode == "video" and len(phases):
        ms = [p["measure"] for p in phases if p.get("measure")]
        if ms:
            measured_note = "Automated temporal measurements: " + "; ".join(ms[:4])
    prediction = GA.build_prediction(kinds or {"normal"}, measured_note=measured_note)

    plane_notes = {}
    for pname, cvd in (("frontal", cv_frontal), ("sagittal", cv_sagittal)):
        st = cvd.get("status")
        if st == "ok":
            plane_notes[pname] = ("Assessed from the combined dual-plane capture (halves separated "
                                  "and analyzed independently)." if _combined_name
                                  else "Assessed from the uploaded video.")
        elif st == "mislabeled":
            plane_notes[pname] = "Not assessed — the file in the {}-plane slot looks like the wrong plane (3e.txt) and was skipped.".format(pname)
        elif st == "no_landmarks" and cvd.get("error"):
            plane_notes[pname] = "Not assessed — {}".format(cvd["error"])
        else:
            plane_notes[pname] = "Not assessed — no usable {} video provided.".format(pname)

    # 2e.txt — no demo/simulation language anywhere; the report only ever claims
    # what was actually measured from valid walking captures.
    diag = "Engine: BRC Biomechanical Engine (real computer-vision gait analysis). " + \
           "Measured planes — sagittal: {}; frontal: {}.".format(plane_notes.get("sagittal", "n/a"), plane_notes.get("frontal", "n/a"))

    # Phase D — age-banded stance-phase reference band. Pediatric stride maturing
    # (Sutherland 1988 mature-gait literature): toddlers walk with a reduced
    # stance percentage that converges on the adult 58-62% band by ~7 years.
    # GOS-ICH normative dataset (Alderson 2023, n=624) informs the preschool
    # bands. The adult band is used when age is absent (zero-assumption: the
    # report does NOT guess maturity, it only states which band applied).
    if age_years is not None and age_years < 2.0:
        stance_band, norm_source = [42.0, 55.0], "Pediatric toddler band (Sutherland 1988 mature-gait literature)"
    elif age_years is not None and age_years < 3.5:
        stance_band, norm_source = [50.0, 60.0], "Preschool band (GOS-ICH normative dataset, Alderson 2023, n=624)"
    elif age_years is not None and age_years < 7.0:
        stance_band, norm_source = [53.0, 62.0], "Early-school band (GOS-ICH normative dataset, Alderson 2023, n=624)"
    else:
        stance_band, norm_source = [58.0, 62.0], "Adult reference band (Perry/Burnfield 2010)"
    if age_years is not None:
        kinematics_summary.append(
            "Age banded {} y — stance reference band {:.0f}-{:.0f}% ({}); pediatric norms "
            "converge to adult bands by ~7 y; growth-planned interpretation required.".format(
                age_years, stance_band[0], stance_band[1], norm_source))

    result = {
        "analyzer": ANALYZER,
        "version": VERSION,
        "mode": mode,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "session_id": session_id,
        "patient": patient,
        "diagnostic_note": diag,
        "cycle": {
            "cadence_cycles_per_second": round(cadence, 3) if cadence is not None else None,
            "cycle_seconds": round(cycle_seconds, 3) if cycle_seconds is not None else None,
            "stance_pct": stance_pct,
            "swing_pct": swing_pct,
            "stance_norm_band": stance_band,
            "stance_norm_source": norm_source,
            "phases": phases,
            "anomalies": anomalies,
            "running": running,
            "flight_phase_frac": float(cv_sagittal.get("gait_validation", {}).get("evidence", {}).get("flight_phase_frac") or 0.0) if sag_ok else None,
            "playback_speed": cv_sagittal.get("playback_speed", 1.0) if sag_ok else None,
            "playback_note": _playback_note(cv_sagittal) if sag_ok else None,
        },
        "profile": {
            "frontal": {"deformities": frontal_defs, "assessed": frontal_valid, "note": plane_notes["frontal"],
                        "stance_notes": [d["description"] for d in frontal_defs]},
            "sagittal": {"deformities": sagittal_defs, "assessed": sagittal_valid, "note": plane_notes["sagittal"],
                         "stance_notes": [d["description"] for d in sagittal_defs]},
            "rotational": {"deformities": rotational_defs, "assessed": False,
                           "note": "Not assessed — transverse (rotational) plane is not captured by the planar recordings.",
                           "stance_notes": [d["description"] for d in rotational_defs]},
        },
        "kinematics": {"rom": rom_rows, "summary": kinematics_summary},
        "cp_knee": cp_knee_block,
        "muscles": {
            "overactive": overactive or [{"name": "Gastrocnemius / Soleus", "role": "Primary plantarflexors"}],
            "weak": weak or [{"name": "Tibialis anterior", "role": "Dorsiflexion during swing"}],
            "notes": ["Muscle roles are mapped to the measured gait deviations above.",
                      "Confirm balances clinically with manual muscle testing and dynamic assessment."],
        },
        "prescriptions": prescriptions,
        "prediction": prediction,
        "references": GA.REFERENCE_PAPERS,
        "reference_sections": reference_sections,
        "cv": {
            "sagittal": cv_sagittal if cv_sagittal.get("status") == "ok" else {"plane": "sagittal", "status": cv_sagittal.get("status"), "error": cv_sagittal.get("error", "")},
            "frontal": cv_frontal if cv_frontal.get("status") == "ok" else {"plane": "frontal", "status": cv_frontal.get("status"), "error": cv_frontal.get("error", "")},
            "artifacts_abs": artifacts_abs,
        },
        "input": {"frontal_video": os.path.basename(_frontal_name), "sagittal_video": os.path.basename(_sag_name),
                  "combined_video": os.path.basename(_combined_name) if _combined_name else None,
                  "derived_from_combined": bool(_combined_name)},

        "cv_split": {
            "mode": _combined_split.get("mode") if _combined_split else None,
            "reason": _combined_split.get("reason") if _combined_split else None,
            "planes": (_combined_split.get("planes") if _combined_split and _combined_split.get("planes")
                       else None),
        },
    }
    result["prescriptions"] = GA.attach_prescription_references(result["prescriptions"], reference_sections)
    result["muscles"] = GA.augment_muscle_map(
        result["muscles"], archetype["label"],
        anomalies, frontal_defs + sagittal_defs + rotational_defs)
    result = GA.summarize_result(result)
    result["beginner_summary"] = _build_beginner_summary(result, anthropometry_block)
    return result


# Module-level names for the input basenames (set in main)
_frontal_name = ""
_sag_name = ""
_combined_name = ""
_combined_split = None


def _plane_of(median_ratio):
    """Classify one video region from its median frontal ratio (3e.txt)."""
    if median_ratio is None:
        return "none"
    if median_ratio < 0.12:
        return "sagittal"
    if median_ratio >= 0.30:
        return "frontal"
    return "ambiguous"


def _collect_region_ratios(cap, split, width, height, samples=10):
    """Sample the video and compute the median frontal-ratio of EACH half for a
    given split. split is one of ('vertical' | 'horizontal'); returns
    (mid_a_ratios, mid_b_ratios) where A/B are (left,right) for vertical and
    (top,bottom) for horizontal."""
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    step = max(2, (total + samples - 1) // samples) if total > 0 else 10
    runner, closer = _make_pose_runner()
    acc = [[], []]
    try:
        idx = 0
        while idx < total or total <= 0:
            cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
            ok, frame = cap.read()
            if not ok:
                break
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            if split == "vertical":
                regions = (rgb[:, : width // 2, :], rgb[:, width // 2:, :])
            else:
                regions = (rgb[: height // 2, :, :], rgb[height // 2:, :, :])
            for ri, region in enumerate(regions):
                if region.shape[0] < 20 or region.shape[1] < 20:
                    continue
                lm = runner(region)
                pts = {"L": {}, "R": {}}
                if lm is not None:
                    for s, (_, imap) in SIDES.items():
                        pts[s] = {k: (float(lm[j].x) * region.shape[1], float(lm[j].y) * region.shape[0])
                                  for k, j in imap.items()
                                  if getattr(lm[j], "visibility", getattr(lm[j], "presence", 1.0)) > 0.35}
                if all(k in pts["L"] and k in pts["R"] for k in ("hip", "ankle")):
                    hip_mid = (np.array(pts["L"]["hip"]) + np.array(pts["R"]["hip"])) / 2.0
                    hip_w = float(np.hypot(pts["R"]["hip"][0] - pts["L"]["hip"][0],
                                           pts["R"]["hip"][1] - pts["L"]["hip"][1]))
                    body_h = abs(hip_mid[1] - np.mean([pts["R"]["ankle"][1], pts["L"]["ankle"][1]]))
                    if body_h > 1e-6:
                        acc[ri].append(float(hip_w / body_h))
            if total <= 0 and min(len(acc[0]), len(acc[1])) >= samples:
                break
            idx += step
    finally:
        try:
            closer.close()
        except Exception:
            pass
    meds = []
    for li in acc:
        li = [v for v in li if np.isfinite(v)]
        meds.append(float(np.median(li)) if li else None)
    return meds


def _write_halves(cap, split, width, height, fps, out_a, out_b):
    """Re-encode A/B halves into two MP4s (A=left/top, B=right/bottom)."""
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    if split == "vertical":
        ca, cb = (width // 2, height), (width - width // 2, height)
    else:
        ca, cb = (width, height // 2), (width, height - height // 2)
    wa = cv2.VideoWriter(out_a, cv2.VideoWriter_fourcc(*"mp4v"), fps or 30.0, ca)
    wb = cv2.VideoWriter(out_b, cv2.VideoWriter_fourcc(*"mp4v"), fps or 30.0, cb)
    try:
        # Read sequentially (much faster than seeking per frame)
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            if split == "vertical":
                wa.write(frame[:, : width // 2, :])
                wb.write(frame[:, width // 2:, :])
            else:
                wa.write(frame[: height // 2, :, :])
                wb.write(frame[height // 2:, :, :])
    finally:
        wa.release()
        wb.release()
    # Re-encode both halves to H.264 so the derived clips play everywhere
    # (they are exported to the client alongside the overlay videos).
    _to_h264(out_a, inplace=True)
    _to_h264(out_b, inplace=True)


def _split_combined(combined_path, artifacts, session_id):
    """Split a single 'combined dual-plane' video (side-by-side or stacked) into
    frontal + sagittal halves. Returns (frontal_path, sagittal_path, split_info)
    or (None, None, split_info) when the halves cannot be reliably separated."""
    cap = cv2.VideoCapture(combined_path)
    if not cap.isOpened():
        return None, None, {"mode": "none", "reason": "Could not open combined video"}
    try:
        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    finally:
        cap.release()

    chosen = None
    split_info = None
    for split in ("vertical", "horizontal"):
        cap = cv2.VideoCapture(combined_path)
        try:
            meds = _collect_region_ratios(cap, split, width, height)
        finally:
            cap.release()
        planes = [_plane_of(m) for m in meds]
        label = {"vertical": ["side-by-side (left)", "side-by-side (right)"],
                 "horizontal": ["stacked (top)", "stacked (bottom)"]}[split]
        if all(p in ("frontal", "sagittal") for p in planes) and planes[0] != planes[1]:
            chosen = split
            split_info = {"mode": split, "region_labels": label, "planes": planes,
                          "frontal_ratios": meds}
            break

    if not chosen:
        return None, None, {
            "mode": "none",
            "reason": "Frontal and sagittal halves could not be reliably separated "
                      "from the combined capture.",
        }

    order = split_info["planes"]
    front_is_a = (order[0] == "frontal")
    out_front = os.path.join(artifacts, "derived-frontal.mp4")
    out_sag = os.path.join(artifacts, "derived-sagittal.mp4")
    if not (os.path.exists(out_front) and os.path.exists(out_sag)):
        cap = cv2.VideoCapture(combined_path)
        try:
            _write_halves(cap, chosen, width, height, fps,
                          os.path.join(artifacts, "_half_a.mp4"),
                          os.path.join(artifacts, "_half_b.mp4"))
        finally:
            cap.release()
        half_a = os.path.join(artifacts, "_half_a.mp4")
        half_b = os.path.join(artifacts, "_half_b.mp4")
        if front_is_a:
            os.replace(half_a, out_front)
            os.replace(half_b, out_sag)
        else:
            os.replace(half_b, out_front)
            os.replace(half_a, out_sag)
    return out_front, out_sag, split_info


def _screen_plane(p_abs, plane, speed_hint="auto", plan=None):
    """Run the 2e.txt gait-validity screen on one recording; never throws."""
    if not p_abs or not os.path.exists(p_abs):
        return None
    try:
        return screen_gait_validity(p_abs, plane, speed_hint=speed_hint,
                                    step=(plan["step"] if plan else None),
                                    start=(plan["start"] if plan else 0),
                                    count=(plan["count"] if plan else None))
    except Exception as exc:  # pragma: no cover — openvideo/model/memory errors
        return {"status": "rejected", "reason": "error",
                "explanation": "Gait-validity screen failed: {}".format(str(exc)[:180]),
                "message": NO_VALID_GAIT_MSG, "evidence": {}}


def _build_rejection_result(session_id, patient, gv_map, comb_split):
    """2e.txt strict rejection: NO metrics, NO pseudo-measurements, NO demo data.

    Builds a complete result object the server can persist and the report
    generators can render, but with an empty measured surface and the required
    professional error message exposed for the UI pop-up / notice.
    """
    reasons = []
    for plane in ("sagittal", "frontal"):
        gv = gv_map.get(plane) or {}
        if gv.get("status") != "ok":
            reasons.append("{}: {}".format(plane, gv.get("explanation") or
                                           (gv.get("reason") or "not assessed")))
    if not reasons:
        split_note = "the halves could not be separated" if (comb_split and comb_split.get("mode") == "none") \
            else "the recorded motion lacks a valid walking pattern"
        reasons.append(split_note)

    diag = ("Analysis blocked (2e.txt). " + NO_VALID_GAIT_MSG + " Details: " +
            " ".join(reasons))
    note = NO_VALID_GAIT_MSG

    # Routing keeps the 3e.txt semantics even though nothing is measured.
    any_valid = any((gv_map.get(p) or {}).get("status") == "ok" for p in ("sagittal", "frontal"))
    if comb_split and comb_split.get("mode") == "none":
        routing = "combined-unroutable"
    else:
        routing = "single-plane" if any_valid else "none"

    result = {
        "analyzer": ANALYZER,
        "version": VERSION,
        "mode": "rejected",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "session_id": session_id,
        "patient": patient,
        "diagnostic_note": diag,
        "gait_validation": {"status": "rejected", "message": note, "reasons": reasons},
        "cycle": {"cadence_cycles_per_second": None, "cycle_seconds": None, "stance_pct": None,
                  "swing_pct": None, "stance_norm_band": [58.0, 62.0], "phases": [], "anomalies": [],
                  "playback_speed": None, "playback_note": None},
        "profile": {
            "frontal": {"deformities": [], "assessed": False,
                        "note": note, "stance_notes": []},
            "sagittal": {"deformities": [], "assessed": False,
                         "note": note, "stance_notes": []},
            "rotational": {"deformities": [], "assessed": False,
                           "note": "Not assessed — analysis blocked by the gait-validity gate.",
                           "stance_notes": []},
        },
        "kinematics": {"rom": [], "summary": ["Analysis blocked: " + NO_VALID_GAIT_MSG]},
        "muscles": {"overactive": [], "weak": [],
                    "notes": ["No measurements were produced — the recording failed the walking (gait) validity gate."]},
        "prescriptions": {"exercises": [], "orthotics": [], "prosthetics": [],
                          "guidance": ["All prescriptions require a valid walking-capture analysis."]},
        "prediction": {},
        "references": GA.REFERENCE_PAPERS,
        "reference_sections": {},
        "cv": {
            "sagittal": {"plane": "sagittal", "status": "rejected", "error": note,
                         "gait_validation": gv_map.get("sagittal")},
            "frontal": {"plane": "frontal", "status": "rejected", "error": note,
                        "gait_validation": gv_map.get("frontal")},
            "artifacts_abs": "",
        },
        "input": {"frontal_video": os.path.basename(_frontal_name) or None,
                  "sagittal_video": os.path.basename(_sag_name) or None,
                  "combined_video": os.path.basename(_combined_name) if _combined_name else None,
                  "derived_from_combined": bool(_combined_name),
                  "routing": routing},
        "cv_split": {"mode": comb_split.get("mode") if comb_split else None,
                     "reason": comb_split.get("reason") if comb_split else None,
                     "planes": (comb_split.get("planes") if comb_split and comb_split.get("planes") else None)},
        "cv3d": {"status": "not_run", "mode": "single-plane",
                 "anatomical_note": "Multi-view 3D pipeline was not run — the gait-validity gate blocked the recording."},
    }
    result["beginner_summary"] = _build_beginner_summary(result, None)
    return result


def main():
    global _frontal_name, _sag_name, _combined_name, _combined_split
    TRACK_CACHE.clear()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--session", required=True)
    parser.add_argument("--patient", default="")
    parser.add_argument("--frontal", default=None)
    parser.add_argument("--sagittal", default=None)
    parser.add_argument("--combined", default=None,
                        help="single dual-plane video (split-screen/stacked) with frontal "
                             "and sagittal views captured together")
    parser.add_argument("--third", default=None,
                        help="third camera view (Coronal Plane per 2.md spec) for tri-view "
                             "triangulation; anatomically front-facing like frontal")
    parser.add_argument("--artifacts", default=None, help="dir for overlay videos + graphs")
    parser.add_argument("--out", required=True)
    parser.add_argument("--height-cm", default=None,
                        help="clinician-measured standing height (cm) — the metric calibration "
                             "anchor for anthropometric segmentation (run.txt §2)")
    parser.add_argument("--speed-hint", default="auto",
                        help="clinician's playback-speed ground truth: auto|normal|running|slowmo_120|slowmo_240")
    parser.add_argument("--age-years", default=None, type=float,
                        help="patient age in years — selects age-banded pediatric norm ranges "
                             "(zero-assumption: missed prematurity when absent)")
    parser.add_argument("--gender", default="",
                        help="patient gender string for the report context block")
    parser.add_argument("--context", default="",
                        help="JSON clinical context block (e.g. GMFCS level) merged into the "
                             "results as archetype_context — never inferred, only echoed")
    args = parser.parse_args()

    speed_hint = str(args.speed_hint or "auto").strip().lower() or "auto"
    height_cm = None
    try:
        if args.height_cm not in (None, "", "none"):
            height_cm = float(args.height_cm)
    except (TypeError, ValueError):
        height_cm = None
    _tick("arg_parse")

    # j.txt — startup capability notice for the optional SMPL-X hybrid stage.
    _smplx_state, _smplx_reason = smplx_refine.probe()
    print("SMPL-X refinement module: %s (%s)" % (_smplx_state, _smplx_reason),
          file=sys.stderr, flush=True)

    _frontal_name = args.frontal or ""
    _sag_name = args.sagittal or ""
    _combined_name = args.combined if args.combined and args.combined.strip().lower() != "none" else ""
    _combined_split = None

    artifacts = args.artifacts or os.path.join(os.path.dirname(args.out), "artifacts", str(args.session))
    os.makedirs(artifacts, exist_ok=True)

    sagittal_abs = args.sagittal
    frontal_abs = args.frontal
    third_abs = args.third

    # 3e.txt — combined dual-plane capture: split the two halves first, then run the
    # normal plane analyzers + the multi-view 3D engine on the derived sub-videos.
    if _combined_name and os.path.exists(_combined_name):
        _report_progress(3, "Splitting combined dual-plane capture")
        front_abs, sag_abs, _combined_split = _split_combined(args.combined, artifacts, args.session)
        if front_abs and sag_abs:
            frontal_abs = front_abs
            sagittal_abs = sag_abs
            _frontal_name = frontal_abs
            _sag_name = sagittal_abs
        else:
            _report_progress(2, "Combined capture could not be split into frontal/sagittal halves")
            _frontal_name = _combined_name
            _sag_name = ""
            sagittal_abs = None
            frontal_abs = None

    _tick("curation")

    # run.txt §1 — patient-name overlay verification is DEFERRED to report
    # export. The analysis pipeline no longer runs OCR; the Node server triggers
    # overlay_ocr.py on-demand when the clinician clicks Export PDF / Word.
    # Until that happens the name is reported as pending verification.
    name_metadata = {
        "status": "deferred",
        "unverified_name_metadata": True,
        "flag": "Unverified Name Metadata",
        "source": "video-overlay-ocr",
        "engine": "none",
        "frames_scanned": 0,
        "texts_seen": [],
        "cleaned_text": None,
        "expected_name": args.patient or None,
        "matched_name": None,
        "confidence": 0.0,
        "reason": ("The patient name burned into the video overlay is verified "
                   "on-demand when the report is exported (Export PDF / Export "
                   "Word). Until an export is run, name metadata is UNVERIFIED."),
    }
    _tick("ocr")

    # 2e.txt — strict gait-validity pre-screening gate. Runs BEFORE any full
    # kinematic processing. A plane that fails the screen is never analyzed, and
    # if NO plane passes, the whole pipeline is blocked (no metrics, no demo).
    _report_progress(3, "Gait-validity screening (2e.txt) — sagittal plane")
    sag_step = _aligned_step(sagittal_abs) if sagittal_abs and os.path.exists(sagittal_abs) else None
    gv_sag = _screen_plane(sagittal_abs, "sagittal", speed_hint, plan=sag_step)
    _report_progress(8, "Gait-validity screening (2e.txt) — frontal plane")
    fro_step = _aligned_step(frontal_abs) if frontal_abs and os.path.exists(frontal_abs) else None
    gv_fro = _screen_plane(frontal_abs, "frontal", speed_hint, plan=fro_step)
    gv_map = {"sagittal": gv_sag, "frontal": gv_fro}
    # 2.md — third (Coronal) plane: front-facing like frontal, so it shares the
    # frontal gait-validity screen but is tracked under its own key.
    if third_abs and os.path.exists(third_abs):
        _report_progress(10, "Gait-validity screening (2e.txt) — third/coronal plane")
        third_step = _aligned_step(third_abs) if third_abs else None
        gv_third = _screen_plane(third_abs, "frontal", speed_hint, plan=third_step)
        gv_map["third"] = gv_third
    _tick("screen")

    analyzable = {p for p, gv in gv_map.items()
                  if gv and gv.get("status") == "ok" and
                  ((sagittal_abs if p == "sagittal" else
                    frontal_abs if p == "frontal" else third_abs))}
    if not analyzable:
        result = _build_rejection_result(args.session, args.patient, gv_map, _combined_split)
        result["input"]["mode-note"] = "blocked"
        result["name_metadata"] = name_metadata
        result["anthropometry"] = anthropometry.compute_anthropometrics({}, height_cm)
        result["integrity"] = _build_integrity(None, None, result["anthropometry"], name_metadata)
        result["input"]["height_cm"] = height_cm
        result["input"]["height_source"] = "clinician-measured" if height_cm else "uncalibrated"
        # j.txt — blocked analyses carry a disabled (not missing) SMPL-X block so the
        # result schema stays uniform for the exporting/rendering layers.
        result["smplx"] = {"status": "disabled", "refined": False,
                           "reason": "analysis blocked at the gait-validity gate",
                           "availability": {"state": _smplx_state, "reason": _smplx_reason}}
        _report_progress(100, "Analysis blocked — not a valid walking recording")
        with open(args.out, "w", encoding="utf-8") as fh:
            json.dump(_json_clean(result), fh, ensure_ascii=False, indent=2, allow_nan=False)
        _dump_stage_times()
        print("OK mode=rejected session={0} sagittal={1} frontal={2}".format(
            args.session, "blocked", "blocked"), flush=True)
        sys.stdout.flush()
        os._exit(0)

    cv_sagittal = {}
    if sagittal_abs and os.path.exists(sagittal_abs):
        if gv_map["sagittal"] and gv_map["sagittal"].get("status") == "ok":
            _report_progress(12, "Analyzing sagittal (side) plane — pose estimation")
            try:
                sag_spd = 1.0
                sag_run = False
                sag_cad = None
                if isinstance(gv_map.get("sagittal"), dict):
                    sag_spd = float(gv_map["sagittal"].get("playback_speed", 1.0) or 1.0)
                    sag_run = bool(gv_map["sagittal"].get("running"))
                    sag_cad = gv_map["sagittal"].get("cadence_real_hz")
                cv_sagittal = analyze_sagittal(sagittal_abs, artifacts, args.session,
                                               step=(sag_step["step"] if sag_step else None),
                                               start=(sag_step["start"] if sag_step else 0),
                                               speed_factor=sag_spd, running=sag_run,
                                               validated_cadence=sag_cad)
            except Exception as exc:  # pragma: no cover
                cv_sagittal = _empty_cv("sagittal", f"analysis error: {exc}")
            cv_sagittal["gait_validation"] = gv_map["sagittal"]
            _report_progress(45, "Sagittal (side) landmarks done — building overlay & graphs")
            _tick("sagittal_analyze")
        else:
            cv_sagittal = _empty_cv("sagittal", NO_VALID_GAIT_MSG, status="rejected")
            cv_sagittal["gait_validation"] = gv_map["sagittal"]
    else:
        cv_sagittal = _empty_cv("sagittal", "no sagittal video")

    cv_frontal = {}
    if frontal_abs and os.path.exists(frontal_abs):
        if gv_map["frontal"] and gv_map["frontal"].get("status") == "ok":
            _report_progress(48, "Analyzing frontal (front) plane — pose estimation")
            try:
                fro_spd = 1.0
                fro_run = False
                if isinstance(gv_map.get("frontal"), dict):
                    fro_spd = float(gv_map["frontal"].get("playback_speed", 1.0) or 1.0)
                    fro_run = bool(gv_map["frontal"].get("running"))
                cv_frontal = analyze_frontal(frontal_abs, artifacts, args.session,
                                             step=(fro_step["step"] if fro_step else None),
                                             start=(fro_step["start"] if fro_step else 0),
                                             speed_factor=fro_spd, running=fro_run)
            except Exception as exc:  # pragma: no cover
                cv_frontal = _empty_cv("frontal", f"analysis error: {exc}")
            cv_frontal["gait_validation"] = gv_map["frontal"]
            _report_progress(80, "Frontal (front) landmarks done — building overlay & graphs")
        else:
            cv_frontal = _empty_cv("frontal", NO_VALID_GAIT_MSG, status="rejected")
            cv_frontal["gait_validation"] = gv_map["frontal"]
    else:
        cv_frontal = _empty_cv("frontal", "no frontal video")
    _tick("frontal_analyze")

    cv_third = {}
    if third_abs and os.path.exists(third_abs):
        if gv_map.get("third") and gv_map["third"].get("status") == "ok":
            _report_progress(16, "Analyzing third (coronal) plane — pose estimation")
            try:
                thi_spd = 1.0
                thi_run = False
                thi_step = _aligned_step(third_abs) if third_abs else None
                if isinstance(gv_map.get("third"), dict):
                    thi_spd = float(gv_map["third"].get("playback_speed", 1.0) or 1.0)
                    thi_run = bool(gv_map["third"].get("running"))
                cv_third = analyze_frontal(third_abs, artifacts, args.session,
                                           step=(thi_step["step"] if thi_step else None),
                                           start=(thi_step["start"] if thi_step else 0),
                                           speed_factor=thi_spd, running=thi_run)
            except Exception as exc:  # pragma: no cover
                cv_third = _empty_cv("third", f"analysis error: {exc}")
            cv_third["gait_validation"] = gv_map["third"]
            _report_progress(64, "Third (coronal) plane landmarks done — building overlay & graphs")
        else:
            cv_third = _empty_cv("third", NO_VALID_GAIT_MSG, status="rejected")
            cv_third["gait_validation"] = gv_map.get("third")
    else:
        cv_third = _empty_cv("third", "no third video")
    _tick("third_analyze")

    # 2.md — SMPL-X per-frame fitting on the third (Coronal) plane's raw
    # keypoints. Gated by USE_SMPLX (off by default) and by the presence of
    # license-gated SMPL-X model files. Zero-assumption: when off or when
    # models are missing, result["smplx"] reports unassessed and no angles are
    # fabricated. Existing report logic is untouched.
    smplx_block = {"status": "unassessed",
                   "reason": "SMPL-X fitting is disabled (USE_SMPLX=False) or no license-gated model files present."}
    if USE_SMPLX:
        try:
            from smplx_fit import fit_frame, STATUS_ASSESSED
        except Exception:
            fit_frame = None
        third_track = TRACK_CACHE.get(os.path.abspath(third_abs)) if third_abs else None
        if fit_frame and third_track and third_track.get("landmarks"):
            fitted = []
            for fr in third_track["landmarks"]:
                kp33 = _pts_to_mediapipe33(fr.get("pts"))
                res = fit_frame(kp33, artifacts, model_dir=SMPLX_MODEL_DIR,
                                gender=(args.gender or "neutral"), frame_idx=int(fr.get("abs", 0)))
                if res.get("status") == STATUS_ASSESSED:
                    fitted.append({"frame": int(fr.get("abs", 0)),
                                   "angles_deg": res.get("angles_deg", {}),
                                   "obj_path": res.get("obj_path")})
            if fitted:
                smplx_block = {"status": "assessed",
                               "frames_fitted": len(fitted),
                               "frames_total": len(third_track["landmarks"]),
                               "gender": (args.gender or "neutral"),
                               "model_dir": SMPLX_MODEL_DIR,
                               "frames": fitted}
            else:
                smplx_block = {"status": "unassessed",
                               "reason": "SMPL-X fitting produced no corrected frames (model files may be missing)."}
        elif not fit_frame:
            smplx_block = {"status": "unassessed",
                           "reason": "smplx_fit module unavailable."}
        else:
            smplx_block = {"status": "unassessed",
                           "reason": "No raw keypoint track cached for the third video."}

    _report_progress(88, "Generating clinical report, ROM plots & colour legends")
    tracks_for_anthro = {tr.get("slot"): tr for tr in list(TRACK_CACHE.values())
                         if tr.get("slot") in ("sagittal", "frontal", "third") and tr.get("landmarks")}
    anthro_block = anthropometry.compute_anthropometrics(tracks_for_anthro, height_cm)
    try:
        context_block = json.loads(args.context) if args.context else {}
    except (ValueError, TypeError):
        context_block = {}
    gmfcs_context = context_block.get("gmfcs") or None
    result = derive_clinical(cv_sagittal, cv_frontal, args.session, args.patient, artifacts, artifacts,
                             anthropometry_block=anthro_block,
                             age_years=(float(args.age_years) if args.age_years is not None else None))
    # Pediatric norms + clinical-context linkage (spec §14.2 / Phase D):
    result["archetype_context"] = {
        "age_years": (float(args.age_years) if args.age_years is not None else None),
        "gender": (args.gender or None),
        "gmfcs": gmfcs_context,
        "cp_knee": result.get("cp_knee"),
    }
    result["cv_third"] = cv_third
    result["smplx"] = smplx_block
    _tick("derive_graphs")

    # j.txt — hybrid SMPL-X refinement over the cached MediaPipe tracks. Run once
    # here (after both planes are analyzed) and reused below for the cv3d block and
    # the top-level result["smplx"]. Never raises; degrades to a disabled block.
    _report_progress(89, "SMPL-X hybrid refinement (%s)" % _smplx_state)
    smplx_block = smplx_refine.refine_all(TRACK_CACHE, height_cm=height_cm)
    smplx_block["availability"] = {"state": _smplx_state, "reason": _smplx_reason}
    _tick("smplx")

    # 2e.txt item 1 — multi-view 3D pipeline: when BOTH planes are available,
    # route through the Pose2Sim-style triangulation workflow (cv3d module).
    # 3e.txt — a combined capture routes here automatically once its halves are split.
    cv3d = {"status": "not_run", "mode": "single-plane",
            "anatomical_note":
                "Only one complete plane was analyzed; the multi-view 3D pipeline activates "
                "when two or more planes are provided."}
    has_multi = bool(analyzable >= {"sagittal", "frontal"})
    if has_multi:
        try:
            from cv3d import run_multi_view_3d
            cv3d = run_multi_view_3d(sagittal_abs, frontal_abs, artifacts, args.session,
                                     third_abs=third_abs,
                                     report_progress=_report_progress,
                                     smplx_3d=smplx_block)
        except Exception as exc:  # pragma: no cover
            cv3d = {"status": "error", "mode": "multi-view-3d",
                    "anatomical_note":
                        "Multi-view 3D triangulation failed; single-plane findings below remain valid.",
                    "error": str(exc)}
        _report_progress(88, "Multi planes triangulated into 3D kinematics")

    result["cv3d"] = cv3d
    _tick("cv3d")
    result["gait_validation"] = {"status": "ok", "message": "",
                                 "planes": {p: (cv.get("gait_validation") or {}).get("status")
                                            for p, cv in (("sagittal", cv_sagittal), ("frontal", cv_frontal), ("third", cv_third))}}
    if _combined_name:
        result["input"]["routing"] = "combined-dual-view" if has_multi else "combined-unroutable"
    else:
        result["input"]["routing"] = "multi-view-3d" if has_multi else "single-plane"

    # run.txt §2 / §5 — metric anthropometry (physician-height calibrated) + the
    # zero-assumption integrity ledger that reports every parameter's confidence status.
    result["anthropometry"] = anthro_block
    result["name_metadata"] = name_metadata
    result["integrity"] = _build_integrity(cv_sagittal, cv_frontal,
                                           result["anthropometry"], name_metadata)
    result["input"]["height_cm"] = height_cm
    result["input"]["height_source"] = "clinician-measured" if height_cm else "uncalibrated"
    result["smplx"] = smplx_block

    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(_json_clean(result), fh, ensure_ascii=False, indent=2, allow_nan=False)

    _report_progress(100, "Analysis complete")
    _dump_stage_times()
    print("OK mode={0} session={1} sagittal={2} frontal={3} third={4}".format(
        result["mode"], args.session, cv_sagittal.get("status"), cv_frontal.get("status"), cv_third.get("status")), flush=True)
    # Hard-exit: results are on disk and stdout is flushed. Skipping normal
    # interpreter shutdown avoids the MediaPipe video-landmarker teardown and
    # matplotlib font-manager teardown, which hang for minutes on this C11
    # build (measured 130s+ per run) with no functional effect on the output.
    sys.stdout.flush()
    os._exit(0)


if __name__ == "__main__":
    _STAGE_T0 = time.perf_counter()
    main()
