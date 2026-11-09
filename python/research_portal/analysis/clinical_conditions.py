# Phase 2: Deepen Frontal, Sagittal, Transverse Plane Measures
# This module adds foot progression angle (FPA), clinical condition mapping,
# and cross-plane analysis to the existing gait_lab.py.
#
# Key additions:
# 1. Foot Progression Angle (FPA) - transverse plane measure from frontal video
# 2. Clinical condition mapping per plane (Trendelenburg, waddling, scissoring, ataxic, genu varum/valgum)
# 3. Cross-plane correlation analysis

import numpy as np
from typing import Dict, List, Tuple, Optional
import json
import math

# Clinical conditions mapped to planes
CLINICAL_CONDITIONS = {
    "frontal": {
        "Trendelenburg": {
            "description": "Pelvic drop on contralateral side during single-limb stance",
            "indicators": ["pelvic_obliquity", "hip_abduction", "trunk_lean"],
            "thresholds": {"pelvic_obliquity": 4.0, "hip_abduction": 15.0, "trunk_lean": 8.0},
        },
        "Genu_varum": {
            "description": "Bow-leg alignment - knee varus",
            "indicators": ["knee_valgus", "tibiofemoral_axis"],
            "thresholds": {"knee_valgus": -5.0, "tibiofemoral_axis": 5.0},
        },
        "Genu_valgum": {
            "description": "Knock-knee alignment - knee valgus",
            "indicators": ["knee_valgus", "tibiofemoral_axis"],
            "thresholds": {"knee_valgus": 5.0, "tibiofemoral_axis": 5.0},
        },
        "Waddling": {
            "description": "Bilateral pelvic drop with wide base",
            "indicators": ["pelvic_obliquity", "step_width", "trunk_lean"],
            "thresholds": {"pelvic_obliquity": 4.0, "step_width": 0.25, "trunk_lean": 8.0},
        },
        "Scissoring": {
            "description": "Legs crossing midline during swing (adductor spasticity)",
            "indicators": ["step_width", "knee_valgus"],
            "thresholds": {"step_width": -0.15, "knee_valgus": 5.0},
        },
        "Ataxic": {
            "description": "Wide base, irregular steps, staggering",
            "indicators": ["step_width", "trunk_lean", "head_tilt"],
            "thresholds": {"step_width": 0.3, "trunk_lean": 10.0, "head_tilt": 5.0},
        },
    },
    "sagittal": {
        "Crouch_gait": {
            "description": "Excessive knee flexion throughout stance",
            "indicators": ["knee_flexion", "hip_flexion", "pelvic_tilt"],
            "thresholds": {"knee_flexion": 20.0, "hip_flexion": 15.0},
        },
        "Stiff_knee": {
            "description": "Reduced peak knee flexion in swing",
            "indicators": ["knee_flexion", "ankle_angle"],
            "thresholds": {"knee_flexion": 40.0, "ankle_angle": -5.0},
        },
        "Equinus": {
            "description": "Drop foot / reduced dorsiflexion",
            "indicators": ["ankle_angle", "knee_flexion"],
            "thresholds": {"ankle_angle": -30.0, "knee_flexion": 5.0},
        },
        "Vaulting": {
            "description": "Early plantarflexion to clear limb",
            "indicators": ["ankle_angle", "knee_flexion"],
            "thresholds": {"ankle_angle": -35.0, "knee_flexion": 5.0},
        },
        "Hip_hiking": {
            "description": "Pelvic elevation on swing side",
            "indicators": ["pelvic_obliquity", "trunk_lean"],
            "thresholds": {"pelvic_obliquity": 6.0, "trunk_lean": 8.0},
        },
        "Circumduction": {
            "description": "Wide arc swing for foot clearance",
            "indicators": ["step_width", "trunk_lean"],
            "thresholds": {"step_width": 0.35, "trunk_lean": 8.0},
        },
        "Steppage": {
            "description": "Excessive hip/knee flexion for foot clearance",
            "indicators": ["hip_flexion", "knee_flexion"],
            "thresholds": {"hip_flexion": 45.0, "knee_flexion": 60.0},
        },
        "Antalgic": {
            "description": "Shortened stance on painful limb",
            "indicators": ["stance_pct", "step_width"],
            "thresholds": {"stance_pct": 50.0, "step_width": 0.3},
        },
    },
    "transverse": {
        "Femoral_anteversion": {
            "description": "Excessive medial rotation of femur (into-toeing)",
            "indicators": ["hip_rotation", "foot_progression_angle"],
            "thresholds": {"hip_rotation": -10.0, "foot_progression_angle": -10.0},
        },
        "External_tibial_torsion": {
            "description": "Outward rotation of tibia (foot-out-toeing)",
            "indicators": ["foot_progression_angle", "hip_rotation"],
            "thresholds": {"foot_progression_angle": 15.0, "hip_rotation": 10.0},
        },
        "Internal_tibial_torsion": {
            "description": "Inward rotation of tibia (into-toeing)",
            "indicators": ["foot_progression_angle", "hip_rotation"],
            "thresholds": {"foot_progression_angle": -10.0, "hip_rotation": -5.0},
        },
        "Hip_internal_rotation": {
            "description": "Persistent medial rotation at hip during stance",
            "indicators": ["hip_rotation"],
            "thresholds": {"hip_rotation": -5.0},
        },
        "Pelvic_asymmetry": {
            "description": "Pelvic rotation asymmetry > 5°",
            "indicators": ["pelvic_rotation"],
            "thresholds": {"pelvic_rotation": 5.0},
        },
    },
}


