#!/usr/bin/env python3
# tests/test_engine_golden.py
# Engine golden-output regression tests.
#
# These tests run the BRC Biomechanical Engine pipeline on real sample videos
# and assert structural correctness (keys present, types valid, zero-assumption
# protocol respected). MediaPipe pose estimation is non-deterministic, so tests
# check schema/shape rather than exact numeric values.
#
# Golden reference outputs are stored in tests/golden/ and used to verify the
# report structure remains stable across engine changes.

import json
import os
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
GOLDEN_DIR = HERE / "golden"
PYTHON_DIR = HERE.parent / "python"

sys.path.insert(0, str(PYTHON_DIR))

from gait_lab import analyze_sagittal, analyze_frontal, derive_clinical  # noqa: E402

# Sample videos bundled with the repo for regression testing
# Must match files present in uploads/gait/
SAMPLE_VIDEOS = {
    "sagittal_valid": HERE.parent / "uploads" / "gait" / "session-135-sagittal-1789166026920.mp4",
    "frontal_valid": HERE.parent / "uploads" / "gait" / "session-133-frontal-1789070343666.mp4",
    "combined_valid": HERE.parent / "uploads" / "gait" / "combined-smoke.mp4",
}

REQUIRED_TOP_KEYS = [
    "analyzer", "version", "mode", "generated_at", "session_id", "patient",
    "diagnostic_note", "cycle", "profile", "kinematics", "muscles",
    "prescriptions", "prediction", "references", "reference_sections",
    "cp_knee",
    # "integrity" is added by the caller (analyze/main), not derive_clinical
]

REQUIRED_CYCLE_KEYS = [
    "cadence_cycles_per_second", "cycle_seconds", "stance_pct", "swing_pct",
    "stance_norm_band", "phases", "running",
]


@pytest.fixture(scope="module")
def artifacts_dir():
    d = HERE / "tmp_golden_artifacts"
    d.mkdir(exist_ok=True)
    yield d
    # Keep artifacts for inspection; do not auto-delete


def test_sample_videos_exist():
    """All sample videos must exist on disk."""
    for name, path in SAMPLE_VIDEOS.items():
        assert path.exists(), f"Sample video missing: {path} ({name})"


def test_sagittal_analysis_structure(artifacts_dir):
    """Sagittal analysis returns a valid plane dict with required keys."""
    video = SAMPLE_VIDEOS["sagittal_valid"]
    result = analyze_sagittal(
        str(video), str(artifacts_dir), "golden_test_sag",
        step=None, start=0, speed_factor=1.0, running=False, validated_cadence=None,
    )
    assert result["status"] == "ok"
    assert result["plane"] == "sagittal"
    assert isinstance(result["stance_pct"], (int, float))
    assert isinstance(result["cadence_cycles_per_second"], (int, float))
    assert isinstance(result["cycle_seconds"], (int, float))
    assert 0 < result["stance_pct"] < 100
    assert result["cycle_seconds"] > 0
    assert "timeseries" in result
    assert "knee_flexion" in result["timeseries"]
    assert "L" in result["timeseries"]["knee_flexion"]
    assert "R" in result["timeseries"]["knee_flexion"]


def test_frontal_analysis_structure(artifacts_dir):
    """Frontal analysis returns a valid plane dict or graceful rejection."""
    video = SAMPLE_VIDEOS["frontal_valid"]
    if not video.exists():
        pytest.skip("Frontal sample video not available")
    result = analyze_frontal(
        str(video), str(artifacts_dir), "golden_test_fro",
        step=None, start=0, speed_factor=1.0, running=False,
    )
    # Frontal may be ok or rejected; either way it must have status
    assert "status" in result
    if result["status"] == "ok":
        assert "metrics" in result


def test_full_pipeline_structure(artifacts_dir):
    """derive_clinical produces a complete clinical result with all required sections."""
    sag_video = SAMPLE_VIDEOS["sagittal_valid"]
    fro_video = SAMPLE_VIDEOS["frontal_valid"]

    assert sag_video.exists(), f"Sagittal video missing: {sag_video}"
    assert fro_video.exists(), f"Frontal video missing: {fro_video}"

    cv_sag = analyze_sagittal(
        str(sag_video), str(artifacts_dir), "golden_test_full",
        step=None, start=0, speed_factor=1.0, running=False, validated_cadence=None,
    )
    cv_fro = analyze_frontal(
        str(fro_video), str(artifacts_dir), "golden_test_full",
        step=None, start=0, speed_factor=1.0, running=False,
    )

    result = derive_clinical(cv_sag, cv_fro, "golden_test_full", "Test Patient",
                             str(artifacts_dir), str(artifacts_dir))

    # All required top-level keys present
    missing = [k for k in REQUIRED_TOP_KEYS if k not in result]
    assert not missing, f"Missing top-level keys: {missing}"

    # Cycle section complete
    cycle = result["cycle"]
    missing_cycle = [k for k in REQUIRED_CYCLE_KEYS if k not in cycle]
    assert not missing_cycle, f"Missing cycle keys: {missing_cycle}"

    # Phases have expected structure
    assert len(cycle["phases"]) == 7  # 7 sub-phases
    for phase in cycle["phases"]:
        for pk in ["code", "name", "type", "pct_of_cycle", "duration_ms"]:
            assert pk in phase, f"Missing phase key: {pk}"

    # Kinematics present
    assert isinstance(result["kinematics"], dict)
    assert "rom" in result["kinematics"]
    assert "summary" in result["kinematics"]

    # Muscles present
    assert isinstance(result["muscles"], dict)
    assert "overactive" in result["muscles"]
    assert "weak" in result["muscles"]

    # Prescriptions present
    assert isinstance(result["prescriptions"], dict)
    assert "exercises" in result["prescriptions"]

    # References present
    assert isinstance(result["references"], list)
    assert len(result["references"]) > 0

    # CP knee classifier present
    assert "cp_knee" in result
    assert result["cp_knee"]["status"] in ("assessed", "unassessed")

    # Diagnostic note present
    assert isinstance(result["diagnostic_note"], str)
    assert len(result["diagnostic_note"]) > 0


