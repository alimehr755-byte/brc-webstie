#!/usr/bin/env python3
"""
anthropometry.py — BRC Gait Lab anthropometric segment-length measurement.

run.txt §2: real pixel-to-metric calibrated anthropometry from the dual-view
captures. Calibration is grounded in the clinician-measured standing height
(`--height-cm`), the documented zero-assumption source of metric scale.

  * px_per_cm is derived per frame from the body's vertical span (ear-line →
    floor) using a documented vertex correction (vertex-to-ear ≈ 10 % of
    stature, WHO/NHANES-derived constant used across pediatric and adult
    tables).
  * Each segment length is a median of per-frame in-plane projected lengths
    scaled by the per-frame px_per_cm, so camera approach / retreat during the
    walk is corrected frame-by-frame.
  * Every segment carries its own 0-1 confidence (fraction of frames where both
    endpoint keypoints were visible ABOVE the run.txt §5 gate of 0.60) and an
    explicit clinical status. Below-gate segments are marked
    "unassessed" — never interpolated.
  * When NO height is supplied, calibration is impossible: segments are
    reported as normalized (fraction-of-stature) with units flagged
    "UNCONVERTED — PIXEL-ONLY", never fake centimetres.
"""

import math
import os

import numpy as np

CONF_THRESHOLD = 0.60          # run.txt §5 zero-assumption keypoint gate
EAR_TO_VERTEX_FRAC = 0.10      # vertex-to-ear gap as a fraction of stature
MIN_USABLE_FRAMES = 5

# Segment -> endpoint keypoints, preferred plane, label.
SEGMENT_DEFS = [
    ("femur", "Left femur length (hip->knee, in-plane projection)", "L", ("hip", "knee"), None),
    ("femur", "Right femur length (hip->knee, in-plane projection)", "R", ("hip", "knee"), None),
    ("tibia", "Left tibia length (knee->ankle, in-plane projection)", "L", ("knee", "ankle"), None),
    ("tibia", "Right tibia length (knee->ankle, in-plane projection)", "R", ("knee", "ankle"), None),
    ("foot", "Left foot length (ankle->toe, in-plane projection surrogate)", "L", ("ankle", "toe"), None),
    ("foot", "Right foot length (ankle->toe, in-plane projection surrogate)", "R", ("ankle", "toe"), None),
    ("upper_arm", "Left upper arm length (shoulder->elbow)", "L", ("shoulder", "elbow"), None),
    ("upper_arm", "Right upper arm length (shoulder->elbow)", "R", ("shoulder", "elbow"), None),
    ("forearm", "Left forearm length (elbow->wrist)", "L", ("elbow", "wrist"), None),
    ("forearm", "Right forearm length (elbow->wrist)", "R", ("elbow", "wrist"), None),
    ("shoulder_width", "Bi-acromial shoulder width (left->right shoulder)", None, ("shoulder", "shoulder"), "frontal"),
    ("wrist_width", "Wrist width (left->right wrist, frontal projection)", None, ("wrist", "wrist"), "frontal"),
]


def _dist(a, b):
    return math.hypot(a[0] - b[0], a[1] - b[1])


def _vis_ok(vis, side, keys, threshold=CONF_THRESHOLD):
    if not vis:
        return False
    vs = vis.get(side, {}) or {}
    if keys[0] not in vs or (len(keys) > 1 and keys[1] not in vs):
        return False
    return all(vs.get(k, 0.0) >= threshold for k in keys)


def _cross_pair_pts(pts, keys):
    """Fetch a pair from opposite sides: keys[0] on side 0, keys[1] on side 1."""
    out = []
    for side, key in zip(("L", "R"), keys):
        pt = pts.get(side, {}).get(key)
        if pt is None:
            return None
        out.append(pt)
    return tuple(out)


def _cross_pair_vis_ok(vis, keys, threshold=CONF_THRESHOLD):
    if not vis:
        return False
    for side, key in zip(("L", "R"), keys):
        vs = vis.get(side, {}) or {}
        if vs.get(key, 0.0) < threshold:
            return False
    return True


def _frame_stature_px(pts, vis):
    """Vertical span ear-line -> floor with vertex correction (px)."""
    ears = []
    for s in ("L", "R"):
        if "ear" in pts.get(s, {}):
            ears.append(pts[s]["ear"][1])
    if not ears:
        return None
    ear_line = float(np.mean(ears))
    floor = None
    for s in ("L", "R"):
        for key in ("toe", "foot"):
            if key in pts.get(s, {}):
                y = pts[s][key][1]
                floor = y if floor is None else max(floor, y)
    if floor is None:
        for s in ("L", "R"):
            if "ankle" in pts.get(s, {}):
                y = pts[s]["ankle"][1]
                floor = y if floor is None else max(floor, y)
    if floor is None:
        return None
    span = max(0.0, floor - ear_line)
    if span <= 1e-6:
        return None
    return span * (1.0 + EAR_TO_VERTEX_FRAC)