def compute_foot_progression_angle(hip_x, ankle_x, foot_x, side="L"):
    """
    Compute foot progression angle (FPA) in degrees.
    FPA is the angle between the foot's long axis and the direction of walking.

    In a frontal view, we estimate FPA from the relative positions of
    hip, ankle, and foot (toe) markers.

    Args:
        hip_x: x-coordinate of hip joint
        ankle_x: x-coordinate of ankle joint
        foot_x: x-coordinate of foot (toe) joint
        side: 'L' or 'R' (left or right)

    Returns:
        Foot progression angle in degrees (positive = toe-out, negative = toe-in)
    """
    if abs(hip_x - ankle_x) < 1e-6:
        return 0.0

    # Direction of walking (approximated by hip-to-ankle vector)
    walk_dir = ankle_x - hip_x

    # Foot direction (approximated by ankle-to-toe vector)
    foot_dir = foot_x - ankle_x

    # Angle between walking direction and foot direction
    if abs(walk_dir) < 1e-6 or abs(foot_dir) < 1e-6:
        return 0.0

    # Compute angle using arctan
    angle_rad = math.atan2(foot_dir, walk_dir)
    angle_deg = math.degrees(angle_rad)

    # Normalize to [-180, 180]
    if angle_deg > 180:
        angle_deg -= 360
    elif angle_deg < -180:
        angle_deg += 360

    return angle_deg


def detect_clinical_conditions_frontal(metrics):
    """
    Detect clinical conditions from frontal plane metrics.

    Args:
        metrics: Dictionary of frontal plane metrics

    Returns:
        List of detected conditions with severity
    """
    conditions = []

    pelvic_obl = metrics.get("pelvic_obliquity_max", 0)
    trunk_lean = metrics.get("lateral_trunk_lean_max", 0)
    knee_valgus = metrics.get("knee_valgus_mean", 0)
    step_width = metrics.get("step_width_mean", 0)
    tfa_dev = metrics.get("tibiofemoral_dev_max", 0)
    wshift = metrics.get("weight_shift_max", 0)
    sas = metrics.get("shoulder_asymmetry_index", 0)
    head_tilt = metrics.get("head_lateral_tilt_max", 0)

    # Trendelenburg
    if pelvic_obl > 4.0 and trunk_lean > 8.0:
        conditions.append({
            "name": "Trendelenburg",
            "severity": "moderate",
            "plane": "frontal",
            "description": "Pelvic drop on contralateral side during single-limb stance",
            "indicators": f"pelvic_obliquity={pelvic_obl:.1f}°, trunk_lean={trunk_lean:.1f}°",
        })

    # Genu varum
    if knee_valgus < -5.0 and tfa_dev > 5.0:
        conditions.append({
            "name": "Genu varum",
            "severity": "moderate",
            "plane": "frontal",
            "description": "Bow-leg alignment - knee varus",
            "indicators": f"knee_valgus={knee_valgus:.1f}°, tfa_dev={tfa_dev:.1f}°",
        })

    # Genu valgum
    if knee_valgus > 5.0 and tfa_dev > 5.0:
        conditions.append({
            "name": "Genu valgum",
            "severity": "moderate",
            "plane": "frontal",
            "description": "Knock-knee alignment - knee valgus",
            "indicators": f"knee_valgus={knee_valgus:.1f}°, tfa_dev={tfa_dev:.1f}°",
        })

    # Waddling
    if pelvic_obl > 4.0 and step_width > 0.25 and trunk_lean > 8.0:
        conditions.append({
            "name": "Waddling",
            "severity": "moderate",
            "plane": "frontal",
            "description": "Bilateral pelvic drop with wide base",
            "indicators": f"pelvic_obliquity={pelvic_obl:.1f}°, step_width={step_width:.2f}, trunk_lean={trunk_lean:.1f}°",
        })

    # Scissoring
    if step_width < -0.15 and knee_valgus > 5.0:
        conditions.append({
            "name": "Scissoring",
            "severity": "moderate",
            "plane": "frontal",
            "description": "Legs crossing midline during swing (adductor spasticity)",
            "indicators": f"step_width={step_width:.2f}, knee_valgus={knee_valgus:.1f}°",
        })

    # Ataxic
    if step_width > 0.3 and trunk_lean > 10.0 and head_tilt > 5.0:
        conditions.append({
            "name": "Ataxic",
            "severity": "moderate",
            "plane": "frontal",
            "description": "Wide base, irregular steps, staggering",
            "indicators": f"step_width={step_width:.2f}, trunk_lean={trunk_lean:.1f}°, head_tilt={head_tilt:.1f}°",
        })

    return conditions


