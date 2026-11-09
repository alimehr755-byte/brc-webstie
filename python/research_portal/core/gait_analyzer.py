#!/usr/bin/env python3
"""
Gait Analyzer - Core Module
Implements coronal plane gait analysis using ISB coordinate system standards.
"""

import numpy as np
from typing import List, Tuple, Dict, Optional
from dataclasses import dataclass


@dataclass
class JointAngles:
    """Joint angle measurements in degrees."""
    hip_flexion: float
    knee_flexion: float
    ankle_dorsiflexion: float
    pelvic_obliquity: float
    trunk_rotation: float


@dataclass
class GaitPhase:
    """Gait cycle phase information."""
    name: str
    start_percent: float
    end_percent: float
    duration_percent: float


class GaitAnalyzer:
    """
    Core gait analysis engine for coronal plane gait analysis.
    Computes joint angles, gait phases, and clinical metrics from 3D joint coordinates.
    """

    def __init__(self):
        self.gait_phases = [
            {"name": "Initial Contact", "start": 0, "end": 10, "type": "stance"},
            {"name": "Loading Response", "start": 10, "end": 30, "type": "stance"},
            {"name": "Mid Stance", "start": 30, "end": 50, "type": "stance"},
            {"name": "Terminal Stance", "start": 50, "end": 60, "type": "stance"},
            {"name": "Pre Swing", "start": 60, "end": 70, "type": "stance"},
            {"name": "Initial Swing", "start": 70, "end": 80, "type": "swing"},
            {"name": "Mid Swing", "start": 80, "end": 87, "type": "swing"},
            {"name": "Terminal Swing", "start": 87, "end": 100, "type": "swing"},
        ]

    def calculate_3d_angle(self, a: np.ndarray, b: np.ndarray, c: np.ndarray) -> float:
        """
        Calculate 3D angle at joint_b formed by points a-b-c.
        Returns angle in degrees.
        """
        ab = a - b
        cb = c - b
        cos_angle = np.dot(ab, cb) / (np.linalg.norm(ab) * np.linalg.norm(cb))
        cos_angle = np.clip(cos_angle, -1.0, 1.0)
        return float(np.degrees(np.arccos(cos_angle)))

    def calculate_pelvic_obliquity(self, left_hip: np.ndarray, right_hip: np.ndarray) -> float:
        """Calculate pelvic obliquity in degrees."""
        hip_vector = right_hip - left_hip
        horizontal = np.array([1.0, 0.0, 0.0])
        cos_angle = np.dot(hip_vector, horizontal) / np.linalg.norm(hip_vector)
        cos_angle = np.clip(cos_angle, -1.0, 1.0)
        return float(np.degrees(np.arccos(cos_angle)))

    def calculate_trunk_rotation(self, left_shoulder: np.ndarray, right_shoulder: np.ndarray,
                                 left_hip: np.ndarray, right_hip: np.ndarray) -> float:
        """Calculate trunk-pelvis counter-rotation angle in degrees."""
        trunk_vector = right_shoulder - left_shoulder
        pelvic_vector = right_hip - left_hip
        trunk_vector_norm = trunk_vector / np.linalg.norm(trunk_vector)
        pelvic_vector_norm = pelvic_vector / np.linalg.norm(pelvic_vector)
        cos_angle = np.dot(trunk_vector_norm, pelvic_vector_norm)
        cos_angle = np.clip(cos_angle, -1.0, 1.0)
        return float(np.degrees(np.arccos(cos_angle)))

    def normalize_gait_cycle(self, time_series_data: np.ndarray, cycle_start: int,
                             cycle_end: int) -> np.ndarray:
        """Normalize gait cycle data to 0-100% cycle (101 points)."""
        cycle_data = time_series_data[cycle_start:cycle_end + 1]
        normalized_indices = np.linspace(0, len(cycle_data) - 1, 101)
        normalized_data = np.interp(normalized_indices, np.arange(len(cycle_data)), cycle_data)
        return normalized_data

    def detect_gait_events(self, heel_positions: np.ndarray, pelvis_positions: np.ndarray,
                           sample_rate: float = 100.0) -> dict:
        """
        Detect gait events (initial contact, toe-off) from kinematic data.
        Returns dictionary with event indices.
        """
        # Calculate anterior-posterior position of heel relative to pelvis
        heel_relative_x = heel_positions[:, 0] - pelvis_positions[:, 0]

        # Smooth the signal
        from scipy.signal import savgol_filter
        heel_smooth = savgol_filter(heel_rel_x, window_length=5, polyorder=2)

        # Find initial contacts (local maxima of anterior position)
        from scipy.signal import find_peaks
        ic_indices, _ = signal.find_peaks(heel_smooth, distance=int(0.6 * sample_rate))

        # Find toe-offs (local minima of posterior position)
        toe_smooth = -heel_smooth  # Invert to find minima
        toe_indices, _ = signal.find_peaks(toe_smooth, distance=int(0.6 * sample_rate))

        return {
            "initial_contacts": ic_indices.tolist(),
            "toe_offs": toe_indices.tolist()
        }

    def calculate_spatio_temporal_metrics(self, ic_frames: list, toe_frames: list,
                                          sampling_rate: float) -> list:
        """Calculate spatiotemporal gait parameters."""
        results = []

        for i in range(len(ic_frames) - 1):
            ic1 = ic_frames[i]
            ic2 = ic_frames[i + 1]

            # Find toe-off between IC1 and IC2
            valid_to = [t for t in toe_frames if ic1 < t < ic_frames[i + 1]]
            if not valid_to:
                continue

            to = valid_to[0]

            # Temporal calculations
            cycle_time = (ic2 - ic1) / sampling_rate
            stance_time = (to - ic1) / sampling_rate
            swing_time = (ic2 - to) / sampling_rate

            stance_pct = (t_stance / t_cycle) * 100
            swing_pct = (t_swing / t_cycle) * 100

            results.append({
                "cycle_time_s": t_cycle,
                "stance_time_s": t_stance,
                "swing_time_s": t_swing,
                "stance_pct": stance_pct,
                "swing_pct": swing_pct,
                "cadence": 60 / t_cycle if t_cycle > 0 else 0
            })

        return results


if __name__ == "__main__":
    # Example usage
    analyzer = GaitAnalyzer()

    # Test angle calculation
    hip = np.array([0.5, 0.0, 0.0])
    knee = np.array([0.5, -0.4, 0.0])
    ankle = np.array([0.5, -0.8, 0.0])

    knee_flexion = analyzer.calculate_3d_angle(hip, knee, ankle)
    print(f"Knee flexion angle: {knee_flexion:.2f} degrees")