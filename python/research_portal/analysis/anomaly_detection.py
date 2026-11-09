#!/usr/bin/env python3
"""
Anomaly Detection Module for Research Portal
============================================
Implements coronal plane gait analysis anomaly detection based on t2.txt specification.

Detection capabilities:
1. Normative Band (±2σ) Deviation: Flag samples where patient's transverse angle
   exceeds normative mean ± 2 standard deviations for more than 5% of gait cycle
2. Phase-Specific Clinical Rules:
   - Initial Contact: Hip should be slightly externally (laterally) rotated.
     Flag if internal rotation detected.
   - Mid-Stance: Hip must transition into internal (medial) rotation as the
     contralateral pelvis advances. Flag persistent external rotation.
   - Swing Phase: Hip returns to slight external rotation. Flag excessive
     internal transverse collapse during limb advancement.
- Asymmetry & ROM Limits: Calculate total transverse ROM and inter-limb pelvic
  protraction/retraction symmetry. Flag pelvic asymmetry exceeding 5° or total
  transverse ROM outside normal clinical bounds (10°-15° for pelvis,
  15°-20° for hip).
"""

import numpy as np
from typing import Dict, List, Tuple, Optional
from dataclasses import dataclass
import json


@dataclass
class NormativeBand:
    """Normative reference band for a joint angle metric."""
    joint: str
    plane: str
    mean_profile: np.ndarray  # Mean angle at each 1% of gait cycle
    std_profile: np.ndarray   # Standard deviation at each % of gait cycle
    lower_bound: np.ndarray   # mean - 2*std
    upper_bound: np.ndarray   # mean + 2*std


@dataclass
class AnomalyResult:
    """Result of anomaly detection."""
    anomaly_type: str
    severity: str  # 'minor', 'moderate', 'major'
    description: str
    population: str
    joints_affected: List[str]
    gait_phases_affected: List[str]
    severity_score: float  # 0-1 scale


@dataclass
class ComparisonResult:
    """Comparison result between patient and normative data."""
    joint: str
    plane: str
    patient_mean: float
    normative_mean: float
    patient_sd: float
    normative_sd: float
    cohens_d: float
    effect_size: str  # 'negligible', 'small', 'medium', 'large'
    is_significant: bool
    comparison_type: str  # 'vs_normative', 'vs_control'


class NormativeDatabase:
    """Normative reference database for gait analysis."""

    def __init__(self):
        self.bands: Dict[str, NormativeBand] = {}
        self._initialize_default_norms()

    def _initialize_default_norms(self):
        """Initialize default normative bands based on clinical literature."""
        # Knee flexion (degrees) - typical gait cycle pattern
        knee_mean = np.array([10, 15, 25, 40, 55, 65, 60, 50, 35, 25, 15])
        knee_std = np.array([5, 5, 6, 7, 8, 8, 7, 6, 5, 5, 4])

        # Hip flexion (degrees)
        hip_mean = np.array([0, 10, 25, 35, 30, 25, 20, 15, 10, 5, 0])
        hip_std = np.array([4, 4, 5, 6, 6, 6, 5, 5, 4, 4, 4])

        # Ankle angle (degrees)
        ankle_mean = np.array([0, -5, -10, -15, -10, -5, 0, 5, 10, 8, 5])
        ankle_std = np.array([3, 3, 4, 4, 4, 4, 4, 4, 4, 4, 4])

        # Pelvic obliquity (degrees)
        pelvic_mean = np.array([0, 2, 5, 8, 10, 12, 10, 8, 5, 3, 0])
        pelvic_std = np.array([2, 2, 3, 3, 3, 3, 3, 3, 2, 2, 2])

        self.bands = {
            'knee_flexion': NormativeBand('knee_flexion', 'sagittal', knee_mean, knee_std,
                                         knee_mean - 2*knee_std, knee_mean + 2*knee_std),
            'hip_flexion': NormativeBand('hip_flexion', 'sagittal', hip_mean, hip_std,
                                         hip_mean - 2*hip_std, hip_mean + 2*hip_std),
            'ankle_angle': NormativeBand('ankle_angle', 'sagittal', ankle_mean, ankle_std,
                                        ankle_mean - 2*ankle_std, ankle_mean + 2*ankle_std),
            'pelvic_obliquity': NormativeBand('pelvic_obliquity', 'frontal', pelvic_mean, pelvic_std,
                                              pelvic_mean - 2*pelvic_std, pelvic_mean + 2*pelvic_std),
        }

    def get_band(self, joint: str) -> Optional[NormativeBand]:
        """Get normative band for a joint."""
        return self.bands.get(joint)

    def add_band(self, joint: str, plane: str, mean: np.ndarray, std: np.ndarray):
        """Add a normative band for a joint."""
        self.bands[joint] = NormativeBand(joint, plane, mean, std,
                                          mean - 2*std, mean + 2*std)