def detect_clinical_conditions_sagittal(metrics):
    """
    Detect clinical conditions from sagittal plane metrics.
    """
    conditions = []

    knee_min = metrics.get("knee_min", 0)
    knee_max = metrics.get("knee_max", 0)
    ankle_pf = metrics.get("ankle_max_pf", 0)
    ankle_df = metrics.get("ankle_max_df", 0)
    hip_flex = metrics.get("hip_max", 0)
    stance_pct = metrics.get("stance_pct", 60)

    # Crouch gait
    if knee_min > 15.0 and hip_flex > 15.0:
        conditions.append({
            "name": "Crouch gait",
            "severity": "moderate",
            "plane": "sagittal",
            "description": "Excessive knee flexion throughout stance",
            "indicators": f"knee_min={knee_min:.1f}°, hip_flex={hip_flex:.1f}°",
        })

    # Stiff knee
    if knee_max < 40.0:
        conditions.append({
            "name": "Stiff knee",
            "severity": "moderate",
            "plane": "sagittal",
            "description": "Reduced peak knee flexion in swing",
            "indicators": f"knee_max={knee_max:.1f}°",
        })

    # Equinus
    if ankle_pf < -30.0:
        conditions.append({
            "name": "Equinus",
            "severity": "moderate",
            "plane": "sagittal",
            "description": "Drop foot / reduced dorsiflexion",
            "indicators": f"ankle_pf={ankle_pf:.1f}°",
        })

    # Vaulting
    if ankle_pf < -35.0 and knee_min > 5.0:
        conditions.append({
            "name": "Vaulting",
            "severity": "moderate",
            "plane": "sagittal",
            "description": "Early plantarflexion to clear limb",
            "indicators": f"ankle_pf={ankle_pf:.1f}°, knee_min={knee_min:.1f}°",
        })

    # Hip hiking
    pel = metrics.get("pelvic_obliquity", 0)
    trunk_lean = metrics.get("trunk_lean", 0)
    step_width = metrics.get("step_width", 0)
    hip_flex = metrics.get("hip_flex", 0)
    if pel > 6.0 and trunk_lean > 8.0:
        conditions.append({
            "name": "Hip hiking",
            "severity": "moderate",
            "plane": "sagittal",
            "description": "Pelvic elevation on swing side",
            "indicators": f"pelvic_obliquity={pel:.1f} deg, trunk_lean={trunk_lean:.1f} deg",
        })

    # Circumduction
    step_width = metrics.get("step_width", 0)
    trunk_lean = metrics.get("trunk_lean", 0)
    if step_width > 0.35 and trunk_lean > 8.0:
        conditions.append({
            "name": "Circumduction",
            "severity": "moderate",
            "plane": "sagittal",
            "description": "Wide arc swing for foot clearance",
            "indicators": f"step_width={step_width:.2f}, trunk_lean={trunk_lean:.1f} deg",
        })

    # Steppage
    if hip_flex > 45.0 and knee_max > 60.0:
        conditions.append({
            "name": "Steppage",
            "severity": "moderate",
            "plane": "sagittal",
            "description": "Excessive hip/knee flexion for foot clearance",
            "indicators": f"hip_flex={hip_flex:.1f}°, knee_max={knee_max:.1f}°",
        })

    # Antalgic
    stance_pct = metrics.get("stance_pct", 60.0)
    step_width = metrics.get("step_width", 0)
    if stance_pct < 50.0 and step_width > 0.3:
        conditions.append({
            "name": "Antalgic",
            "severity": "moderate",
            "plane": "sagittal",
            "description": "Shortened stance on painful limb",
            "indicators": f"stance_pct={stance_pct:.1f}%, step_width={step_width:.2f}",
        })

    return conditions


