"""
Orthopedic Eye - Hybrid Diagnostic & Clinical Decision Engine
Filename: engine.py
"""

import numpy as np
from typing import Dict, Any, List

def run_hybrid_diagnostic_engine(patient_metrics: Dict[str, Any], kinematic_series: Dict[str, List[float]]) -> Dict[str, Any]:
    """
    Executes a comprehensive clinical decision matrix combining static patient demographics,
    physiotherapeutic observation metrics, and raw computer-vision kinematic time-series data.
    
    Parameters:
        patient_metrics (dict): Contains clinical inputs (e.g., 'scoliometer_angle', 'arch_index').
        kinematic_series (dict): Contains arrays of angles extracted via CV pipeline.
        
    Returns:
        dict: A structured payload containing calculated safety margins, pathology risks,
              and auto-generated orthotic recommendations.
    """
    
    # ---------------------------------------------------------
    # 1. KINEMATIC TIME-SERIES CLEANING & FEATURE EXTRACTION
    # ---------------------------------------------------------
    # Safely extract joint series lines, cleaning out any NaN or missing tracking frames
    knee_angles = [x for x in kinematic_series.get("knee_rom_sagittal", []) if x is not None and not np.isnan(x)]
    ankle_angles = [x for x in kinematic_series.get("ankle_rom_sagittal", []) if x is not None and not np.isnan(x)]
    hip_angles = [x for x in kinematic_series.get("hip_rom_sagittal", []) if x is not None and not np.isnan(x)]

    # Calculate ranges of motion or mean positions safely using nan-aware operations
    avg_stance_knee_flexion = float(np.nanmean(knee_angles)) if knee_angles else 0.0
    max_knee_extension = float(np.nanmin(knee_angles)) if knee_angles else 0.0  # Min flexion = max extension
    max_ankle_dorsiflexion = float(np.nanmax(ankle_angles)) if ankle_angles else 0.0
    min_ankle_plantarflexion = float(np.nanmin(ankle_angles)) if ankle_angles else 0.0
    
    total_knee_rom = float(np.ptp(knee_angles)) if knee_angles else 0.0
    total_ankle_rom = float(np.ptp(ankle_angles)) if ankle_angles else 0.0

    # Initialize diagnostic results structures
    pathology_risks = []
    clinical_recommendations = []
    severity_level = "Normal"

    # ---------------------------------------------------------
    # 2. DECISION MATRIX: LOWER LIMB KINEMATICS
    # ---------------------------------------------------------
    # Genu Recurvatum Check (Hyperextension)
    if max_knee_extension < -5.0:
        pathology_risks.append("Genu Recurvatum (Knee Hyperextension)")
        clinical_recommendations.append(
            "Prescribe a Swedish Knee Cage or an AFO with a posterior extension limit set to 0° to check hyperextension."
        )
        severity_level = "Moderate"
        
    # Genu Flexum / Crouched Gait Check
    elif avg_stance_knee_flexion > 20.0:
        pathology_risks.append("Crouch Gait / Genu Flexum Tightness")
        clinical_recommendations.append(
            "Consider a Ground Reaction Ankle Foot Orthosis (GRAFO) to provide an extension moment at the knee during stance phase."
        )
        severity_level = "Severe"

    # Drop Foot / Equinus Gait Check
    if total_ankle_rom < 15.0 and min_ankle_plantarflexion > 5.0:
        pathology_risks.append("Spastic Equinus / Drop Foot Malalignment")
        clinical_recommendations.append(
            "Utilize a rigid or dorsiflexion-assisted AFO with a 90° plantigrade stop to assist clear swing-phase ground clearance."
        )
        if severity_level != "Severe":
            severity_level = "Moderate"

    # ---------------------------------------------------------
    # 3. DECISION MATRIX: SPINE & PEDAL ALIGNMENT
    # ---------------------------------------------------------
    # Scoliotic Deviation Risk Check via Scoliometer ATR
    scoliometer_atr = patient_metrics.get("scoliometer_angle", 0.0)
    if scoliometer_atr >= 7.0:
        pathology_risks.append("Significant Idiopathic Scoliosis Curve Progression")
        clinical_recommendations.append(
            f"Scoliometer ATR registered at {scoliometer_atr}°. Recommend structural radiological validation (Cobb Angle) and custom TLSO bracing evaluation."
        )
        severity_level = "Severe"
    elif scoliometer_atr >= 5.0:
        pathology_risks.append("Mild Spinal Rotation / Truncal Asymmetry")
        clinical_recommendations.append(
            "Monitor structural alignment changes within a 3-month window. Incorporate targeted physiotherapeutic corrective exercises."
        )
        if severity_level == "Normal":
            severity_level = "Mild"

    # Pes Planus / Arch Structure Check
    arch_index = patient_metrics.get("arch_index", 0.25)
    if arch_index > 0.30:
        pathology_risks.append("Severe Pes Planus (Flat Foot Alignment)")
        clinical_recommendations.append(
            "Fabricate custom Functional Foot Orthoses (FFOs) featuring a rigid medial longitudinal arch support and UCBL-inspired deep heel cup."
        )
        if severity_level != "Severe":
            severity_level = "Moderate"

    # ---------------------------------------------------------
    # 4. FINAL PAYLOAD CONFIGURATION
    # ---------------------------------------------------------
    if not pathology_risks:
        pathology_risks.append("No biomechanical pathologies identified within current threshold configuration.")
        clinical_recommendations.append("Continue standard physiological monitoring. No orthotic intervention indicated.")

    return {
        "diagnostic_summary": {
            "primary_severity": severity_level,
            "detected_pathologies": pathology_risks,
            "clinical_action_plan": clinical_recommendations
        },
        "extracted_features": {
            "measured_knee_rom": round(total_knee_rom, 2),
            "measured_ankle_rom": round(total_ankle_rom, 2),
            "average_stance_knee_flexion": round(avg_stance_knee_flexion, 2),
            "peak_extension_angle": round(max_knee_extension, 2)
        }
    }