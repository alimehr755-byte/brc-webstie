#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Tests for python/cp_knee_classifier.py — synthetic Sutherland-Davids pattern
waveforms, threshold boundaries, and zero-assumption unassessed edge cases."""

import math
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
PY = HERE.parent / "python"
sys.path.insert(0, str(PY))

from cp_knee_classifier import classify_side, classify_cp_knee  # noqa: E402


def synth(first_peak, mid_min, swing_peak, late=False, heel_strike_flex=2.0):
    """101-point synthetic knee curve: heel strike -> first peak -> mid-stance
    minimum -> swing peak (optionally delayed past 74 %) -> pre-toe-off drop."""
    xs = []
    swing_peak_hold = (80 if late else 74)
    for p in range(101):
        if p == 0:
            v = heel_strike_flex
        elif p < 12:
            v = heel_strike_flex + (first_peak - heel_strike_flex) * (p / 12.0)
        elif p <= 16:
            v = first_peak
        elif p <= 24:
            v = first_peak + (mid_min - first_peak) * ((p - 16) / 8.0)
        elif p <= 55:
            v = mid_min
        elif p <= 60:
            v = mid_min + (swing_peak - mid_min) * ((p - 55) / 5.0)
        elif p <= swing_peak_hold:
            v = swing_peak
        else:
            v = mid_min + 3.0
        xs.append(round(v, 2))
    return xs


@pytest.mark.parametrize(
    "curve_stance,expected",
    [
        ((synth(42, 14, 50), 60.0), "jump"),
        ((synth(55, 38, 44), 60.0), "crouch"),
        ((synth(25, 6.0, 34), 60.0), "stiff"),
        ((synth(25, 6.0, 52, late=True), 60.0), "stiff"),
        ((synth(18, -8, 50), 60.0), "recurvatum"),
        ((synth(28, 26, 58), 60.0), "not_classified"),
    ],
)
def test_pattern_classification(curve_stance, expected):
    r = classify_side(curve_stance[0], curve_stance[1])
    assert r["status"] == "assessed"
    assert r["pattern"] == expected
    assert r["citations"]


def test_unassessed_missing_inputs():
    r = classify_side(None, 60.0)
    assert r["status"] == "unassessed" and r["pattern"] is None
    r = classify_side(synth(42, 14, 50), None)
    assert r["status"] == "unassessed"
    r = classify_side(synth(42, 14, 50), 0.0)
    assert r["status"] == "unassessed"


def test_boundary_stance_min_30_is_not_crouch():
    r = classify_side(synth(34, 30.0, 55), 60.0)
    assert r["pattern"] != "crouch"
    r = classify_side(synth(34, 30.5, 55), 60.0)
    assert r["pattern"] == "crouch"


def test_classify_cp_knee_full(cv=None):
    sag = {"timeseries": {"knee_flexion": {"L": synth(42, 14, 50), "R": synth(55, 38, 44)}},
           "stance_pct": 60.0}
    out = classify_cp_knee(sag)
    assert out["status"] == "assessed"
    assert out["sides"]["L"]["pattern"] == "jump"
    assert out["sides"]["R"]["pattern"] == "crouch"


def test_classify_cp_knee_unassessed_when_both_missing():
    out = classify_cp_knee({"timeseries": {}, "stance_pct": None})
    assert out["status"] == "unassessed" and out["reason"]
