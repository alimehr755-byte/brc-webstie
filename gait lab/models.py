"""
Orthopedic Eye - Pydantic Data Layer & Validation Models
Filename: models.py
"""

from pydantic import BaseModel, Field, validator
from typing import List, Optional, Dict, Any

class PatientDemographics(BaseModel):
    """Validates basic intake profile data for the clinical registry."""
    name: str = Field(..., description="Full name of the patient")
    patient_id: str = Field(..., description="Unique alphanumeric medical record identifier")
    age: int = Field(..., gt=0, lt=120, description="Age must be a valid number between 1 and 120")
    gender: str = Field(..., description="Biomedical sex or gender identity presentation")

class PhysicalAssessmentMetrics(BaseModel):
    """Validates manual clinical measurement parameters before engine processing."""
    scoliometer_angle: float = Field(0.0, ge=0.0, le=45.0, description="Scoliometer ATR reading in degrees")
    arch_index: float = Field(0.25, ge=0.0, le=1.0, description="Calculated Staheli arch index value")
    leg_length_discrepancy_cm: float = Field(0.0, ge=0.0, le=10.0, description="True structural leg length discrepancy in cm")

class KinematicTimeSeries(BaseModel):
    """Validates the raw angular arrays parsed from the computer vision tracking engine."""
    knee_rom_sagittal: List[Optional[float]] = Field(default_factory=list, description="Sagittal knee flexion/extension angles across the gait cycle")
    ankle_rom_sagittal: List[Optional[float]] = Field(default_factory=list, description="Sagittal ankle dorsi/plantarflexion angles across the gait cycle")
    hip_rom_sagittal: List[Optional[float]] = Field(default_factory=list, description="Sagittal hip flexion/extension angles across the gait cycle")
    pelvic_tilt: List[Optional[float]] = Field(default_factory=list, description="Dynamic pelvic coronal/sagittal slope measurements across frames")

class DiagnosticSummary(BaseModel):
    """Schema for the processed diagnostic results payload."""
    primary_severity: str = Field(..., description="Calculated critical severity level (Normal, Mild, Moderate, Severe)")
    detected_pathologies: List[str] = Field(..., description="List of recognized clinical conditions or structural deviations")
    clinical_action_plan: List[str] = Field(..., description="Automated orthotic device prescriptions and therapeutic pathways")

class ExtractedFeatures(BaseModel):
    """Schema for secondary aggregated joint characteristics."""
    measured_knee_rom: float
    measured_ankle_rom: float
    average_stance_knee_flexion: float
    peak_extension_angle: float

class FullGaitSessionPayload(BaseModel):
    """The master validation object capturing a patient's complete diagnostic pipeline state."""
    demographics: PatientDemographics
    physical_metrics: PhysicalAssessmentMetrics
    kinematics: KinematicTimeSeries
    diagnostics: Optional[Dict[str, Any]] = Field(default=None, description="Holds output from the hybrid diagnostic engine")

    @validator('diagnostics')
    def validate_engine_outputs(cls, v):
        if v is not None:
            if "diagnostic_summary" not in v or "extracted_features" not in v:
                raise ValueError("Engine output payload must contain both 'diagnostic_summary' and 'extracted_features' keys.")
        return v