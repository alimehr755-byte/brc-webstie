#!/usr/bin/env python3
"""CP knee-pattern classifier (Sutherland & Davids 1993 walk-frame taxonomy).

Classifies each lower limb's knee-flexion curve (0-100 % gait cycle) into one of
the four coronarly-recognized cerebral-palsy sagittal knee patterns:

  jump        - ~premature excessive knee flexion in loading response, single
                early peak, knee retains 10-20 deg flexion through stance
                minimum.
  crouch      - knee flexion never reduces below ~30 deg through stance.
  stiff knee  - low peak knee flexion in swing (<45 deg) and/or a late swing
                peak (timing >55 % cycle) -> foot clearance difficulty.
  recurvatum  - knee hyperextension during stance (< -5 deg).

The classifier is measured-based and follows the zero-assumption protocol
(spec P1): when the knee curve or the stance-phase boundary is missing it
reports ``status: unassessed`` with a reason, never an inferred pattern.

Reference evidence lives in docs/references/SOURCES.md (R9-R11 zone):
  Sutherland, D.H. & Davids, J.R. (1993). Common gait abnormalities of the
  knee in cerebral palsy. Clinical Orthopaedics and Related Research, 288, 25-31.
  Gage, J.R. et al. (2009). The Identification and Treatment of Gait Problems
  in Cerebral Palsy. Mac Keith Press.
  Crenna, P. & Federico, P. (2004). Sagittal knee patterns in ambulant CP.

CLI (pytest-driven; also usable standalone):
    python cp_knee_classifier.py knee_flexion_curve.json stance_pct

where knee_flexion_curve.json is {"L": [...101 values...], "R": [...]}.
"""

from typing import Any, Dict, List, Optional, Tuple

import statistics

VERSION = "cp-knee-0.1.1"

CITATIONS = (
    "Sutherland & Davids (1993) Clin Orthop Relat Res 288:25-31; "
    "Gage et al. (2009) The Identification and Treatment of Gait Problems "
    "in Cerebral Palsy, Mac Keith Press"
)

# Discrete decision thresholds — kept as module constants so tests can target
# the exact decision surface.
JUMP_FIRST_PEAK_MIN = 30.0       # deg, premature flexion peak
JUMP_STANCE_MIN_LO = 10.0        # deg, stance-minimum window lower bound
JUMP_STANCE_MIN_HI = 20.0        # deg, stance-minimum window upper bound
CROUCH_STANCE_MIN = 30.0         # deg, stance minimum above -> crouch
STIFF_SWING_PEAK_MAX = 45.0      # deg, swing peak below -> stiff knee
STIFF_SWING_TIMING_COMBO_MAX = 55.0  # deg, low-amplitude partner of the delayed-peak rule
STIFF_SWING_PEAK_TIMING = 55.0   # % cycle, late swing peak beyond -> stiff
RECURVATUM_STANCE_MIN = -5.0     # deg, hyperextension beyond -> recurvatum

PATTERN_LABELS = {
    "jump": "Jump knee pattern",
    "crouch": "Crouch knee pattern",
    "stiff": "Stiff-knee pattern",
    "recurvatum": "Knee recurvatum pattern",
    "not_classified": "No walk-frame CP knee pattern met",
}

REF_LIST = "R9-R11 (Sutherland & Davids 1993; Gage 2009; Crenna 2004)"


def _first_index_at_least(x: List[float], value: float) -> Optional[int]:
    for i, v in enumerate(x):
        if v >= value:
            return i
    return None


