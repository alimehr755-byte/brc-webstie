#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Tests for python/scales_registry.py — TUG / GMFCS / OGA payload contracts."""

import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
PY = HERE.parent / "python"
sys.path.insert(0, str(PY))

from scales_registry import scale_payload, SCALE_STUBS  # noqa: E402


def test_tug_general_cutoff():
    p = scale_payload("tug", {"seconds": 11.0, "population": "general",
                              "assistive_device": "none", "observations": []})
    assert p["status"] == "assessed"
    assert p["total"] == 11.0
    flagged = p["fallback_risk"]
    # 13.5 s cutoff (Shumway-Cook 2000) — 11 s is not flagged for community walkers
    assert flagged is False
    assert p["interpretation"]["cutoff_s"]


def test_tug_populations_flag_correctly():
    def tug(population, seconds):
        return scale_payload("tug", {"seconds": seconds, "population": population,
                                     "assistive_device": "none", "observations": []})["fallback_risk"]
    assert tug("stroke", 14.5) is True          # stroke cut 14 s
    assert tug("stroke", 13.0) is False
    assert tug("le_amputee", 20.0) is True      # lower-limb amputee cut 19 s
    assert tug("hip_oa", 9.0) is False          # hip OA cut 10 s
    assert tug("frail", 15.0) is True           # general <45 s mobility screen cut 13.5*
    assert tug("vestibular", 12.0) is True      # vestibular cut 11.1 s


def test_tug_unassessed_when_no_seconds():
    p = scale_payload("tug", {"population": "general", "assistive_device": "none",
                              "observations": []})
    assert p["status"] == "unassessed" and p["reason"]


def test_gmfcs_levels_and_age_bands():
    p = scale_payload("gmfcs", {"level": "III", "age_years": 9, "reported_via": "self"})
    assert p["status"] == "assessed"
    assert p["level"] == "III"
    assert p["age_band"] and p["interpretation"]["text"]
    # Via taxonomy must be respected
    p2 = scale_payload("gmfcs", {"level": "I", "age_years": 4, "reported_via": "parent"})
    assert p2["level"] == "I" and p2["reported_via"] == "parent"
    # CanChild attribution must ship with the payload (copyright requirement)
    assert "CanChild" in str(p2.get("notes", "")) or "CanChild" in str(p2.get("interpretation", ""))


def test_oga_entries_and_unassessed():
    empty = scale_payload("oga", {"observations": []})
    assert empty["status"] == "unassessed" and empty["reason"]
    filled = scale_payload("oga", {"observations": [
        {"segment": "knee", "deviation": "excessive flexion in loading response",
         "phase": "loading response", "side": "left"}]})
    assert filled["status"] == "assessed"
    assert filled["entries"][0]["segment"] == "knee"
    assert filled["method"]  # Rancho Los Amigos method string carries


def test_stubs_never_fake_results():
    for name in SCALE_STUBS:
        p = scale_payload(name, {})
        assert p["status"] == "stub", f"{name} must stay a stub until implemented"
        assert p["reason"]