def test_zero_assumption_invalid_video(artifacts_dir):
    """Zero-assumption: an invalid/missing video produces rejected status,
    not fabricated metrics."""
    # Point at a non-existent video
    result = analyze_sagittal(
        "uploads/gait/nonexistent-video.mp4", str(artifacts_dir),
        "golden_test_invalid", step=None, start=0,
        speed_factor=1.0, running=False, validated_cadence=None,
    )
    assert result["status"] != "ok"
    assert result["status"] in ("rejected", "error", "no_landmarks")
    # No cycle timing should be fabricated
    assert result.get("cycle_seconds") in (None, 0)
    assert result.get("stance_pct") in (None, 0)


def test_golden_reference_stability(artifacts_dir):
    """Compare current engine output against stored golden reference for
    structural stability (not exact values, since MediaPipe is non-deterministic).
    Uses the stored reference from test_golden_reference_generation; skips if
    no reference exists yet."""
    golden_path = GOLDEN_DIR / "session-135-golden.json"
    if not golden_path.exists():
        pytest.skip("Golden reference not yet generated — run "
                    "test_golden_reference_generation first.")

    video = SAMPLE_VIDEOS["sagittal_valid"]
    result = analyze_sagittal(
        str(video), str(artifacts_dir), "golden_stability",
        step=None, start=0, speed_factor=1.0, running=False, validated_cadence=None,
    )

    with open(golden_path, "r", encoding="utf-8") as f:
        golden = json.load(f)

    # Both results must have 'status'; if golden was ok, current should also
    # be ok (same video, same engine). If golden was rejected, current may be
    # ok or rejected (non-deterministic pose detection).
    assert "status" in result
    assert "status" in golden

    if golden["status"] == "ok":
        assert result["status"] == "ok", (
            "Golden was ok but current is {} — pose detection is non-deterministic".format(
                result["status"]))
        # Same top-level key set for successful analyses
        result_keys = set(result.keys())
        golden_keys = set(golden.keys())
        assert result_keys == golden_keys, (
            f"Key drift: current_only={sorted(result_keys - golden_keys)}, "
            f"golden_only={sorted(golden_keys - result_keys)}"
        )

        # Same cycle key set (only if both have cycle data)
        result_cycle = result.get("cycle")
        golden_cycle = golden.get("cycle")
        if result_cycle and golden_cycle:
            result_cycle_keys = set(result_cycle.keys())
            golden_cycle_keys = set(golden_cycle.keys())
            assert result_cycle_keys == golden_cycle_keys, (
                f"Cycle key drift: current_only={sorted(result_cycle_keys - golden_cycle_keys)}, "
                f"golden_only={sorted(golden_cycle_keys - result_cycle_keys)}"
            )

            # Same phase codes
            result_phase_codes = [p["code"] for p in result_cycle.get("phases", [])]
            golden_phase_codes = [p["code"] for p in golden_cycle.get("phases", [])]
            assert result_phase_codes == golden_phase_codes

            # Same timeseries keys
            result_ts_keys = set(result.get("timeseries", {}).keys())
            golden_ts_keys = set(golden.get("timeseries", {}).keys())
            assert result_ts_keys == golden_ts_keys, (
                f"Timeseries key drift: current_only={sorted(result_ts_keys - golden_ts_keys)}, "
                f"golden_only={sorted(golden_ts_keys - result_ts_keys)}"
            )
    else:
        # Golden was rejected — current may be ok or rejected; just verify
        # the error result has expected shape
        assert "error" in result or result["status"] in ("rejected", "error", "no_landmarks")


def test_golden_reference_generation(artifacts_dir):
    """Generate/update the golden reference file (run manually when engine changes)."""
    video = SAMPLE_VIDEOS["sagittal_valid"]
    result = analyze_sagittal(
        str(video), str(artifacts_dir), "golden_gen",
        step=None, start=0, speed_factor=1.0, running=False, validated_cadence=None,
    )
    out_path = GOLDEN_DIR / "session-135-golden.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2, default=str)
    assert out_path.exists()
    print(f"\nGolden reference written to {out_path}")


if __name__ == "__main__":
    # Allow manual regeneration: python tests/test_engine_golden.py
    test_golden_reference_generation(Path("tmp_golden_artifacts"))