def classify_side(curve: Optional[List[float]], stance_pct: Optional[float]) -> Dict[str, Any]:
    """Classify one limb's knee-flexion curve.

    curve: 101-point, 0-100 % gait-cycle knee-flexion series (deg; 0 = neutral
    extension - negative values indicate hyperextension).
    stance_pct: stance-phase endpoint as % gait cycle (walking), from the
    engine's validated heel-strike / toe-off estimation.
    """
    citations = CITATIONS

    base: Dict[str, Any] = {"citations": citations, "reference_list": REF_LIST,
                            "version": VERSION}

    if not curve or len(curve) < 51 or stance_pct is None or not (0.0 < stance_pct < 100.0):
        out = dict(base, status="unassessed", pattern=None,
                   reason=("No measured knee-flexion curve (or stance-phase boundary) from a "
                           "validated sagittal capture — per spec P1 the pattern is withheld, "
                           "never inferred."))
        return out

    xs = [float(v) for v in curve]
    n = len(xs)
    stance_end = max(1, min(n - 1, round(stance_pct / 100.0 * (n - 1))))

    stance = xs[: stance_end + 1]
    swing = xs[stance_end:]

    # Stance minimum for the jump / crouch windows is taken over the
    # single-support region (mature/affected landmark studies exclude the
    # heel-strike transient when quoting "minimum in single support");
    # recurvatum uses the full stance window because hyperextension peaks in
    # the loading-response / terminal-stance extremes.
    mid_start = max(1, round(0.15 * (n - 1)))
    mid_stance = xs[mid_start: stance_end + 1] if stance_end > mid_start else stance
    stance_min = min(stance)
    mid_min = min(mid_stance)
    mid_min_pct = 100.0 * (mid_start + mid_stance.index(mid_min)) / (n - 1)

    # First peak: maximum over the first half of STANCE (loading response region)
    first_peak_zone = stance[: max(2, len(stance) // 2 + 1)]
    first_peak = max(first_peak_zone)
    first_peak_pct = 100.0 * first_peak_zone.index(first_peak) / (n - 1)

    # Swing peak excludes the toe-off boundary point (index 0 of swing) so the
    # curve's stance/sagittal continuity at mid-stance does not register.
    swing_peak, swing_peak_pct = 0.0, float(stance_pct)
    if len(swing) > 1:
        swing_peak = max(swing[1:])
        swing_peak_pct = 100.0 * (stance_end + 1 + swing[1:].index(swing_peak)) / (n - 1)

    features = {
        "first_peak_flexion_deg": round(first_peak, 1),
        "first_peak_timing_pct": round(first_peak_pct, 1),
        "stance_min_flexion_deg": round(min(mid_min, stance_min), 1),
        "single_support_min_flexion_deg": round(mid_min, 1),
        "single_support_min_timing_pct": round(mid_min_pct, 1),
        "swing_peak_flexion_deg": round(swing_peak, 1),
        "swing_peak_timing_pct": round(swing_peak_pct, 1),
        "stance_pct_boundary": round(stance_pct, 1),
    }

    reasons: List[str] = []
    pattern: Optional[str] = None

    if stance_min < RECURVATUM_STANCE_MIN:
        pattern = "recurvatum"
        reasons.append(
            f"Knee extends beyond neutral in stance (min {stance_min:.1f}° < "
            f"{RECURVATUM_STANCE_MIN}° hyperextension threshold).")
    elif mid_min > CROUCH_STANCE_MIN:
        pattern = "crouch"
        reasons.append(
            f"Knee flexion never reduces below {mid_min:.1f}° through single support "
            f"(crouch threshold {CROUCH_STANCE_MIN}°).")
    elif first_peak >= JUMP_FIRST_PEAK_MIN and JUMP_STANCE_MIN_LO <= mid_min <= JUMP_STANCE_MIN_HI:
        pattern = "jump"
        reasons.append(
            f"Premature peak flexion {first_peak:.1f}° at {first_peak_pct:.0f}% cycle with a "
            f"single-support minimum held at {mid_min:.1f}° ({JUMP_STANCE_MIN_LO}-{JUMP_STANCE_MIN_HI}° "
            f"jump window).")
    elif swing_peak < STIFF_SWING_PEAK_MAX or (swing_peak < STIFF_SWING_TIMING_COMBO_MAX and
                                               swing_peak_pct > STIFF_SWING_PEAK_TIMING):
        pattern = "stiff"
        reasons.append(
            f"Swing-phase peak flexion {swing_peak:.1f}° at {swing_peak_pct:.0f}% cycle "
            f"(stiff-knee screen: <{STIFF_SWING_PEAK_MAX}° amplitude, or <"
            f"{STIFF_SWING_TIMING_COMBO_MAX}° with peak delayed past {STIFF_SWING_PEAK_TIMING}% cycle).")

    if pattern is None:
        out = dict(base,
                   status="assessed",
                   pattern="not_classified",
                   pattern_label=PATTERN_LABELS["not_classified"],
                   features=features,
                   reason=("Measured knee curve does not meet any Sutherland-Davids walk-frame "
                           "threshold (recurvatum < -5°, stance min > 30°, jump window "
                           "peak > 30° with stance min 10-20°, or swing peak < 45°/late > 55%)."),
                   decisions=reasons)
        return out

    return dict(base,
                status="assessed",
                pattern=pattern,
                pattern_label=PATTERN_LABELS[pattern],
                features=features,
                reason="; ".join(reasons) or None)


def classify_cp_knee(cv_sagittal: Dict[str, Any]) -> Dict[str, Any]:
    """Full classifier entry — takes the sagittal cross-view dict.

    Returns:
        {status: 'assessed'|'unassessed', sides: {L: side_block, R: side_block},
         citations, version}
    """
    ts = (cv_sagittal.get("timeseries") or {}).get("knee_flexion") or {}
    stance_pct = cv_sagittal.get("stance_pct")

    sides: Dict[str, Any] = {}
    for s in ("L", "R"):
        row = ts.get(s) if isinstance(ts, dict) else None
        sides[s] = classify_side(row, stance_pct)

    any_assessed = any(sides[s].get("status") == "assessed" for s in sides)
    if not any_assessed:
        return {
            "status": "unassessed",
            "version": VERSION,
            "citations": CITATIONS,
            "sides": sides,
            "reason": ("No usable knee-flexion trajectory was measured (a validated sagittal "
                       "capture is required). Pattern screening withheld per zero-assumption "
                       "protocol."),
        }
    return {
        "status": "assessed",
        "version": VERSION,
        "citations": CITATIONS,
        "sides": sides,
        "reason": None,
    }


def main(argv: Optional[List[str]] = None) -> int:
    import argparse
    import json
    import sys

    parser = argparse.ArgumentParser(
        prog="cp_knee_classifier",
        description="Classify CP sagittal knee patterns from a knee-flexion curve JSON.")
    parser.add_argument("curve_file", help="JSON file: {\"L\":[...], \"R\":[...]} knee flexion, 0-100%% cycle")
    parser.add_argument("stance_pct", type=float, help="stance-phase end, % gait cycle")
    ns = parser.parse_args(sys.argv[1:] if argv is None else argv)

    with open(ns.curve_file, "r", encoding="utf-8") as fh:
        curves = json.load(fh)
    print(json.dumps(classify_cp_knee({"timeseries": {"knee_flexion": curves},
                                        "stance_pct": ns.stance_pct}), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
