#!/usr/bin/env python3
# tests/test_golden_concordance.py
# Unit tests for the engine-vs-physio concordance harness (Phase 1).
#
# Uses the real _build_report() from tests/golden/concordance_report.py, which
# discovers golden sessions from the SQLite DB (is_golden = 1) and merges physio
# ground truth from tests/golden/golden_dataset.csv.
#
# Tests skip (not fail) when no golden sessions exist on disk — CI stays green
# before the first golden session is captured. As golden data accumulates, the
# knee-stance MAE gate (<=8 deg) and CP pattern agreement gate (>=80%) become
# enforced gates.

import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / "golden"))

from concordance_report import _build_report  # noqa: E402


@pytest.fixture()
def report():
    return _build_report()


def test_build_report_returns_summary(report):
    summary, _ = report
    assert "golden_sessions" in summary
    assert "assessed_knee_sides" in summary
    assert "overall_mae_knee_stance_deg" in summary
    assert "mae_pass" in summary
    assert "pattern_pass" in summary
    assert "sessions" in summary


def test_graceful_when_no_assessed_data(report):
    """Golden sessions may exist with no assessed engine/physio values -> gates
    are None (not breached), nothing is inferred (zero-assumption)."""
    summary, _ = report
    if summary["assessed_knee_sides"] > 0 or summary["assessed_pattern_sessions"] > 0:
        pytest.skip("Assessed data present — covered by gate tests instead")
    assert summary["overall_mae_knee_stance_deg"] is None
    assert summary["pattern_agreement"] is None
    assert summary["mae_pass"] is None
    assert summary["pattern_pass"] is None


def test_mae_gate_when_data_exists(report):
    summary, _ = report
    if summary["assessed_knee_sides"] == 0:
        pytest.skip("No assessed knee sides — capture golden sessions first")
    mae = summary["overall_mae_knee_stance_deg"]
    assert mae is not None
    assert mae <= 8.0, f"Knee stance MAE {mae} deg exceeds gate 8.0 deg"


def test_pattern_agreement_gate_when_data_exists(report):
    summary, _ = report
    if summary["assessed_pattern_sessions"] == 0:
        pytest.skip("No assessed pattern sessions — capture golden sessions first")
    agree = summary["pattern_agreement"]
    assert agree is not None
    assert agree >= 0.80, f"CP pattern agreement {agree:.0%} below gate 80%"


def test_zero_assumption_unassessed(report):
    """Missing engine results or physio values -> unassessed, never inferred."""
    summary, _ = report
    for s in summary["sessions"]:
        for sd in s["sides"]:
            assert sd["status"] in ("assessed", "unassessed")
            if sd["status"] == "unassessed":
                assert sd["abs_err_deg"] is None
        assert s["pattern_status"] in ("assessed", "unassessed")