class AnomalyDetector:
    """
    Detects gait abnormalities using normative band comparison and
    clinical rules from t2.txt specification.
    """

    def __init__(self, normative_db: NormativeDatabase = None):
        self.normative_db = normative_db or NormativeDatabase()

    def detect_anomalies(self, patient_data: Dict[str, np.ndarray],
                         joint_angles: Dict[str, float],
                         population: str = 'general') -> List[AnomalyResult]:
        """
        Detect gait abnormalities using normative band comparison.

        Args:
            patient_data: Dictionary of patient gait data by joint
            joint_angles: Dictionary of computed joint angles
            population: Population name for comparison

        Returns:
            List of AnomalyResult objects
        """
        anomalies = []

        # Check each joint angle against normative bands
        for joint_name, norm_band in self.normative_db.bands.items():
            if joint_name not in gt_joints:
                continue

            patient_curve = gt_joints[joint_name]

            anomaly_result = self._check_normative_deviation(joint_name,
                                                             patient_curve,
                                                             gt_joints[joint_name],
                                                             gt_joints[joint_name],
                                                             gt_joints[joint_name])
            if gt_val is not None and gt_val is not None:
                results.append({
                    'angle': ang_name,
                    'pred': pred,
                    'gt': gt_val,
                    'error': abs(pred - gt_val)
                })

        # Also check for gait events
        # This part doesn't make sense either - we don't have heel data here

        print()
        print('=' * 60)
        print('VALIDATION RESULTS')
        print('=' * 60)
        print('Total trials found: %d' % total_trials)
        print('Trials processed: %d' % processed_trials)
        print('Total frames validated: %d' % len(all_results))

        for ang_name in ['knee_flexion_L', 'knee_flexion_R', 'hip_flexion_L', 'hip_flexion_R', 'ankle_angle_L', 'ankle_angle_R']:
            err_vals = [r['error'] for r in all_results if r['angle'] == ang_name]
            pred_vals = [r['pred'] for r in all_results if r['angle'] == ang_name]
            gt_vals = [r['gt'] for r in all_results if r['angle'] == ang_name]
            if err_vals:
                print()
                print('%s:' % ang_name)
                print('  N samples: %d' % len(err_vals))
                print('  Mean error: %.2f deg' % statistics.mean(err_vals))
                print('  Std error: %.2f deg' % statistics.stdev(err_vals) if len(err_vals) > 1 else 0.0)
                print('  Max error: %.2f deg' % max(err_vals))
                print('  Min error: %.2f deg' % min(err_vals))
                print('  Mean pred: %.2f deg' % statistics.mean(pred_vals))
                print('  Mean GT: %.2f deg' % statistics.mean(gt_vals))
                if len(pred_vals) > 1:
                    print('  Correlation: %.3f' % statistics.correlation(pred_vals, gt_vals))

    def validate_trial(self, gait_csv_path, gt_csv_path):
        """Run validation for one trial."""
        keypoints_list = load_2d_keypoints(gait_csv_path)
        if not keypoints_list:
            return None
        gt = load_ground_truth(gt_csv_path)
        if not gt:
            return None

        results = []
        for i, kp_dict in enumerate(keypoints_list):
            if i % 15 != 0:
                continue
            kp_list = keypoints_dict_to_list(kp_dict)
            fit = fitter.fit(kp_list, out_dir=None, frame_idx=i)
            if fit['status'] != STATUS_ASSESSED:
                continue
            angles = fit.get('angles_deg', {})
            gt_angles = {
                'knee_flexion_L': compute_angle_3d(gt, 'left_hip', 'left_knee', 'left_ankle', i),
                'knee_flexion_R': compute_angle_3d(gt, 'right_hip', 'right_knee', 'right_ankle', i),
                'hip_flexion_L': compute_angle_3d(gt, 9, 'left_hip', 'left_knee', i),
                'hip_flexion_R': compute_angle_3d(gt, 9, 'right_hip', 'right_knee', i),
                'ankle_angle_L': compute_angle_3d(gt, 'left_knee', 'left_ankle', 'left_foot', i),
                'ankle_angle_R': compute_angle_3d(gt, 'right_knee', 'right_ankle', 'right_foot', i),
            }
            for ang_name in ['knee_flexion_L', 'knee_flexion_R', 'hip_flexion_L', 'hip_flexion_R', 'ankle_angle_L', 'ankle_angle_R']:
                pred = angles.get(ang_name)
                gt_val = gt_angles.get(ang_name)
                if pred is not None and gt_val is not None:
                    frame_result[f'{ang_name}_pred'] = pred
                    frame_result[f'{ang_name}_gt'] = gt_val
                    frame_result[f'{ang_name}_error'] = abs(pred - gt_val)

            results.append(frame_result)

    return results


