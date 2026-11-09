# Pose2Sim/OpenSim → BRC Gait Lab Report Engine Adapter Specification

## Status: FUTURE PLAN — Not Yet Implemented

This document specifies the adapter interface for integrating Pose2Sim/OpenSim
multi-camera 3D gait analysis into the existing BRC Gait Lab report engine.

**When to implement:** When the gait lab is built functionally with live
recording capability (3+ synchronized cameras).

**What it does:** Reads Pose2Sim/OpenSim output (3D joint angles from calibrated
multi-view capture) and maps it into the same JSON schema the existing report
engine consumes — without modifying the report engine itself.

---

## 1. Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    GAIT LAB HARDWARE                        │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐       │
│  │ Overhead │ │ Side-L   │ │ Side-R   │ │ Frontal  │       │
│  │ Camera   │ │ Camera   │ │ Camera   │ │ Camera   │       │
│  │ (90°)    │ │ (sagittal│ │ (sagittal│ │ (frontal)│       │
│  │          │ │  left)   │ │  right)  │ │          │       │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘       │
│       │            │            │            │              │
│       └────────────┴────────────┴────────────┘              │
│              Hardware trigger (<1ms sync)                    │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│                    POSE2SIM PIPELINE                        │
│  1. Per-camera 2D pose (MediaPipe or OpenPose)              │
│  2. Triangulation (DLT) → 3D marker positions               │
│  3. Filtering (Butterworth lowpass)                         │
│  4. Output: 3D marker trajectories (.trc)                   │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│                    OPENSIM PIPELINE                          │
│  1. Scale generic musculoskeletal model to subject          │
│  2. Inverse Kinematics (IK) → joint angles (.mot/.sto)      │
│  3. Output: joint angles per frame (sagittal + frontal +     │
│     transverse planes)                                      │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│                    ADAPTER MODULE                           │
│  pose2sim_adapter.py — reads OpenSim output, maps to         │
│  BRC report JSON schema, labels data source as "measured"    │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│                    REPORT ENGINE                            │
│  Existing gait_lab.py / report generators (UNCHANGED)       │
│  Consumes JSON with source label: "measured_3d" vs          │
│  "estimated_smplx" vs "estimated_single_plane"              │
└─────────────────────────────────────────────────────────────┘
```

---

## 2. Adapter Interface Contract

### 2.1 Input Format (from OpenSim)

The adapter reads OpenSim output files:

| File | Format | Content |
|------|--------|---------|
| `ik_results.mot` | OpenSim .mot | Joint angles per frame (degrees) |
| `ik_results.sto` | OpenSim .sto | Joint angles per frame (radians) |
| `markers.trc` | TRC | 3D marker positions (mm) |
| `scaled_model.osim` | OpenSim model | Subject-scaled musculoskeletal model |
| `metadata.json` | JSON | Camera calibration, sync info, subject info |

### 2.2 Output Format (to Report Engine)

The adapter produces a JSON file that the report engine consumes:

```json
{
  "source": "measured_3d",
  "method": "pose2sim_opensim",
  "camera_count": 4,
  "calibration_residual_mm": 0.8,
  "frames": 150,
  "fps": 100,
  "planes": {
    "sagittal": {
      "hip_flexion": { "L": [...], "R": [...] },
      "knee_flexion": { "L": [...], "R": [...] },
      "ankle_angle": { "L": [...], "R": [...] },
      "trunk_lean": [...],
      "head_tilt": [...]
    },
    "frontal": {
      "pelvic_obliquity": [...],
      "lateral_trunk_lean": [...],
      "knee_valgus": [...],
      "step_width": [...],
      "weight_shift": [...]
    },
    "transverse": {
      "hip_rotation": { "L": [...], "R": [...] },
      "pelvic_rotation": { "L": [...], "R": [...] },
      "trunk_rotation": { "L": [...], "R": [...] },
      "foot_progression_angle": { "L": [...], "R": [...] }
    }
  },
  "gait_events": {
    "initial_contacts": { "L": [...], "R": [...] },
    "toe_offs": { "L": [...], "R": [...] }
  },
  "spatio_temporal": {
    "cadence": 1.2,
    "stance_pct": 60.0,
    "swing_pct": 40.0,
    "stride_length": 1.35,
    "step_length": 0.67
  },
  "metadata": {
    "subject_id": "P001",
    "camera_count": 4,
    "calibration_date": "2027-01-15",
    "opensim_model": "gait2392_scaled.osim",
    "ik_residual_mm": 12.5
  }
}
```

### 2.3 Source Labeling

Every result gets a `source` label that the report engine uses for confidence display:

| Source Label | Meaning | Report Display |
|-------------|---------|----------------|
| `measured_3d` | Pose2Sim/OpenSim (3+ cameras) | "Measured (3D)" — highest confidence |
| `estimated_smplx` | SMPL-X fitting (1-2 cameras) | "Estimated (2D+SMPL-X)" — medium confidence |
| `estimated_single_plane` | Single-plane MediaPipe only | "Estimated (single-plane)" — lowest confidence |

---

## 3. Adapter Module Specification (`pose2sim_adapter.py`)

### 3.1 Class Interface

```python
class Pose2SimAdapter:
    """Adapter to convert Pose2Sim/OpenSim output to BRC report JSON schema."""

    def __init__(self, opensim_output_dir: str, metadata: dict):
        """Initialize adapter with OpenSim output directory."""
        self.output_dir = opensim_output_dir
        self.metadata = metadata

    def load_opensim_results(self) -> dict:
        """Load and parse OpenSim .mot/.sto file."""
        ...

    def load_markers(self) -> dict:
        """Load 3D marker trajectories from .trc file."""
        ...

    def detect_gait_events(self, markers: dict) -> dict:
        """Detect IC and TO from 3D marker trajectories."""
        ...

    def compute_spatio_temporal(self, markers: dict, events: dict) -> dict:
        """Compute cadence, stride length, stance/swing % from 3D markers."""
        ...

    def to_report_json(self) -> dict:
        """Convert all OpenSim data to BRC report JSON schema."""
        ...