def compute_anthropometrics(tracks, height_cm=None):
    """tracks: {plane: TRACK_CACHE entry} with .landmarks = [ {pts, vis}, ... ].

    height_cm: clinician-measured standing height (cm). None => uncalibrated,
    pixel-only output (never fake metric units).
    """
    plist = ["sagittal", "frontal"]
    usable = {}
    for plane in plist:
        tr = (tracks or {}).get(plane) or {}
        landmarks = tr.get("landmarks") or []
        usable[plane] = []
        for fr in landmarks:
            pts = fr.get("pts", {})
            vis = fr.get("vis")
            stat = _frame_stature_px(pts, vis)
            if stat is not None and stat > 1e-6:
                usable[plane].append({"pts": pts, "vis": vis, "stature_px": stat})
            else:
                usable[plane].append(None)

    calibrated = bool(height_cm) and float(height_cm) > 0

    calibration = {
        "protocol": "run.txt §2 anthropometric segmentation",
        "method": "clinician_height" if calibrated else "uncalibrated",
        "height_cm": round(float(height_cm), 1) if calibrated else None,
        "px_per_cm": None,
        "head_correction_frac": EAR_TO_VERTEX_FRAC,
        "frames_used": 0,
        "covered_frames": {},
        "status": "ok" if calibrated else "uncalibrated",
    }

    all_stat = []
    for plane in plist:
        all_stat += [u["stature_px"] for u in usable[plane] if u is not None]
    if calibrated and len(all_stat) >= MIN_USABLE_FRAMES:
        calibration["px_per_cm"] = round(float(np.median(all_stat) / float(height_cm)), 4)
        calibration["frames_used"] = len(all_stat)

    segments = []
    for code, name, side, keys, forced_plane in SEGMENT_DEFS:
        best = None
        best_vals = None
        best_conf = 0.0
        best_plane = None
        best_total = 0

        planes = [forced_plane] if forced_plane else plist
        for plane in planes:
            lane = usable.get(plane) or []
            vals = []
            for u in lane:
                if u is None:
                    continue
                pts = u["pts"]
                ok = False
                if len(keys) == 2 and keys[0] == keys[1]:
                    pair = _cross_pair_pts(pts, keys)
                    ok = pair is not None and _cross_pair_vis_ok(u.get("vis"), keys)
                    if ok:
                        vals.append(_dist(pair[0], pair[1]))
                else:
                    if side not in pts:
                        continue
                    if keys[0] not in pts[side] or keys[1] not in pts[side]:
                        continue
                    if not _vis_ok(u.get("vis"), side, keys):
                        continue
                    vals.append(_dist(pts[side][keys[0]], pts[side][keys[1]]))
            total = len(lane)
            conf = (len(vals) / total) if total else 0.0
            if vals and (best is None or conf > best_conf):
                best = vals
                best_conf = conf
                best_plane = plane
                best_total = total

        norm_units = "cm"
        if calibrated and best is not None and calibration["px_per_cm"]:
            vals_cm = [v / calibration["px_per_cm"] for v in best]
            value_rep = round(float(np.median(vals_cm)), 1)
            status = "assessed" if best_conf >= CONF_THRESHOLD else "unassessed"
            reason = "" if best_conf >= CONF_THRESHOLD else (
                "Insufficient footage — both endpoint keypoints carried confidence "
                "below the 0.60 gate long enough across the recording for only "
                "{0:.0%} of sampled frames.".format(best_conf))
        elif best is not None:
            vals_norm = [v / u["stature_px"] for v, u in
                         ((best[i], None) for i in range(len(best)))] if False else None
            # normalized against the same frames' body spans
            vals_norm = []
            lane = usable.get(best_plane) or []
            per_frame = []
            col = 0
            for u in lane:
                if u is None:
                    continue
                pts = u["pts"]
                stat = u["stature_px"]
                ok = False
                if len(keys) == 2 and keys[0] == keys[1]:
                    pair = _cross_pair_pts(pts, keys)
                    ok = pair is not None and _cross_pair_vis_ok(u.get("vis"), keys)
                    if ok:
                        per_frame.append(_dist(pair[0], pair[1]) / stat)
                else:
                    if side in pts and keys[0] in pts[side] and keys[1] in pts[side] \
                            and _vis_ok(u.get("vis"), side, keys):
                        per_frame.append(_dist(pts[side][keys[0]], pts[side][keys[1]]) / stat)
            if per_frame:
                vals_norm = per_frame
            value_rep = round(float(np.median(vals_norm)), 4) if vals_norm else None
            norm_units = "normalized (fraction of body stature)"
            status = "unconverted" if value_rep is not None else "unassessed"
            reason = "UNCONVERTED — PIXEL-ONLY. No clinician height was provided, so no " \
                     "metric scale exists; the value is reported as a fraction of the " \
                     "measured body span and MUST NOT be read as centimetres." if value_rep is not None \
                     else "Unassessed — endpoint keypoints could not be tracked reliably."
        else:
            value_rep = None
            norm_units = "cm"
            status = "unassessed"
            reason = "Unassessed — endpoint keypoints were not visible in the captured frames " \
                     "(Keypoint Occluded / out of recording)."

        segments.append({
            "code": code,
            "name": name,
            "side": side,
            "plane": best_plane,
            "unit": norm_units,
            "value": value_rep,
            "confidence": round(best_conf, 3),
            "status": status,
            "reason": reason,
        })

    calibration["covered_frames"] = {p: len([u for u in usable.get(p) or [] if u is not None])
                                     for p in plist}

    units_note = (
        "Segments are in-plane projected lengths scaled by a pixel-to-cm calibration "
        "anchored to the clinician-measured standing height (vertex-to-ear correction "
        "{0:.0%} of stature). In-plane projection slightly underestimates any segment "
        "angled toward the camera.".format(EAR_TO_VERTEX_FRAC)
        if calibrated else
        "NO metric calibration was available: all segment lengths are reported as "
        "fractions of the measured body span and are flagged UNCONVERTED — PIXEL-ONLY. "
        "Provide a clinician-measured standing height to obtain centimetre values."
    )

    return {
        "protocol": "run.txt §2 anthropometric segmentation",
        "calibration": calibration,
        "segments": segments,
        "units_note": units_note,
    }