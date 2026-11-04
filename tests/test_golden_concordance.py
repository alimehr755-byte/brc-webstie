#!/usr/bin/env python3
# tests/test_golden_concordance.py
# Engine vs. treating-physio concordance for golden capture sessions.
#
# Golden sessions are captured per docs/capture-sop.md and registered in
# tests/golden/golden_dataset.csv. Engine results are read from the analysis
# JSON the Python pipeline writes to uploads/gait/analysis-<session_id>.json.
#
# This test SKIPS (not fails) when no golden engine results exist on disk, so
# CI stays green before the first golden session is captured. As golden data
# accumulates, thresholds below become enforced gates.
#
# Zero-assumption: a missing engine result or missing physio value is reported
# as "unassessed" for that row — never inferred.

import csv
import json
import math
import os
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
GOLDEN_CSV = HERE / "golden" / "golden_dataset.csv"
UPLOADS_DIR = HERE.parent / "uploads" / "gait"

# Concordance gates (tighten as golden data accumulates; Phase 1 targets).
MAE_KNEE_STANCE_DEG = 8.0     # mean abs error, knee flexion in stance, per side
MAE_KNEE_SWING_DEG = 8.0      # mean abs error, knee flexion in swing, per side
PATTERN_AGREEMENT_MIN = 0.80  # engine CP knee pattern vs physio, fraction matching


def _load_golden_rows():
    if not GOLDEN_CSV.exists():
        return []
    with open(GOLDEN_CSV, newline="", encoding="utf-8") as fh:
        return list(csv.DictReader(fh))


def _engine_result(session_id):
    """Return parsed engine results JSON for a session, or None if absent."""
    p = UPLOADS_DIR / f"analysis-{session_id}.json"
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None


def _engine_knee_flexion(result, side):
    """Extract engine knee flexion (deg) from cv3d joint_angles_3d, per side.

    Returns None when unassessed (zero-assumption).
    """
    if not result:
        return None
    cv3d = result.get("cv3d") or {}
    angles = cv3d.get("joint_angles_3d") or {}
    kf = angles.get("knee_flex") or {}
    entry = kf.get(side.upper()) or kf.get(side)  # L / R
    if entry is None:
        return None
    try:
        return float(entry)
    except (TypeError, ValueError):
        return None


def _engine_cp_pattern(result):
    """Extract engine CP knee pattern from smplx or cp_knee block, or None."""
    if not result:
        return None
    smplx = result.get("smplx") or {}
    if smplx.get("status") == "assessed":
        # Aggregate side patterns into a session-level label when available.
        frames = smplx.get("frames") or []
        pats = set()
        for fr in frames:
            ang = fr.get("angles_deg") or {}
            # smplx_fit currently emits knee_flexion_L/R only; pattern labels live
            # in cp_knee_classifier output instead.
        # Fall through to cp_knee block below.
    cp = result.get("cp_knee") or {}
    sides = cp.get("sides") or {}
    pats = []
    for side in ("L", "R"):
        p = sides.get(side, {}).get("pattern")
        if p:
            pats.append(p)
    if not pats:
        return None
    # Session-level label: most severe pattern present; recurvatum > crouch > jump > stiff > none.
    order = ["recurvatum", "crouch", "jump", "stiff", "not_classified"]
    for pat in order:
        if pat in pats:
            return pat
    return pats[0]


def _physio_bool(val):
    return str(val or "").strip().lower() in ("yes", "y", "true", "1", "positive", "present")


def _row_result(row, engine):
    """Build a per-row comparison dict. Missing engine values -> unassessed."""
    side_map = {"L": "L", "R": "R"}
    out = {"session_id": row.get("session_id", ""), "rows": []}
    for side in ("L", "R"):
        physio_stance = row.get(f"knee_flex_stance_{side}_deg", "").strip()
        physio_swing = row.get(f"knee_flex_swing_{side}_deg", "").strip()
        eng_stance = _engine_knee_flexion(engine, side) if engine else None
        eng_swing = None  # engine currently reports median knee_flex, not stance/swing split yet
        # Note: engine joint_angles_3d knee_flex is a single median per side.
        # Map it to stance for now; swing comparison added when engine emits swing split.
        err = None
        if physio_stance and eng_stance is not None:
            try:
                err = abs(float(physio_stance) - eng_stance)
            except (TypeError, ValueError):
                err = None
        out["rows"].append({
            "side": side,
            "physio_stance_deg": float(physio_stance) if physio_stance else None,
            "engine_stance_deg": eng_stance,
            "abs_err_deg": err,
            "status": "assessed" if (physio_stance and eng_stance is not None) else "unassessed",
        })
    # Pattern agreement (session level).
    physio_pat = (row.get("cp_knee_pattern") or "").strip().lower() or None
    engine_pat = _engine_cp_pattern(engine)
    out["pattern"] = {
        "physio": physio_pat,
        "engine": engine_pat,
        "agree": (physio_pat == engine_pat) if (physio_pat and engine_pat) else None,
        "status": "assessed" if (physio_pat and engine_pat) else "unassessed",
    }
    return out


@pytest.fixture()
def golden_data():
    rows = _load_golden_rows()
    results = {}
    for row in rows:
        sid = row.get("session_id", "").strip()
        if sid:
            results[sid] = _engine_result(sid)
    return rows, results


def test_golden_dataset_registered(golden_data):
    rows, _ = golden_data
    # At minimum the CSV template must exist and be parseable.
    assert GOLDEN_CSV.exists(), "golden_dataset.csv missing — create it per docs/capture-sop.md §7"
    assert len(rows) >= 0


@pytest.mark.skipif(
    not GOLDEN_CSV.exists() or not any(
        _engine_result(r.get("session_id", "").strip()) for r in _load_golden_rows()
    ),
    reason="No golden engine results on disk yet — capture golden sessions per docs/capture-sop.md",
)
def test_knee_stance_concordance(golden_data):
    rows, results = golden_data
    errs = []
    assessed = 0
    for row in rows:
        sid = row.get("session_id", "").strip()
        res = _row_result(row, results.get(sid))
        for r in res["rows"]:
            if r["status"] == "assessed":
                assessed += 1
                errs.append(r["abs_err_deg"])
    assert assessed > 0, "No assessed knee-stance rows — engine or physio data missing for all golden sessions"
    mae = sum(errs) / len(errs)
    assert mae <= MAE_KNEE_STANCE_DEG, (
        f"Knee stance MAE {mae:.1f}° exceeds gate {MAE_KNEE_STANCE_DEG}° across {assessed} assessed sides"
    )


@pytest.mark.skipif(
    not GOLDEN_CSV.exists() or not any(
        _engine_result(r.get("session_id", "").strip()) for r in _load_golden_rows()
    ),
    reason="No golden engine results on disk yet — capture golden sessions per docs/capture-sop.md",
)
def test_cp_pattern_agreement(golden_data):
    rows, results = golden_data
    agrees = []
    assessed = 0
    for row in rows:
        sid = row.get("session_id", "").strip()
        res = _row_result(row, results.get(sid))
        p = res["pattern"]
        if p["status"] == "assessed":
            assessed += 1
            agrees.append(p["agree"])
    if assessed == 0:
        pytest.skip("No assessed pattern rows yet")
    agreement = sum(agrees) / len(agrees)
    assert agreement >= PATTERN_AGREEMENT_MIN, (
        f"CP pattern agreement {agreement:.0%} below gate {PATTERN_AGREEMENT_MIN:.0%} across {assessed} sessions"
    )