```

### 3.2 Function: `load_opensim_results()`

Reads OpenSim `.mot` file and extracts joint angles:

```python
def load_opensim_results(self) -> dict:
    """Read OpenSim .mot file and return joint angles per frame."""
    # OpenSim .mot format: tab-separated, header with time + joint angles
    # Returns: {
    #   "time": [0.0, 0.01, 0.02, ...],
    #   "pelvis_tilt": [...],
    #   "pelvis_list": [...],
    #   "pelvis_rotation": [...],
    #   "hip_flexion_r": [...],
    #   "hip_flexion_l": [...],
    #   ...
    # }
```

### 3.3 Function: `to_report_json()`

Maps OpenSim joint names to BRC report schema:

| OpenSim Joint Name | BRC Report Field | Plane |
|-------------------|------------------|-------|
| `hip_flexion_r` | `sagittal.hip_flexion.R` | Sagittal |
| `hip_flexion_l` | `sagittal.hip_flexion.L` | Sagittal |
| `knee_angle_r` | `sagittal.knee_flexion.R` | Sagittal |
| `knee_angle_l` | `sagittal.knee_flexion.L` | Sagittal |
| `ankle_angle_r` | `sagittal.ankle_angle.R` | Sagittal |
| `ankle_angle_l` | `sagittal.ankle_angle.L` | Sagittal |
| `pelvis_tilt` | `frontal.pelvic_obliquity` | Frontal |
| `pelvis_list` | `frontal.lateral_trunk_lean` | Frontal |
| `pelvis_rotation` | `transverse.pelvic_rotation` | Transverse |
| `hip_rotation_r` | `transverse.hip_rotation.R` | Transverse |
| `hip_rotation_l` | `transverse.hip_rotation.L` | Transverse |
| `lumbar_rotation` | `transverse.trunk_rotation` | Transverse |

---

## 4. Joint Name Mapping Table (OpenSim → BRC)

| OpenSim Name | BRC Field | Plane | Unit |
|-------------|-----------|-------|------|
| `pelvis_tilt` | `frontal.pelvic_obliquity` | Frontal | degrees |
| `pelvis_list` | `frontal.lateral_trunk_lean` | Frontal | degrees |
| `pelvis_rotation` | `transverse.pelvic_rotation` | Transverse | degrees |
| `hip_flexion_r` | `sagittal.hip_flexion.R` | Sagittal | degrees |
| `hip_flexion_l` | `sagittal.hip_flexion.L` | Sagittal | degrees |
| `hip_adduction_r` | `frontal.hip_abduction.R` | Frontal | degrees |
| `hip_adduction_l` | `frontal.hip_abduction.L` | Frontal | degrees |
| `hip_rotation_r` | `transverse.hip_rotation.R` | Transverse | degrees |
| `hip_rotation_l` | `transverse.hip_rotation.L` | Transverse | degrees |
| `knee_angle_r` | `sagittal.knee_flexion.R` | Sagittal | degrees |
| `knee_angle_l` | `sagittal.knee_flexion.L` | Sagittal | degrees |
| `ankle_angle_r` | `sagittal.ankle_angle.R` | Sagittal | degrees |
| `ankle_angle_l` | `sagittal.ankle_angle.L` | Sagittal | degrees |
| `lumbar_extension` | `sagittal.trunk_lean` | Sagittal | degrees |
| `lumbar_bending` | `frontal.lateral_trunk_lean` | Frontal | degrees |
| `lumbar_rotation` | `transverse.trunk_rotation` | Transverse | degrees |

---

## 5. Gait Event Detection (from 3D markers)

### Initial Contact Detection
- Method: Maximum anterior position of heel marker relative to pelvis
- Alternative: Local minimum of vertical velocity
- Output: Frame indices of IC events

### Toe-Off Detection
- Method: Maximum posterior position of toe marker relative to pelvis
- Alternative: Peak upward vertical velocity inflection
- Output: Frame indices of TO events

### Temporal-Spatial Parameters
- Cycle time: time between consecutive ipsilateral ICs
- Stance time: IC to TO of same limb
- Swing time: TO to next IC of same limb
- Cadence: steps per minute
- Stride length: distance between consecutive ipsilateral ICs
- Step length: distance between opposite foot ICs

---

## 6. Bland-Altman Validation (for cross-method comparison)

When comparing Pose2Sim/OpenSim vs SMPL-X vs single-plane:

```
For each joint angle:
  - Mean difference (bias)
  - Standard deviation of differences
  - 95% limits of agreement (LoA)
  - Intraclass Correlation Coefficient (ICC)
  - Cohen's d effect size