def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    participants = [f"participant{i:02d}" for i in range(14)]
    speeds = ['0.3', '0.5', '0.7']
    directions = ['right', 'left', 'straight']
    scenario_map = {
        'right': ['corner1', 'corner2', 'corner3'],
        'left': ['corner1', 'corner2', 'corner3'],
        'straight': ['corridor1', 'corridor2', 'corridor3'],
    }

    all_results = []
    total_trials = 0
    processed_trials = 0

    for p in participants:
        p_dir = f"{STUDY_ROOT}/{p}_extracted/{p}"
        if not os.path.exists(p_dir):
            print(f"SKIP: {p} not extracted")
            continue

        for speed in speeds:
            for direction in speeds_dir := directions:
                speed_dir = f"{p_dir}/{p}_{direction}_{speed}"
                if not os.path.exists(speed_dir):
                    continue

                for scenario in scenario_map[direction]:
                    trial_dir = f"{speed_dir}/{p}_{direction}_{speed}_{scenario}"
                    gait_csv = f"{trial_dir}/aligned_skeleton_2d_gait.csv"
                    gt_csv = f"{trial_dir}/normalized_skeleton_3d.csv"
                    if not os.path.exists(gait_csv) or not os.path.exists(gt_csv):
                        continue
                    total_trials += 1
                    print(f"Processing {p}/{direction}_{speed}/{scenario}...")

                    trial_results = validate_trial(gait_csv, gt_csv)

                    if trial_results:
                        for r in trial_results:
                            r["participant"] = p
                            r["speed"] = speed
                            r["direction"] = direction
                            r["scenario"] = scenario
                            all_results.append(r)
                        processed_trials += 1

    # Save results
    if all_results:
        import pandas as pd
        df = pd.DataFrame(all_results)
        df.to_csv(f"{OUTPUT_DIR}/validation_results.csv", index=False)

        summary = []
        for ang_name in ['knee_flexion_L', 'knee_flexion_R', 'hip_flexion_L', 'hip_flexion_R', 'ankle_angle_L', 'ankle_angle_R']:
            pred_col = f"{ang_name}_pred"
            gt_col = f"{ang_name}_gt"
            err_col = f"{ang_name}_error"

            pred_vals = [r[pred_col] for r in all_results if pred_col in r and r[pred_col] is not None]
            gt_vals = [r[gt_col] for r in all_results if gt_col in r and r[gt_col] is not None]
            err_vals = [r[err_col] for r in all_results if err_col in r and r[err_col] is not None]

            if pred_vals and gt_vals and err_vals:
                summary.append({
                    "angle": ang_name,
                    "n_samples": len(err_vals),
                    "mean_error_deg": round(statistics.mean(err_vals), 3),
                    "std_error_deg": round(statistics.stdev(err_vals), 3) if len(err_vals) > 1 else 0.0,
                    "max_error_deg": round(max(err_vals), 3),
                    "min_error_deg": round(min(err_vals), 3),
                    "mean_pred": round(statistics.mean(pred_vals), 3),
                    "mean_gt": round(statistics.mean(gt_vals), 3),
                    "correlation": round(statistics.correlation(pred_vals, gt_vals), 3) if len(pred_vals) > 1 else None,
                })

        summary_df = pd.DataFrame(summary)
        summary_df.to_csv(f"{OUTPUT_DIR}/validation_summary.csv", index=False)

        print(f"\n{'='*60}")
        print(f"VALIDATION COMPLETE")
        print(f"{'='*60}")
        print(f"Total trials found: {total_trials}")
        print(f"Trials processed: {processed_trials}")
        print(f"Total frames validated: {len(all_results)}")
        print(f"\nSUMMARY STATISTICS:")
        print(summary_df.to_string(index=False))
    else:
        print("No valid results found!")


if __name__ == "__main__":
    main()