def detect_clinical_conditions_transverse(metrics):
    """
    Detect clinical conditions from transverse plane metrics.
    """
    conditions = []

    hip_rot = metrics.get("hip_rotation", 0)
    fpa = metrics.get("foot_progression_angle", 0)
    pelvic_rot = metrics.get("pelvic_rotation", 0)
    trunk_rot = metrics.get("trunk_rotation", 0)

    # Femoral anteversion
    if hip_rot < -10.0 and fpa < -10.0:
        conditions.append({
            "name": "Femoral anteversion",
            "severity": "moderate",
            "plane": "transverse",
            "description": "Excessive medial rotation of femur (into-toeing)",
            "indicators": f"hip_rot={hip_rot:.1f}°, fpa={fpa:.1f}°",
        })

    # External tibial torsion
    if fpa > 15.0 and hip_rot > 10.0:
        conditions.append({
            "name": "External tibial torsion",
            "severity": "moderate",
            "plane": "transverse",
            "description": "Outward rotation of tibia (foot-out-toeing)",
            "indicators": f"fpa={fpa:.1f}°, hip_rot={hip_rot:.1f}°",
        })

    # Internal tibial torsion
    if fpa < -10.0 and hip_rot < -5.0:
        conditions.append({
            "name": "Internal tibial torsion",
            "severity": "moderate",
            "plane": "transverse",
            "description": "Inward rotation of tibia (into-toeing)",
            "indicators": f"fpa={fpa:.1f}°, hip_rot={hip_rot:.1f}°",
        })

    # Hip internal rotation
    if hip_rot < -5.0:
        conditions.append({
            "name": "Hip internal rotation",
            "severity": "mild",
            "plane": "transverse",
            "description": "Persistent medial rotation at hip during stance",
            "indicators": f"hip_rot={hip_rot:.1f}°",
        })

    # Pelvic asymmetry
    if abs(pelvic_rot) > 5.0:
        conditions.append({
            "name": "Pelvic asymmetry",
            "severity": "moderate",
            "plane": "transverse",
            "description": "Pelvic rotation asymmetry > 5°",
            "indicators": f"pelvic_rot={pelvic_rot:.1f}°",
        })

    return conditions


def detect_all_clinical_conditions(metrics):
    """
    Detect all clinical conditions across all three planes.
    """
    conditions = []
    conditions.extend(detect_clinical_conditions_frontal(metrics.get("frontal", {})))
    conditions.extend(detect_clinical_conditions_sagittal(metrics.get("sagittal", {})))
    conditions.extend(detect_clinical_conditions_transverse(metrics.get("transverse", {})))
    return conditions


def compute_cross_plane_correlations(frontal_metrics, sagittal_metrics, transverse_metrics):
    """
    Compute cross-plane correlations for gait analysis.
    """
    correlations = {}
    
    # Frontal-Sagittal correlation (pelvic obliquity vs trunk lean)
    if "pelvic_obliquity" in frontal_metrics and "trunk_lean" in sagittal_metrics:
        correlations["pelvic_obliquity_vs_trunk_lean"] = abs(
            frontal_metrics["pelvic_obliquity"] - sagittal_metrics["trunk_lean"]
        )
    
    # Sagittal-Transverse correlation (hip flexion vs hip rotation)
    if "hip_flexion" in sagittal_metrics and "hip_rotation" in transverse_metrics:
        correlations["hip_flexion_vs_rotation"] = abs(
            sagittal_metrics["hip_flexion"] - transverse_metrics["hip_rotation"]
        )
    
    # Frontal-Transverse correlation (knee valgus vs foot progression)
    if "knee_valgus" in frontal_metrics and "foot_progression_angle" in transverse_metrics:
        correlations["knee_valgus_vs_fpa"] = abs(
            frontal_metrics["knee_valgus"] - transverse_metrics["foot_progression_angle"]
        )
    
    return correlations


if __name__ == "__main__":
    # Example usage
    frontal_metrics = {
        "pelvic_obliquity": 6.5,
        "trunk_lean": 9.2,
        "knee_valgus": 8.0,
        "step_width": 0.35,
        "head_tilt": 6.0,
        "weight_shift": 0.3,
        "shoulder_asymmetry": 0.15,
    }
    
    sagittal_metrics = {
        "knee_min": 25.0,
        "knee_max": 35.0,
        "ankle_pf": -35.0,
        "hip_flex": 50.0,
        "stance_pct": 55.0,
        "step_width": 0.35,
        "trunk_lean": 9.2,
    }
    
    transverse_metrics = {
        "hip_rotation": -12.0,
        "foot_progression_angle": -15.0,
        "pelvic_rotation": 6.0,
        "trunk_rotation": -8.0,
    }
    
    conditions = detect_all_clinical_conditions({
        "frontal": frontal_metrics,
        "sagittal": sagittal_metrics,
        "transverse": transverse_metrics
    })
    
    print("Detected Clinical Conditions:")
    for c in conditions:
        print(f"  {c['name']} ({c['plane']} plane): {c['description']}")
        print(f"    Indicators: {c['indicators']}")
    
    correlations = compute_cross_plane_correlations(frontal_metrics, sagittal_metrics, transverse_metrics)
    print()
    print("Cross-Plane Correlations:")
    for k, v in correlations.items():
        print(f"  {k}: {v:.2f}°")