```

### Validation Protocol
1. Run all three methods on the same dataset
2. Compute per-joint angle differences
3. Generate Bland-Altman plots
4. Report ICC for each joint/plane
5. Document which method is more accurate for which joint/plane

---

## 7. Error Handling

### Adapter Error Codes

| Code | Meaning | Action |
|------|---------|--------|
| `ADAPTER_OK` | Success | Continue to report |
| `ADAPTER_NO_OPENSIM` | OpenSim output not found | Fall back to SMPL-X |
| `ADAPTER_BAD_TRC` | TRC file corrupted | Fall back to SMPL-X |
| `ADAPTER_IK_FAILED` | IK residuals too high | Use SMPL-X, flag in report |
| `ADAPTER_MISSING_JOINT` | Required joint not in OpenSim model | Skip that joint, use SMPL-X for it |

### Fallback Chain

```
Pose2Sim/OpenSim (3+ cameras) → SMPL-X (1-2 cameras) → Single-plane MediaPipe (0-1 cameras)
```

Each fallback is automatic and the report labels the data source accordingly.

---

## 8. Report Labeling Rules

The report engine uses the `source` field to display confidence:

| Source | Label in Report | Confidence | Color |
|--------|----------------|------------|-------|
| `measured_3d` | "Measured (3D)" | Highest | Green |
| `estimated_smplx` | "Estimated (2D+SMPL-X)" | Medium | Amber |
| `estimated_single_plane` | "Estimated (single-plane)" | Lowest | Red/Orange |

### When to Show Which Label

- **Measured (3D):** When Pose2Sim/OpenSim was used (3+ cameras)
- **Estimated (2D+SMPL-X):** When SMPL-X fitting was used (1-2 cameras)
- **Estimated (single-plane):** When only MediaPipe was used (0-1 cameras, no SMPL-X)

---

## 9. Implementation Checklist (When Ready)

### Phase 1: Hardware Setup
- [ ] Mount 3+ synchronized cameras (overhead 90° + side + front)
- [ ] Hardware trigger for <1ms synchronization
- [ ] Calibrate with L-frame + dynamic wand
- [ ] Bundle adjustment residual < 1.0 mm

### Phase 2: Software Pipeline
- [ ] Install Pose2Sim + OpenSim
- [ ] Configure camera calibration for Pose2Sim
- [ ] Create scaled OpenSim model for gait analysis
- [ ] Test triangulation accuracy

### Phase 3: Adapter Implementation
- [ ] Implement `pose2sim_adapter.py`
- [ ] Implement `load_opensim_results()`
- [ ] Implement `to_report_json()`
- [ ] Implement gait event detection from 3D markers
- [ ] Implement spatio-temporal metrics
- [ ] Implement Bland-Altman validation

### Phase 4: Integration
- [ ] Wire adapter into report engine
- [ ] Test end-to-end: cameras → Pose2Sim → OpenSim → adapter → report
- [ ] Validate against Xsens ground truth
- [ ] Update report labeling

### Phase 5: Testing
- [ ] Unit tests for adapter functions
- [ ] Integration tests for full pipeline
- [ ] Comparison tests: Pose2Sim vs SMPL-X vs single-plane
- [ ] Performance tests: real-time capability

---

## 10. File Locations

When implementing, place files as follows:

```
gait lab/
├── pose2sim_adapter.py          # Adapter module
├── opensim_models/              # OpenSim models directory
│   ├── gait2392.osim           # Generic gait model
│   └── scaled/                 # Subject-scaled models
├── pose2sim_config/             # Pose2Sim configuration
│   ├── pose2sim_config.toml    # Pose2Sim settings
│   └── camera_calibration/     # Camera calibration files
├── opensim_output/              # OpenSim output directory
│   ├── markers.trc              # 3D marker trajectories
│   ├── ik_results.mot           # Inverse kinematics results
│   └── ik_results.sto           # Inverse kinematics results (storage)
└── tests/
    └── test_adapter.py          # Adapter unit tests
```

---

## 11. References

1. **Pose2Sim:** https://github.com/perfanalytics/pose2sim
2. **OpenSim:** https://simtk.org/projects/opensim
3. **ISB Standards:** Wu et al. (2002) ISB recommendation on definitions of joint coordinate systems
4. **MediaPipe:** https://developers.google.com/mediapipe
5. **SMPL-X:** https://github.com/vchoutas/smplify-x
6. **SMPL-X paper:** Pavlakos et al. (2019) Expressive Body Capture
7. **Zeni et al. (2008):** Two simple methods for determining gait events during treadmill and overground walking
8. **Bland & Altman (1986):** Statistical methods for assessing agreement between two methods of clinical measurement

---

## 12. Notes

- This document is a **specification only**. No code changes have been made.
- The adapter will be implemented when the gait lab is built functionally with live recording capability.
- The existing pipeline (MediaPipe + SMPL-X → reports) remains unchanged until then.
- All report logic is untouched — only the data source changes (Pose2Sim/OpenSim vs SMPL-X vs single-plane).
- The `source` label in the report JSON tells the report engine which method was used.

---

*Document created: November 9, 2026*
*Status: FUTURE PLAN — Not yet implemented*
*Author: Research Portal Development Team*