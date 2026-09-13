"""Upload-time plane-orientation classifier (3e.txt).

Determines whether a gait recording is a front-on (frontal) or side-on
(sagittal) view using the SAME frontal-ratio heuristic the analyzers use:

    ratio = hip-width / (hip-to-ankle body height)

    - ratio <  0.12                -> sagittal (side-on: the two hip markers
                                       are almost superimposed on the pelvis)
    - ratio >=  0.30                -> frontal  (front-on / rear-on: wide
                                       pelvic silhouette)
    - otherwise                     -> ambiguous (do NOT auto-block; the full
                                       analyzer applies its own checks later)

CLI (run by the Node server):
    py classify_plane.py --video <abs path> --slot frontal|sagittal [--samples 10]

Prints a single JSON object on stdout:
    {"ok": true, "slot": "frontal", "detected": "sagittal",
     "frontal_ratio": 0.035, "samples": 10}
On soft failure (cannot open video / no pose model / no landmarks) it still
prints a JSON dict with detected="none" so the server fails OPEN rather than
blocking a legitimate upload.
"""
import argparse
import json
import os
import sys

import cv2
import numpy as np

L_INDEX = dict(ear=7, shoulder=11, elbow=13, wrist=15, hip=23, knee=25, ankle=27, foot=31, toe=29)
R_INDEX = dict(ear=8, shoulder=12, elbow=14, wrist=16, hip=24, knee=26, ankle=28, foot=32, toe=30)
SIDES = {"L": L_INDEX, "R": R_INDEX}

FRONTAL_LO = 0.12   # median ratio strictly below this -> side-on (sagittal)
FRONTAL_HI = 0.30   # median ratio at/above this   -> front-on (frontal)


def _make_pose_runner():
    """Return (run, closer) using the Tasks-vision PoseLandmarker model.

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


def frontal_ratio_series(video_path, samples=10):
    """Return list of per-frame hip-width/body-height ratios (matches analyzers)."""
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        return [], None
    try:
        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        step = max(2, (total + samples - 1) // samples) if total > 0 else 10

        runner, closer = _make_pose_runner()
        ratios = []
        try:
            # Sequential read with frame skipping. Random seeks via
            # CAP_PROP_POS_FRAMES are 10-40x slower on MP4 (see gait_validity.py).
            idx = 0
            next_sample = 0
            while True:
                ok, frame = cap.read()
                if not ok:
                    break
                if idx < next_sample:
                    idx += 1
                    continue
                next_sample = idx + step
                idx += 1
                lm = runner(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
                pts = {"L": {}, "R": {}}
                if lm is not None:
                    for s, imap in SIDES.items():
                        pts[s] = {k: (float(lm[j].x) * width, float(lm[j].y) * height) for k, j in imap.items()
                                  if getattr(lm[j], "visibility", getattr(lm[j], "presence", 1.0)) > 0.35}
                if all(k in pts.get("L", {}) and k in pts.get("R", {}) for k in ("hip", "ankle")):
                    hip_mid = (np.array(pts["L"]["hip"]) + np.array(pts["R"]["hip"])) / 2.0
                    hip_w = float(np.hypot(pts["R"]["hip"][0] - pts["L"]["hip"][0],
                                           pts["R"]["hip"][1] - pts["L"]["hip"][1]))
                    body_h = abs(hip_mid[1] - np.mean([pts["R"]["ankle"][1], pts["L"]["ankle"][1]]))
                    if body_h > 1e-6:
                        ratios.append(float(hip_w / body_h))
                if total <= 0 and len(ratios) >= samples:
                    break
        finally:
            try:
                closer.close()
            except Exception:
                pass
    finally:
        cap.release()
    med = float(np.median(ratios)) if ratios else None
    return ratios, med


def classify(ratio_med):
    if ratio_med is None:
        return "none"
    if ratio_med < FRONTAL_LO:
        return "sagittal"
    if ratio_med >= FRONTAL_HI:
        return "frontal"
    return "ambiguous"


def gait_validity_screen(video_path, plane="sagittal"):
    """2e.txt gate: run the walking-validity screen on the whole clip.

    Returns a JSON-safe dict (status/reason/message/evidence) so the upload
    endpoint can fail-closed; a decode/pose/model error is reported as
    status='error' (never a false 'ok').
    """
    try:
        from gait_validity import screen_gait_validity
        return screen_gait_validity(video_path, plane)
    except Exception as exc:
        return {"status": "error", "reason": "error",
                "explanation": "Gait-validity screen failed: {}".format(str(exc)[:180]),
                "message": None, "evidence": {}}


def main():
    ap = argparse.ArgumentParser(description="Gait plane-orientation classifier + 2e.txt gait-validity screen")
    ap.add_argument("--video", required=True)
    ap.add_argument("--slot", choices=["frontal", "sagittal"], default="frontal")
    ap.add_argument("--samples", type=int, default=10)
    ap.add_argument("--skip-validity", action="store_true",
                    help="Skip the heavy gait-validity screen (use during upload to speed up; "
                         "the full screen runs again during analysis)")
    args = ap.parse_args()

    out = {"ok": True, "slot": args.slot, "detected": "none", "frontal_ratio": None, "samples": 0,
           "gait_validation": None}
    try:
        ratios, med = frontal_ratio_series(args.video, args.samples)
        out["frontal_ratio"] = med
        out["samples"] = len(ratios)
        out["detected"] = classify(med)
    except Exception as e:  # soft failure -> fail open (server is the authority)
        out["ok"] = False
        out["error"] = str(e)

    if args.skip_validity:
        # Upload-time fast path: only plane orientation, skip the heavy gait-validity
        # screen (200 MediaPipe frames). The full screen runs during gait_lab.py analysis.
        from gait_validity import NO_VALID_GAIT_MSG
        out["gait_validation"] = {"status": "ok", "reason": None,
                                  "explanation": "Skipped during upload (will run during analysis)",
                                  "message": ""}
    else:
        # 2e.txt — the screen result rides along so the upload endpoint can reject
        # non-walking clips immediately (fail-closed) with the exact user message.
        from gait_validity import NO_VALID_GAIT_MSG
        gv = gait_validity_screen(args.video, args.slot)
        gv = dict(gv or {})
        if not gv.get("message"):
            gv["message"] = NO_VALID_GAIT_MSG if gv.get("status") != "ok" else ""
        out["gait_validation"] = gv
    print(json.dumps(out))


if __name__ == "__main__":
    main()