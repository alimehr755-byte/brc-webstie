"""BRC Gait Lab — Clinical Assessment Engines (Codename: brc_scales).

Offline, zero-cloud-dependency, standard-library-only clinical scoring
engine implementing the Berg Balance Scale (BBS) per the project brief
(``y.txt``) plus published research cutoffs. Peer-reviewed citations are
embedded with every interpretation so reports stay traceable
(``docs/references/SOURCES.md`` R1-R18).

Design principles (binding, from ``BRC_Gait_Lab_MultiView_Spec.md``):
* **P1 — Zero-assumption protocol**: nothing is interpreted unless the
  data it depends on exists. Missing items are reported, never inferred.
* **P4 — Application-layer role gating**: this module enforces no roles
  trust boundaries); callers (``routes/scales.js``, ``routes/gait.js``)
  gate role access before invoking.
* **Non-diagnostic scope**: outputs are screening indicators that must be
  interpreted by a certified practitioner; every report states this.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional


# ---------------------------------------------------------------------------
# Static knowledge tables (single source of truth for the web app too)
# ---------------------------------------------------------------------------

# The 14 BBS tasks with: clinical purpose, predicted gait deficit when the
# item scores <= 2 (biomechanics mapping from project brief), and the
# observable BRC engine parameter(s) that can corroborate or refute the
# prediction (BBS-kinematics cross-validation). ``observable=None`` means
# the deficit cannot be measured by 2D markerless video gait analysis, so
# any cross-check for it is emitted as ``unassessed`` (P1).
BBS_ITEMS_DEF: Dict[int, Dict[str, Any]] = {
    1: {
        "task": "Sitting to standing",
        "purpose": "Lower extremity strength & dynamic centre-of-mass shift",
        "predicted_gait_deficit": "Reduced initial gait propulsion; increased double-support time at gait initiation; lower cadence",
        "observable_params": [["cycle", "cadence_cycles_per_second"], ["cycle", "stance_pct"]],
        "gait_belt": False,
    },
    2: {
        "task": "Standing unsupported",
        "purpose": "Static postural control & baseline balance",
        "predicted_gait_deficit": "Increased lateral foot placement variability during gait",
        "observable_params": [["cv", "frontal", "metrics", "step_width_mean"], ["cv", "frontal", "metrics", "weight_shift_max"]],
        "gait_belt": False,
    },
    3: {
        "task": "Sitting unsupported",
        "purpose": "Core/trunk balance without lower-limb support",
        "predicted_gait_deficit": "Excessive frontal-plane body sway during stance; stance-phase asymmetry",
        "observable_params": [["cv", "frontal", "coronal_load", "weight_shift_mean"]],
        "gait_belt": False,
    },
    4: {
        "task": "Standing to sitting",
        "purpose": "Eccentric quadriceps control",
        "predicted_gait_deficit": "Shortened loading response; reduced stance-phase knee flexion shock absorption",
        "observable_params": [["cv", "sagittal", "rom", "L", "knee_max"], ["cv", "sagittal", "rom", "R", "knee_max"]],
        "gait_belt": False,
    },
    5: {
        "task": "Transfers",
        "purpose": "Multidirectional motor control & weight shifting",
        "predicted_gait_deficit": "Difficulty with gait turn transitions; asymmetric step lengths; hesitation at initiation",
        "observable_params": [["cv", "sagittal", "stride_symmetry"]],
        "gait_belt": True,
    },
    6: {
        "task": "Standing with eyes closed",
        "purpose": "Somatosensory & vestibular reliance",
        "predicted_gait_deficit": "Vision-dependent gait: reduced speed, guarded gait in dim conditions",
        "observable_params": None,
        "gait_belt": False,
    },
    7: {
        "task": "Standing with feet together",
        "purpose": "Reduced base-of-support static stability",
        "predicted_gait_deficit": "Compensatory wide-base gait (increased stance width) for mediolateral instability",
        "observable_params": [["cv", "frontal", "metrics", "step_width_mean"]],
        "gait_belt": False,
    },
    8: {
        "task": "Reaching forward with outstretched arm",
        "purpose": "Limit of stability & anterior centre-of-mass displacement",
        "predicted_gait_deficit": "Restricted forward terminal-stance step length; reduced push-off propulsion",
        "observable_params": [["cycle", "cycle_seconds"], ["cv", "sagittal", "rom", "L", "hip_peak"]],
        "gait_belt": True,
    },
    9: {
        "task": "Retrieving object from floor",
        "purpose": "Dynamic flexion & multi-segment balance",
        "predicted_gait_deficit": "Elevated stumble risk; reduced ankle dorsiflexion; poor swing foot clearance",
        "observable_params": [["cv", "sagittal", "rom", "L", "ankle_rom"], ["cv", "sagittal", "rom", "R", "ankle_rom"]],
        "gait_belt": True,
    },
    10: {
        "task": "Turning to look behind",
        "purpose": "Dynamic axial trunk rotation",
        "predicted_gait_deficit": "Reduced transverse-plane pelvic rotation producing an en-bloc walking pattern",
        "observable_params": None,
        "gait_belt": False,
    },
    11: {
        "task": "Turning 360 degrees",
        "purpose": "Rapid pivot balance & dynamic coordination",
        "predicted_gait_deficit": "Increased turn-step count; freeze-of-gait episodes; turning asymmetry",
        "observable_params": None,
        "gait_belt": True,
    },
    12: {
        "task": "Placing alternate foot on stool",
        "purpose": "Single-leg balance during dynamic motion",
        "predicted_gait_deficit": "Swing-phase instability; unequal loading times",
        "observable_params": [["cv", "sagittal", "stride_symmetry"], ["cv", "sagittal", "knee_flexion_si"], ["cv", "sagittal", "hip_flexion_si"]],
        "gait_belt": True,
    },
    13: {
        "task": "Tandem stance",
        "purpose": "Narrow base-of-support dynamic stability",
        "predicted_gait_deficit": "Erratic step trajectory; exaggerated lateral compensatory steps",
        "observable_params": [["cv", "frontal", "metrics", "step_width_mean"], ["cv", "frontal", "metrics", "weight_shift_max"]],
        "gait_belt": True,
    },
    14: {
        "task": "Standing on one leg",
        "purpose": "Unilateral stance balance & hip abductor strength",
        "predicted_gait_deficit": "Unstable single-support phase; Trendelenburg gait (hip drop)",
        "observable_params": [["cv", "frontal", "metrics", "pelvic_obliquity_mean"], ["cv", "frontal", "metrics", "pelvic_obliquity_max"]],
        "gait_belt": True,
    },
}

# Population-conditional fall-risk cutoffs. ``general`` applies when the
# population is unknown; values are the pair (cutoff_seconds, citation).
TUG_POPULATION_CUTOFFS: Dict[str, Dict[str, Any]] = {
    "general": {
        "label": "Community-dwelling / general",
        "cutoff_s": 13.5,
        "citation": "Shumway-Cook 2000; validated meta-analysis Barry 2014 (R1, R2)",
        "anomaly_note": "Barry 2014: at 13.5 s TUG is more useful for ruling in (Sp 0.74) "
                        "than ruling out (Sn 0.31) falls — combine with clinical judgment.",
    },
    "stroke": {
        "label": "Stroke patients",
        "cutoff_s": 14.0,
        "citation": "Post-stroke cohort cutoffs 12.1-14.6 s (R2, R3); deck value 14 s",
    },
    "le_amputee": {
        "label": "Lower-limb amputees",
        "cutoff_s": 19.0,
        "citation": "Lower-limb amputee cohort (deck; within published 8.1-16 s spread outliers, R2)",
    },
    "hip_oa": {
        "label": "Hip osteoarthritis",
        "cutoff_s": 10.0,
        "citation": "Hip OA cohort (deck; R2 lower-bound range)",
    },
    "vestibular": {
        "label": "Vestibular disorders",
        "cutoff_s": 11.1,
        "citation": "Vestibular disorder cohort (deck; R2)",
    },
    "community_elderly": {
        "label": "Community-dwelling elderly (65-85)",
        "cutoff_s": 12.0,
        "citation": "Bischoff 2003: 12 s or less normal for community elderly women (R4)",
    },
}

# Mobility band (project brief / clinically common three-tier reading)
BBS_MOBILITY_BANDS: Dict[str, Dict[str, Any]] = {
    "low": {
        "label": "Low Fall Risk",
        "range": [41, 56],
        "recommendation": "Independent ambulatory status.",
    },
    "medium": {
        "label": "Medium Fall Risk",
        "range": [21, 40],
        "recommendation": "Walking assistance or assistive device (cane/walker) indicated.",
    },
    "high": {
        "label": "High Fall Risk",
        "range": [0, 20],
        "recommendation": "Maximum assistance required; primary wheelchair reliance.",
    },
}

# Clinical fall-risk cutoffs by condition (research-validated).
BBS_FALL_CUTOFFS: Dict[str, Dict[str, Any]] = {
    "general": {"cutoff": 45, "operator": "<", "text": "Scores of 45 or higher were shown to be "
                "appropriate for safe independent ambulation; below 45 indicates greater risk of falls (Berg 1995, R6)."},
    "stroke": {"cutoff": 49, "operator": "<", "text": "In stroke populations a score below 49 predicts recurrent falls "
               "after hospitalization (Sn 92%, Sp 65%) (R7/R8); 42-52 is the band for community stroke fall prediction (R8)."},
}


class GaitLabBBSModule:
    """Offline clinical engine for the 14-item Berg Balance Scale.

    Also implements the BBS-kinematics contract: ``export_data`` carries a
    ``bbs_crosscheck`` projection that ``routes/gait.js`` merges against the
    persisted gait-analysis results JSON (predicted deficit vs observed
    engine parameters vs ``unassessed``).
    """

    def __init__(self, patient_id: str, evaluator_id: Optional[str] = None) -> None:
        self.patient_id = patient_id
        self.evaluator_id: Optional[str] = evaluator_id
        self.timestamp: str = datetime.now(timezone.utc).isoformat(timespec="seconds")
        self.item_scores: Dict[int, int] = {}

    # ---------------- scoring core ----------------

    def set_item_score(self, item_number: int, score: int) -> None:
        """Validate and store an observed 0-4 score for BBS item 1-14."""
        if item_number not in BBS_ITEMS_DEF:
            raise ValueError(f"Invalid item number: {item_number}. Must be 1-14.")
        if not isinstance(score, int) or isinstance(score, bool) or not (0 <= score <= 4):
            raise ValueError(f"Invalid score {score!r} for item {item_number}. Must be integer 0-4.")
        self.item_scores[item_number] = score

    def is_complete(self) -> bool:
        """True only when all 14 items carry an observed score."""
        return len(self.item_scores) == len(BBS_ITEMS_DEF)

    def calculate_total(self) -> int:
        """Cumulative score out of 56 (partial totals allowed; completeness flagged)."""
        return int(sum(self.item_scores.values()))

    def get_fall_risk(self, population: Optional[str] = None) -> Dict[str, Any]:
        """Return total, both interpretive bands, and per-item gait flags.

        The mobility band (41-56 / 21-40 / 0-20) is reported as the
        headline; population research cutoffs are added when a
        ``population`` is provided (``None`` = general).
        """
        if not self.item_scores:
            raise ValueError("No scores recorded yet — nothing to interpret (zero-assumption).")

        total = self.calculate_total()

        band_key = "low" if total >= 41 else ("medium" if total >= 21 else "high")
        band = BBS_MOBILITY_BANDS[band_key]

        pop_key = (population or "general").lower()
        pop = TUG_POPULATION_CUTOFFS.get(pop_key)  # reuses population keys
        if pop is None:
            pop_key, pop = "general", TUG_POPULATION_CUTOFFS["general"]

        # Population-conditional BBS fall cutoff (stroke has its own).
        fall_rule = BBS_FALL_CUTOFFS["stroke"] if pop_key == "stroke" else BBS_FALL_CUTOFFS["general"]
        fall_risk = total < fall_rule["cutoff"]

        gait_flags: List[Dict[str, Any]] = []
        for item_num, score in sorted(self.item_scores.items()):
            if score <= 2:
                it = BBS_ITEMS_DEF[item_num]
                gait_flags.append({
                    "item": item_num,
                    "task": it["task"],
                    "score": score,
                    "gait_belt": it["gait_belt"],
                    "predicted_gait_deficit": it["predicted_gait_deficit"],
                    "crosscheck_params": it["observable_params"],
                })

        return {
            "patient_id": self.patient_id,
            "evaluator_id": self.evaluator_id,
            "date": self.timestamp,
            "items_recorded": len(self.item_scores),
            "items_expected": len(BBS_ITEMS_DEF),
            "complete": self.is_complete(),
            "total_score": total,
            "max_score": 56,
            "mobility_band": {
                "level": band["label"],
                "recommendation": band["recommendation"],
                "note": "Mobility-assistance band (41-56 / 21-40 / 0-20).",
            },
            "fall_screen": {
                "population": pop_key,
                "population_label": pop["label"],
                "cutoff": fall_rule["cutoff"],
                "total": total,
                "risk_flagged": bool(fall_risk),
                "text": fall_rule["text"],
            },
            "gait_impact_flags": gait_flags,
        }

    # ---------------- serialization ----------------

    def export_data(self, population: Optional[str] = None) -> Dict[str, Any]:
        """Serialize the itemized + aggregated payload for local/web storage.

        ``population`` (optional) selects the conditional fall cutoff set
        (same keys as ``TUG_POPULATION_CUTOFFS``).
        """
        payload = self.get_fall_risk(population)
        payload["itemized_scores"] = {str(k): v for k, v in sorted(self.item_scores.items())}
        payload["generical_audit"] = {
            "zero_assumption_validated": self.is_complete(),
            "physician_supervision_required": True,
            "gait_belt_items": [i for i, it in BBS_ITEMS_DEF.items() if it["gait_belt"]],
            "non_diagnostic_disclaimer": (
                "The BBS risk band is a clinical screening indicator and must be "
                "interpreted alongside a certified practitioner's physical examination."
            ),
        }
        return payload


def crosscheck_bbs_against_gait(bbs_payload: Dict[str, Any],
                                gait_results: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Merge BBS predictions with observed gait-engine parameters.

    For every low-scoring item (<=2) its predicted deficit's corroborating
    engine parameters are read from ``gait_results`` (the canonical
    ``gait_sessions.results`` JSON). Each entry reports
    ``assessed`` (predicted + observed) or ``unassessed`` (parameter path
    absent) — never inferred (P1).
    """
    out: List[Dict[str, Any]] = []

    def _lookup(doc: Dict[str, Any], path: List[str]) -> Any:
        cur: Any = doc
        for k in path:
            if not isinstance(cur, dict) or k not in cur:
                return None
            cur = cur[k]
        return cur

    for flag in bbs_payload.get("gait_impact_flags", []):
        params = flag.get("crosscheck_params")
        if not params:
            out.append({
                "bbs_item": flag["item"],
                "task": flag["task"],
                "bbsscore": flag["score"],
                "predicted_deficit": flag["predicted_gait_deficit"],
                "status": "unassessed",
                "reason": "Predicted deficit is not observable by 2D markerless video gait analysis.",
            })
            continue
        observed: List[Dict[str, Any]] = []
        any_found = False
        for path in params:
            val = _lookup(gait_results, path)
            if val is not None:
                any_found = True
            observed.append({"param": ".".join(path), "value": val})
        out.append({
            "bbs_item": flag["item"],
            "task": flag["task"],
            "bbs_score": flag["score"],
            "predicted_deficit": flag["predicted_gait_deficit"],
            "status": "assessed" if any_found else "unassessed",
            "observed_params": observed,
            "reason": None if any_found else "No supporting gait-analysis parameter present in this session (P1: withheld, not inferred).",
        })
    return out


# ---------------------------------------------------------------------------
# CLI entry (python bbs_engine.py '{"1":4,...}' [population])
# ---------------------------------------------------------------------------

def main(argv: Optional[List[str]] = None) -> int:
    import sys

    args = sys.argv[1:] if argv is None else argv
    if len(args) < 2 or args[0] in ("-h", "--help"):
        print("Usage: python bbs_engine.py PATIENT_ID '<json item scores>' [POPULATION] [--json]")
        print('Example: python bbs_engine.py PATIENT-8821 \'{"1":4,"2":4,"3":4,"4":3,"5":3,"6":2,"7":3,'
              '"8":2,"9":3,"10":4,"11":3,"12":2,"13":1,"14":1}\' stroke')
        return 0

    patient_id, scores_json = args[0], args[1]
    population = None
    for extra in args[2:]:
        if not extra.startswith("--"):
            population = extra

    raw = json.loads(scores_json)
    mod = GaitLabBBSModule(patient_id)
    for k, v in raw.items():
        mod.set_item_score(int(k), int(v))
    payload = mod.export_data(population)
    print(json.dumps(payload, indent=4))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
