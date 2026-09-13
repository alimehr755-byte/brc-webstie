"""
Orthopedic Eye — Core Kinematic Engine (Full Diagnostic & Overlay Edition)
Developed by: Muhammad Mehr Ali (Prosthetist & Orthotist)
Filename: gait_engine.py
"""

import os
import cv2
import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
from scipy.signal import savgol_filter, find_peaks

# Check for solutions vs tasks API
try:
    import mediapipe.solutions.pose as mp_pose
    import mediapipe.solutions.drawing_utils as mp_drawing
    import mediapipe as mp
    HAS_SOLUTIONS = True
except (AttributeError, ModuleNotFoundError, ImportError):
    import mediapipe as mp
    HAS_SOLUTIONS = False

MAX_GAP_TO_INTERPOLATE = 5

def three_point_angle(a, b, c):
    a, b, c = np.array(a), np.array(b), np.array(c)
    ba, bc = a - b, c - b
    cosine = np.dot(ba, bc) / (np.linalg.norm(ba) * np.linalg.norm(bc) + 1e-9)
    return np.degrees(np.arccos(np.clip(cosine, -1.0, 1.0)))

def compute_metric(metric, side_pts):
    if metric == "hip_flexion":
        return 180.0 - three_point_angle(side_pts["shoulder"], side_pts["hip"], side_pts["knee"])
    elif metric == "knee_flexion":
        return 180.0 - three_point_angle(side_pts["hip"], side_pts["knee"], side_pts["ankle"])
    elif metric == "ankle_angle":
        return 110.0 - three_point_angle(side_pts["knee"], side_pts["ankle"], side_pts["foot"])
    elif metric == "elbow_flexion":
        return 180.0 - three_point_angle(side_pts["shoulder"], side_pts["elbow"], side_pts["wrist"])
    elif metric == "shoulder_flexion":
        return 180.0 - three_point_angle(side_pts["hip"], side_pts["shoulder"], side_pts["elbow"])
    return np.nan

def signed_lean_from_vertical(bottom, top):
    dx = top[0] - bottom[0]
    dy = top[1] - bottom[1]
    return np.degrees(np.arctan2(dx, -dy))

def fill_all_for_detection(values):
    n = len(values)
    idx = np.arange(n)
    valid = ~np.isnan(values)
    if valid.sum() < 2:
        return values, 1.0
    values = values.copy()
    values[~valid] = np.interp(idx[~valid], idx[valid], values[valid])
    return values, 1 - (valid.sum() / n)

