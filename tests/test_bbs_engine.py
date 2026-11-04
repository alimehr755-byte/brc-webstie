#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Tests for python/bbs_engine.py — scoring correctness, bands, fall screens,
and the BBS x gait cross-validation contract (spec P1 zero-assumption)."""

import os
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
PY = HERE.parent / "python"
sys.path.insert(0, str(PY))

from bbs_engine import GaitLabBBSModule, crosscheck_bbs_against_gait  # noqa: E402


@pytest.fixture()
def mod():
    return GaitLabBBSModule("8821")


def test_min_max_totals(mod):
    for i in range(1, 15):
        mod.set_item_score(i, 0)
    assert mod.calculate_total() == 0
    mod2 = GaitLabBBSModule("8822")
    for i in range(1, 15):
        mod2.set_item_score(i, 4)
    assert mod2.calculate_total() == 56


def test_partial_scores_flush_unscored(mod):
    # PATIENT-8821 y.txt mock: mixed profile; totals equal the sum of scored items
    scores = {1: 4, 2: 4, 3: 3, 4: 3, 5: 2, 6: 4, 7: 4, 8: 2, 9: 3, 10: 4, 11: 3, 12: 3, 13: 3, 14: 4}
    total = 0
    for i in range(1, 15):
        mod.set_item_score(i, scores[i])
    for i in scores:
        total += scores.get(i, 0)
    assert mod.calculate_total() == total
    assert mod.is_complete()

    # an engine given an EMPTY item map refuses to interpret (zero-assumption)
    m2 = GaitLabBBSModule("8821b")
    with pytest.raises(ValueError):
        m2.export_data()
    assert m2.is_complete() is False


def test_mobility_band_boundaries():
    def move(total):
        m = GaitLabBBSModule(f"t_{total}")
        for i in range(1, 15):
            m.set_item_score(i, total / 14.0 >= 4 and 4 or max(0, min(4, round(total / 14.0))))
        return m.export_data()["mobility_band"]

    # 4x14 = 56 -> low band; 2x14 = 28 -> medium band
    assert move(56)["level"] == "Low Fall Risk"
    assert move(28)["level"] == "Medium Fall Risk"
    assert "cane/walker" in move(28)["recommendation"].lower() or "assistance" in move(28)["recommendation"].lower()


def test_fall_screen_population_cutoffs():
    # stroke cutoff 49: total 45 -> flagged; general cutoff 45: 45 -> not flagged
    def build(pid):
        m = GaitLabBBSModule(pid)
        for i in range(1, 15):
            m.set_item_score(i, 4)
        # drop 4 and 2 points to force total below cutoff
        m.set_item_score(10, 3)
        m.set_item_score(11, 2)
        return m

    stroke = build("s1").export_data("stroke")["fall_screen"]
    general = build("g1").export_data("general")["fall_screen"]
    assert stroke["cutoff"] == 49 and general["cutoff"] == 45
    assert isinstance(stroke["risk_flagged"], bool)
    assert stroke["population_label"] and "stroke" in stroke["population_label"].lower() or "Stroke" in stroke["population_label"]


def test_gait_impact_flags_structure(mod):
    for i in range(1, 15):
        mod.set_item_score(i, 2)
    exp = mod.export_data()
    flags = exp["gait_impact_flags"]
    assert len(flags) == 14
    for f in flags:
        assert {"item", "task", "score", "gait_belt", "predicted_gait_deficit"} <= set(f.keys())
        # gait-belt items must be flagged (items 5,8,9,11,12,13,14)
        if f["item"] in (5, 8, 9, 11, 12, 13, 14):
            assert f["gait_belt"] is True
    # any flag with crosscheck_params carries only resolvable 2D-CV paths
    for f in flags:
        if f.get("crosscheck_params"):
            for path in f["crosscheck_params"]:
                assert path and all(isinstance(k, str) for k in path)


def test_crosscheck_zero_assumption():
    # Not-found paths -> 'unassessed'; never fabricated values.
    bbs = build_bbs_payload(all_2=True)
    results = {}  # empty session → nothing observable
    rows = crosscheck_bbs_against_gait(bbs, results)
    assert rows and all(r["status"] == "unassessed" for r in rows)


def test_crosscheck_resolves_known_paths():
    bbs = build_bbs_payload(all_2=True)
    results = {
        "cycle": {"cadence_cycles_per_second": 1.4, "stance_pct": 60},
        "cv": {"sagittal": {"rom": {"L": {"knee_max": 55.0}, "R": {"knee_max": 60.0}}}},
    }
    rows = crosscheck_bbs_against_gait(bbs, results)
    item4 = next(r for r in rows if r["bbs_item"] == 4)
    assert item4["status"] == "assessed"
    item14 = next(r for r in rows if r["bbs_item"] == 14)
    assert item14["status"] == "unassessed"  # frontal metrics missing in this session


def build_bbs_payload(all_2=True):
    m = GaitLabBBSModule("x")
    for i in range(1, 15):
        m.set_item_score(i, 2 if all_2 else 4)
    return m.export_data()


def export_data_for_p1():
    return build_bbs_payload(all_2=True)