def detect_gait_events(offset_signal, fps):
    wlen = min(15, len(offset_signal) // 2 * 2 - 1)
    smoothed = savgol_filter(offset_signal, window_length=wlen, polyorder=3) if wlen > 5 else offset_signal
    distance = max(int(fps * 0.35), 1)
    prominence = max(np.std(smoothed) * 0.4, 1e-6)
    peaks, _ = find_peaks(smoothed, distance=distance, prominence=prominence)
    return peaks

def symmetry_index(a, b):
    if len(a) == 0 or len(b) == 0: return 0.0
    ma, mb = np.mean(a), np.mean(b)
    if (ma + mb) == 0: return 0.0
    return abs(ma - mb) / ((ma + mb) / 2) * 100

def normalize_to_gait_cycle(time_series, heel_strikes):
    cycles = []
    if len(heel_strikes) < 2: return None
    for i in range(len(heel_strikes) - 1):
        segment = time_series[heel_strikes[i]:heel_strikes[i+1] + 1]
        if len(segment) < 3: continue
        x_old = np.linspace(0, 100, len(segment))
        x_new = np.linspace(0, 100, 101)
        cycles.append(np.interp(x_new, x_old, segment))
    return np.array(cycles) if cycles else None

def generate_clinical_diagnostic_block(series):
    diagnostic_lines = []
    for metric in ["hip_flexion", "knee_flexion", "ankle_angle"]:
        for side, side_name in [("L", "Left"), ("R", "Right")]:
            vals = np.array(series[side][metric])
            vals = vals[~np.isnan(vals)]
            if len(vals) == 0:
                continue
            
            measured_min = np.min(vals)
            measured_max = np.max(vals)
            deviations = []
            
            if metric == "ankle_angle":
                if measured_max > 25.0:
                    deviations.append(f"Excessive dynamic dorsiflexion peak ({measured_max:.1f}°)")
                if measured_min < -35.0:
                    deviations.append(f"Excessive plantarflexion swing drop ({measured_min:.1f}°)")
            elif metric == "knee_flexion":
                if measured_max > 75.0:
                    deviations.append(f"Exaggerated swing phase crouch ({measured_max:.1f}°)")
                if measured_min > 15.0:
                    deviations.append(f"Flexion contracture / incomplete extension stance ({measured_min:.1f}°)")
                    
            status_text = f"[Deviation Identified] -> " + " | ".join(deviations) if deviations else "[Normal Physiological Limits]"
            diagnostic_lines.append(f"• {side_name} {metric.replace('_', ' ').title()}: {status_text}")

    return "\n".join(diagnostic_lines)

def run_gait_analysis(video_path, playback_speed, generate_overlay_video=True):
    cap = cv2.VideoCapture(video_path)
    
    metrics_keys = ["hip_flexion", "knee_flexion", "ankle_angle", "elbow_flexion", "shoulder_flexion"]
    series = {s: {m: [] for m in metrics_keys} for s in ("L", "R")}
    ankle_offset = {"L": [], "R": []}
    trunk_lean = []
    head_tilt = []
    
    try:
        fps = cap.get(cv2.CAP_PROP_FPS) or 30
        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

        adjusted_fps = fps * playback_speed

        MAP_INDICES = {
            "L": {"ear": 7, "shoulder": 11, "elbow": 13, "wrist": 15, "hip": 23, "knee": 25, "ankle": 27, "foot": 31},
            "R": {"ear": 8, "shoulder": 12, "elbow": 14, "wrist": 16, "hip": 24, "knee": 26, "ankle": 28, "foot": 32}
        }

        if HAS_SOLUTIONS:
            Lm = mp_pose.PoseLandmark
            MAP_SOL = {
                "L": {"ear": Lm.LEFT_EAR, "shoulder": Lm.LEFT_SHOULDER, "elbow": Lm.LEFT_ELBOW, "wrist": Lm.LEFT_WRIST, "hip": Lm.LEFT_HIP, "knee": Lm.LEFT_KNEE, "ankle": Lm.LEFT_ANKLE, "foot": Lm.LEFT_FOOT_INDEX},
                "R": {"ear": Lm.RIGHT_EAR, "shoulder": Lm.RIGHT_SHOULDER, "elbow": Lm.RIGHT_ELBOW, "wrist": Lm.RIGHT_WRIST, "hip": Lm.RIGHT_HIP, "knee": Lm.RIGHT_KNEE, "ankle": Lm.RIGHT_ANKLE, "foot": Lm.RIGHT_FOOT_INDEX}
            }
            with mp_pose.Pose(min_detection_confidence=0.5, min_tracking_confidence=0.5) as pose:
                while cap.isOpened():
                    success, frame = cap.read()
                    if not success: break
                    rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                    res = pose.process(rgb)
                    
                    pts = {"L": {}, "R": {}}
                    if res.pose_landmarks:
                        lm = res.pose_landmarks.landmark
                        for s in ("L", "R"):
                            for k, idx in MAP_SOL[s].items():
                                if lm[idx].visibility > 0.4:
                                    pts[s][k] = (lm[idx].x * width, lm[idx].y * height)
                    
                    for s in ("L", "R"):
                        series[s]["hip_flexion"].append(compute_metric("hip_flexion", pts[s]) if all(k in pts[s] for k in ["shoulder", "hip", "knee"]) else np.nan)
                        series[s]["knee_flexion"].append(compute_metric("knee_flexion", pts[s]) if all(k in pts[s] for k in ["hip", "knee", "ankle"]) else np.nan)
                        series[s]["ankle_angle"].append(compute_metric("ankle_angle", pts[s]) if all(k in pts[s] for k in ["knee", "ankle", "foot"]) else np.nan)
                        series[s]["elbow_flexion"].append(compute_metric("elbow_flexion", pts[s]) if all(k in pts[s] for k in ["shoulder", "elbow", "wrist"]) else np.nan)
                        series[s]["shoulder_flexion"].append(compute_metric("shoulder_flexion", pts[s]) if all(k in pts[s] for k in ["hip", "shoulder", "elbow"]) else np.nan)
                        ankle_offset[s].append(pts[s]["ankle"][0] - pts[s]["hip"][0] if ("hip" in pts[s] and "ankle" in pts[s]) else np.nan)

                    hip_pts = [pts[s]["hip"] for s in ("L", "R") if "hip" in pts[s]]
                    sh_pts = [pts[s]["shoulder"] for s in ("L", "R") if "shoulder" in pts[s]]
                    ear_pts = [pts[s]["ear"] for s in ("L", "R") if "ear" in pts[s]]
                    
                    trunk_lean.append(signed_lean_from_vertical(np.mean(hip_pts, axis=0), np.mean(sh_pts, axis=0)) if (hip_pts and sh_pts) else np.nan)
                    head_tilt.append(signed_lean_from_vertical(np.mean(sh_pts, axis=0), np.mean(ear_pts, axis=0)) if (sh_pts and ear_pts) else np.nan)

        else:
            BaseOptions = mp.tasks.BaseOptions
            PoseLandmarker = mp.tasks.vision.PoseLandmarker
            PoseLandmarkerOptions = mp.tasks.vision.PoseLandmarkerOptions
            VisionRunningMode = mp.tasks.vision.RunningMode

            options = PoseLandmarkerOptions(
                base_options=BaseOptions(model_asset_path="pose_landmarker_heavy.task"),
                running_mode=VisionRunningMode.VIDEO
            )

            with PoseLandmarker.create_from_options(options) as landmarker:
                frame_count = 0
                while cap.isOpened():
                    success, frame = cap.read()
                    if not success: break
                    
                    timestamp_ms = int((frame_count / fps) * 1000)
                    frame_count += 1
                    
                    rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                    mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
                    res = landmarker.detect_for_video(mp_image, timestamp_ms)
                    
                    pts = {"L": {}, "R": {}}
                    if res.pose_landmarks and len(res.pose_landmarks) > 0:
                        lm = res.pose_landmarks[0]
                        for s in ("L", "R"):
                            for k, idx in MAP_INDICES[s].items():
                                vis = getattr(lm[idx], 'presence', getattr(lm[idx], 'visibility', 1.0))
                                if vis > 0.3:
                                    pts[s][k] = (lm[idx].x * width, lm[idx].y * height)

                    for s in ("L", "R"):
                        series[s]["hip_flexion"].append(compute_metric("hip_flexion", pts[s]) if all(k in pts[s] for k in ["shoulder", "hip", "knee"]) else np.nan)
                        series[s]["knee_flexion"].append(compute_metric("knee_flexion", pts[s]) if all(k in pts[s] for k in ["hip", "knee", "ankle"]) else np.nan)
                        series[s]["ankle_angle"].append(compute_metric("ankle_angle", pts[s]) if all(k in pts[s] for k in ["knee", "ankle", "foot"]) else np.nan)
                        series[s]["elbow_flexion"].append(compute_metric("elbow_flexion", pts[s]) if all(k in pts[s] for k in ["shoulder", "elbow", "wrist"]) else np.nan)
                        series[s]["shoulder_flexion"].append(compute_metric("shoulder_flexion", pts[s]) if all(k in pts[s] for k in ["hip", "shoulder", "elbow"]) else np.nan)
                        ankle_offset[s].append(pts[s]["ankle"][0] - pts[s]["hip"][0] if ("hip" in pts[s] and "ankle" in pts[s]) else np.nan)

                    hip_pts = [pts[s]["hip"] for s in ("L", "R") if "hip" in pts[s]]
                    sh_pts = [pts[s]["shoulder"] for s in ("L", "R") if "shoulder" in pts[s]]
                    ear_pts = [pts[s]["ear"] for s in ("L", "R") if "ear" in pts[s]]

                    trunk_lean.append(signed_lean_from_vertical(np.mean(hip_pts, axis=0), np.mean(sh_pts, axis=0)) if (hip_pts and sh_pts) else np.nan)
                    head_tilt.append(signed_lean_from_vertical(np.mean(sh_pts, axis=0), np.mean(ear_pts, axis=0)) if (sh_pts and ear_pts) else np.nan)
    finally:
        cap.release()

    events = {}
    stride_times = {}
    for s in ("L", "R"):
        filled, _ = fill_all_for_detection(np.array(ankle_offset[s]))
        events[s] = detect_gait_events(filled, fps)
        stride_times[s] = np.diff(events[s]) / adjusted_fps if len(events[s]) >= 2 else np.array([])

    mean_curves = {s: {} for s in ("L", "R")}
    for i, m in enumerate(["hip_flexion", "knee_flexion", "ankle_angle"]):
        for s in ("L", "R"):
            raw = np.array(series[s][m])
            matrix = normalize_to_gait_cycle(raw, events[s])
            if matrix is not None:
                mean_curves[s][m] = np.nanmean(matrix, axis=0)
            else:
                mean_curves[s][m] = np.full(101, np.nan)

    # --- PLOT 1: BILATERAL KINEMATIC PLOT ---
    fig, axes = plt.subplots(3, 1, figsize=(10, 8))
    colors_map = {"L": "tab:blue", "R": "tab:orange"}
    labels = ["Hip Flexion (°)", "Knee Flexion (°)", "Ankle Angle (°)"]
    x_cycle = np.linspace(0, 100, 101)

    for i, m in enumerate(["hip_flexion", "knee_flexion", "ankle_angle"]):
        for s in ("L", "R"):
            if not np.isnan(mean_curves[s][m]).all():
                axes[i].plot(x_cycle, mean_curves[s][m], color=colors_map[s], linewidth=2.5, label=f"{s} Leg")
        axes[i].set_ylabel(labels[i], fontsize=11, fontweight='bold')
        axes[i].grid(True, alpha=0.3)
        axes[i].legend(loc='upper right')
        axes[i].set_xlim(0, 100)
    axes[2].set_xlabel("Normalized Gait Cycle (%) [Heel Strike to Heel Strike]", fontsize=11, fontweight='bold')
        
    plt.tight_layout()
    plt.savefig("full_rom_plot.png", dpi=150)
    plt.close()

    # --- PLOT 2: POSTURAL DISPLACEMENT PLOT ---
    fig2, ax2 = plt.subplots(2, 1, figsize=(10, 6), sharex=True)
    frame_numbers = np.arange(len(trunk_lean))
    ax2[0].plot(frame_numbers, trunk_lean, color="tab:green", linewidth=2, label="Trunk Lean Angle (°)")
    ax2[0].set_ylabel("Trunk Lean (°)", fontsize=10, fontweight='bold')
    ax2[0].grid(True, alpha=0.3)
    ax2[0].legend(loc="upper right")
    
    ax2[1].plot(frame_numbers, head_tilt, color="tab:purple", linewidth=2, label="Head Tilt Angle (°)")
    ax2[1].set_ylabel("Head Tilt (°)", fontsize=10, fontweight='bold')
    ax2[1].set_xlabel("Video Frame Index", fontsize=10, fontweight='bold')
    ax2[1].grid(True, alpha=0.3)
    ax2[1].legend(loc="upper right")
    
    plt.tight_layout()
    plt.savefig("gait_cycle_plot.png", dpi=150)
    plt.close()

    # --- ANNOTATED VIDEO OVERLAY GENERATION ---
    overlay_video_path = "output.mp4"
    if generate_overlay_video:
        cap2 = cv2.VideoCapture(video_path)
        
        try:
            fourcc = cv2.VideoWriter_fourcc(*'mp4v')
            writer1 = cv2.VideoWriter("output.mp4", fourcc, fps, (width, height))
            writer2 = cv2.VideoWriter("overlay_output.mp4", fourcc, fps, (width, height))
            
            hs_lookup = {}
            for s in ("L", "R"):
                for f in events[s]:
                    hs_lookup.setdefault(int(f), []).append(s)

            # Continuous skeletal chain: Ear -> Shoulder -> Hip -> Knee -> Ankle
            SKELETAL_CHAIN_LEFT = [7, 11, 23, 25, 27]
            SKELETAL_CHAIN_RIGHT = [8, 12, 24, 26, 28]
            
            ALL_JOINTS = [7, 8, 11, 12, 23, 24, 25, 26, 27, 28]
            
            JOINT_METRIC_MAP = {
                23: ("L Hip", "L", "hip_flexion"), 24: ("R Hip", "R", "hip_flexion"),
                25: ("L Knee", "L", "knee_flexion"), 26: ("R Knee", "R", "knee_flexion"),
                27: ("L Ankle", "L", "ankle_angle"), 28: ("R Ankle", "R", "ankle_angle")
            }

            if HAS_SOLUTIONS:
                with mp_pose.Pose(min_detection_confidence=0.5, min_tracking_confidence=0.5) as pose:
                    fi = 0
                    while cap2.isOpened():
                        success, frame = cap2.read()
                        if not success: break
                        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                        res = pose.process(rgb)
                        
                        cv2.rectangle(frame, (0, 0), (width, 60), (15, 23, 42), -1)
                        cv2.putText(frame, "ORTHOPEDIC EYE -- FULL LINK CHAIN OVERLAY", (20, 38),
                                    cv2.FONT_HERSHEY_SIMPLEX, 0.85, (255, 255, 255), 2)
                        
                        if res.pose_landmarks:
                            lm = res.pose_landmarks.landmark
                            
                            # Draw neck line connection (Shoulder to Shoulder)
                            if lm[11].visibility > 0.4 and lm[12].visibility > 0.4:
                                p1 = (int(lm[11].x * width), int(lm[11].y * height))
                                p2 = (int(lm[12].x * width), int(lm[12].y * height))
                                cv2.line(frame, p1, p2, (255, 255, 0), 2)

                            # Draw complete left leg skeletal chain path
                            for idx in range(len(SKELETAL_CHAIN_LEFT) - 1):
                                s_i, e_i = SKELETAL_CHAIN_LEFT[idx], SKELETAL_CHAIN_LEFT[idx+1]
                                if lm[s_i].visibility > 0.4 and lm[e_i].visibility > 0.4:
                                    pt1 = (int(lm[s_i].x * width), int(lm[s_i].y * height))
                                    pt2 = (int(lm[e_i].x * width), int(lm[e_i].y * height))
                                    cv2.line(frame, pt1, pt2, (255, 255, 0), 2)

                            # Draw complete right leg skeletal chain path
                            for idx in range(len(SKELETAL_CHAIN_RIGHT) - 1):
                                s_i, e_i = SKELETAL_CHAIN_RIGHT[idx], SKELETAL_CHAIN_RIGHT[idx+1]
                                if lm[s_i].visibility > 0.4 and lm[e_i].visibility > 0.4:
                                    pt1 = (int(lm[s_i].x * width), int(lm[s_i].y * height))
                                    pt2 = (int(lm[e_i].x * width), int(lm[e_i].y * height))
                                    cv2.line(frame, pt1, pt2, (255, 255, 0), 2)
                                    
                            # Draw solid red tracking circles on all segment link landmarks
                            for j_idx in ALL_JOINTS:
                                if lm[j_idx].visibility > 0.4:
                                    cx, cy = int(lm[j_idx].x * width), int(lm[j_idx].y * height)
                                    cv2.circle(frame, (cx, cy), 10, (0, 0, 255), -1)
                                    cv2.circle(frame, (cx, cy), 12, (255, 255, 255), 2)
                                    
                            # Print joint angles right next to the red joint markers
                            for j_idx, (j_label, s_side, m_key) in JOINT_METRIC_MAP.items():
                                if lm[j_idx].visibility > 0.4:
                                    cx, cy = int(lm[j_idx].x * width), int(lm[j_idx].y * height)
                                    val = series[s_side][m_key][fi] if fi < len(series[s_side][m_key]) else np.nan
                                    if not np.isnan(val):
                                        label_text = f"{val:.1f}deg"
                                        tx, ty = cx + 15, cy + 5
                                        if tx + 80 > width: tx = cx - 80
                                        cv2.putText(frame, label_text, (tx, ty), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 255), 2)
                                        
                        if fi in hs_lookup:
                            cv2.rectangle(frame, (width - 320, 10), (width - 10, 50), (0, 0, 200), -1)
                            cv2.putText(frame, f"HEEL STRIKE ({'+'.join(hs_lookup[fi])})", (width - 310, 38),
                                        cv2.FONT_HERSHEY_SIMPLEX, 0.75, (255, 255, 255), 2)
                        
                        writer1.write(frame)
                        writer2.write(frame)
                        fi += 1
            else:
                BaseOptions = mp.tasks.BaseOptions
                PoseLandmarker = mp.tasks.vision.PoseLandmarker
                PoseLandmarkerOptions = mp.tasks.vision.PoseLandmarkerOptions
                VisionRunningMode = mp.tasks.vision.RunningMode

                options = PoseLandmarkerOptions(
                    base_options=BaseOptions(model_asset_path="pose_landmarker_heavy.task"),
                    running_mode=VisionRunningMode.VIDEO
                )

                with PoseLandmarker.create_from_options(options) as landmarker:
                    fi = 0
                    while cap2.isOpened():
                        success, frame = cap2.read()
                        if not success: break
                        
                        timestamp_ms = int((fi / fps) * 1000)
                        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                        mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
                        res = landmarker.detect_for_video(mp_image, timestamp_ms)
                        
                        cv2.rectangle(frame, (0, 0), (width, 60), (15, 23, 42), -1)
                        cv2.putText(frame, "ORTHOPEDIC EYE -- FULL LINK CHAIN OVERLAY", (20, 38),
                                    cv2.FONT_HERSHEY_SIMPLEX, 0.85, (255, 255, 255), 2)
                        
                        if res.pose_landmarks and len(res.pose_landmarks) > 0:
                            lm = res.pose_landmarks[0]
                            
                            if getattr(lm[11], 'visibility', 1.0) > 0.3 and getattr(lm[12], 'visibility', 1.0) > 0.3:
                                p1 = (int(lm[11].x * width), int(lm[11].y * height))
                                p2 = (int(lm[12].x * width), int(lm[12].y * height))
                                cv2.line(frame, p1, p2, (255, 255, 0), 2)

                            for idx in range(len(SKELETAL_CHAIN_LEFT) - 1):
                                s_i, e_i = SKELETAL_CHAIN_LEFT[idx], SKELETAL_CHAIN_LEFT[idx+1]
                                if getattr(lm[s_i], 'visibility', 1.0) > 0.3 and getattr(lm[e_i], 'visibility', 1.0) > 0.3:
                                    pt1 = (int(lm[s_i].x * width), int(lm[s_i].y * height))
                                    pt2 = (int(lm[e_i].x * width), int(lm[e_i].y * height))
                                    cv2.line(frame, pt1, pt2, (255, 255, 0), 2)

                            for idx in range(len(SKELETAL_CHAIN_RIGHT) - 1):
                                s_i, e_i = SKELETAL_CHAIN_RIGHT[idx], SKELETAL_CHAIN_RIGHT[idx+1]
                                if getattr(lm[s_i], 'visibility', 1.0) > 0.3 and getattr(lm[e_i], 'visibility', 1.0) > 0.3:
                                    pt1 = (int(lm[s_i].x * width), int(lm[s_i].y * height))
                                    pt2 = (int(lm[e_i].x * width), int(lm[e_i].y * height))
                                    cv2.line(frame, pt1, pt2, (255, 255, 0), 2)
                            
                            for j_idx in ALL_JOINTS:
                                if getattr(lm[j_idx], 'visibility', 1.0) > 0.3:
                                    cx, cy = int(lm[j_idx].x * width), int(lm[j_idx].y * height)
                                    cv2.circle(frame, (cx, cy), 10, (0, 0, 255), -1)
                                    cv2.circle(frame, (cx, cy), 12, (255, 255, 255), 2)
                                    
                            for j_idx, (j_label, s_side, m_key) in JOINT_METRIC_MAP.items():
                                if getattr(lm[j_idx], 'visibility', 1.0) > 0.3:
                                    cx, cy = int(lm[j_idx].x * width), int(lm[j_idx].y * height)
                                    val = series[s_side][m_key][fi] if fi < len(series[s_side][m_key]) else np.nan
                                    if not np.isnan(val):
                                        label_text = f"{val:.1f}deg"
                                        tx, ty = cx + 15, cy + 5
                                        if tx + 80 > width: tx = cx - 80
                                        cv2.putText(frame, label_text, (tx, ty), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 255), 2)

                        if fi in hs_lookup:
                            cv2.rectangle(frame, (width - 320, 10), (width - 10, 50), (0, 0, 200), -1)
                            cv2.putText(frame, f"HEEL STRIKE ({'+'.join(hs_lookup[fi])})", (width - 310, 38),
                                        cv2.FONT_HERSHEY_SIMPLEX, 0.75, (255, 255, 255), 2)
                            
                        writer1.write(frame)
                        writer2.write(frame)
                        fi += 1
        finally:
            cap2.release()
            writer1.release()
            writer2.release()

    total_strikes = sum(len(events[s]) for s in ("L", "R"))
    duration_real = total_frames / adjusted_fps
    cadence = total_strikes / (duration_real / 60) if duration_real > 0 else 0

    l_knee_peak = np.nanmax(mean_curves["L"]["knee_flexion"]) if not np.isnan(mean_curves["L"]["knee_flexion"]).all() else 0.0
    r_knee_peak = np.nanmax(mean_curves["R"]["knee_flexion"]) if not np.isnan(mean_curves["R"]["knee_flexion"]).all() else 0.0
    knee_si = symmetry_index([l_knee_peak], [r_knee_peak]) if (l_knee_peak or r_knee_peak) else 0.0

    l_hip_peak = np.nanmax(mean_curves["L"]["hip_flexion"]) if not np.isnan(mean_curves["L"]["hip_flexion"]).all() else 0.0
    r_hip_peak = np.nanmax(mean_curves["R"]["hip_flexion"]) if not np.isnan(mean_curves["R"]["hip_flexion"]).all() else 0.0
    hip_si = symmetry_index([l_hip_peak], [r_hip_peak]) if (l_hip_peak or r_hip_peak) else 0.0

    rom_extremes = {}
    for s in ("L", "R"):
        rom_extremes[s] = {
            "hip_max": np.nanmax(series[s]["hip_flexion"]) if len(series[s]["hip_flexion"]) > 0 else 0.0,
            "hip_min": np.nanmin(series[s]["hip_flexion"]) if len(series[s]["hip_flexion"]) > 0 else 0.0,
            "knee_max": np.nanmax(series[s]["knee_flexion"]) if len(series[s]["knee_flexion"]) > 0 else 0.0,
            "knee_min": np.nanmin(series[s]["knee_flexion"]) if len(series[s]["knee_flexion"]) > 0 else 0.0,
            "ankle_max_df": np.nanmax(series[s]["ankle_angle"]) if len(series[s]["ankle_angle"]) > 0 else 0.0,
            "ankle_max_pf": np.nanmin(series[s]["ankle_angle"]) if len(series[s]["ankle_angle"]) > 0 else 0.0,
        }

    diagnostic_text = generate_clinical_diagnostic_block(series)

    report_lines = [
        "=" * 60,
        "ORTHOPEDIC EYE GAIT ANALYSIS REPORT",
        "=" * 60,
        "Developed by: Muhammad Mehr Ali (Prosthetist & Orthotist)",
        f"Video Target: {video_path}",
        f"FPS used: {fps:.2f} | Total frames: {total_frames} | Duration: {duration_real:.1f}s",
        "",
        "-- Sagittal Plane Extremity Range Breakdown --",
        f"  Left Hip Joint: Max Flexion = {rom_extremes['L']['hip_max']:.1f}° | Max Extension = {rom_extremes['L']['hip_min']:.1f}°",
        f"  Right Hip Joint: Max Flexion = {rom_extremes['R']['hip_max']:.1f}° | Max Extension = {rom_extremes['R']['hip_min']:.1f}°",
        f"  Left Knee Joint: Max Flexion = {rom_extremes['L']['knee_max']:.1f}° | Max Extension = {rom_extremes['L']['knee_min']:.1f}°",
        f"  Right Knee Joint: Max Flexion = {rom_extremes['R']['knee_max']:.1f}° | Max Extension = {rom_extremes['R']['knee_min']:.1f}°",
        f"  Left Ankle Joint: Max Dorsiflexion = {max(0, rom_extremes['L']['ankle_max_df']):.1f}° | Max Plantarflexion = {abs(min(0, rom_extremes['L']['ankle_max_pf'])):.1f}°",
        f"  Right Ankle Joint: Max Dorsiflexion = {max(0, rom_extremes['R']['ankle_max_df']):.1f}° | Max Plantarflexion = {abs(min(0, rom_extremes['R']['ankle_max_pf'])):.1f}°",
        f"  Trunk Lean Displacement: {np.nanmin(trunk_lean):.1f}° to {np.nanmax(trunk_lean):.1f}°",
        f"  Head Tilt Displacement: {np.nanmin(head_tilt):.1f}° to {np.nanmax(head_tilt):.1f}°",
        "",
        "-- Spatio-Temporal Parameters --",
        f"  Calculated Cadence: {cadence:.1f} steps/min",
        f"  Left Stride Duration: {np.mean(stride_times['L']):.2f}s" if len(stride_times['L']) > 0 else "  Left Stride Duration: N/A",
        f"  Right Stride Duration: {np.mean(stride_times['R']):.2f}s" if len(stride_times['R']) > 0 else "  Right Stride Duration: N/A",
        f"  Stride Duration Symmetry Index: {symmetry_index(stride_times['L'], stride_times['R']):.1f}%",
        f"  Peak Knee Flexion Symmetry Index: {knee_si:.1f}%",
        "",
        "=" * 60,
        "AUTOMATED CLINICAL INTERPRETATION & KINEMATIC INSIGHTS",
        "=" * 60,
        diagnostic_text,
        "=" * 60
    ]
    
    with open("gait_report.txt", "w", encoding="utf-8") as f:
        f.write("\n".join(report_lines))

    cycle_df = pd.DataFrame({
        "gait_cycle_pct": np.linspace(0, 100, 101),
        "L_hip_flexion_deg": mean_curves["L"]["hip_flexion"],
        "R_hip_flexion_deg": mean_curves["R"]["hip_flexion"],
        "L_knee_flexion_deg": mean_curves["L"]["knee_flexion"],
        "R_knee_flexion_deg": mean_curves["R"]["knee_flexion"],
        "L_ankle_angle_deg": mean_curves["L"]["ankle_angle"],
        "R_ankle_angle_deg": mean_curves["R"]["ankle_angle"],
    })

    return {
        "cadence": f"{cadence:.1f} steps/min",
        "left_stride": f"{np.mean(stride_times['L']):.2f}s" if len(stride_times['L']) > 0 else "N/A",
        "right_stride": f"{np.mean(stride_times['R']):.2f}s" if len(stride_times['R']) > 0 else "N/A",
        "stride_si": f"{symmetry_index(stride_times['L'], stride_times['R']):.1f}%",
        "left_knee_peak": f"{l_knee_peak:.1f}°" if l_knee_peak else "N/A",
        "right_knee_peak": f"{r_knee_peak:.1f}°" if r_knee_peak else "N/A",
        "knee_flexion_si": f"{knee_si:.1f}%",
        "left_hip_peak": f"{l_hip_peak:.1f}°" if l_hip_peak else "N/A",
        "right_hip_peak": f"{r_hip_peak:.1f}°" if r_hip_peak else "N/A",
        "hip_flexion_si": f"{knee_si:.1f}%",
        "rom_extremes": rom_extremes,
        "trunk_lean_range": f"{np.nanmin(trunk_lean):.1f}° to {np.nanmax(trunk_lean):.1f}°",
        "head_tilt_range": f"{np.nanmin(head_tilt):.1f}° to {np.nanmax(head_tilt):.1f}°",
        "diagnostic_text": diagnostic_text,
        "cycle_df": cycle_df,
        "overlay_video_path": overlay_video_path
    }