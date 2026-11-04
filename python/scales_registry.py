"""BRC Gait Lab — Clinical Scales Registry.

Machine-readable definitions for every functional assessment scale served
by the Gait Lab. The Node web layer (``routes/scales.js``) reads nothing
second-hand: scoring logic that is defined here is executed here, through
``scale_payload``. Formatting only, no interpretation duplication.

Sources for every constant are recorded inline with token citations that
resolve in ``docs/references/SOURCES.md`` (decks: Farhan Shah, KMU;
research: R1-R18).

Zero-assumption (P1): each scale definition declares ``gating`` data it
needs (e.g. GMFCS needs age band). When gating data is missing the payload
is emitted with ``status: "unassessed"`` and an explicit reason.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

# ---------------------------------------------------------------------------
# Timed Up and Go (functional mobility / fall-risk screening)
# ---------------------------------------------------------------------------

TUG_METHOD = {
    "setup": "Chair with armrests (seat height approx. 46 cm per R1 protocol) + 3 m walkway marked with tape + stopwatch.",
    "protocol": [
        "Patient wears regular footwear and customary walking aid (document the aid).",
        "Start seated; stand on command; walk 3 m; turn; walk back; sit down.",
        "Time stops when the patient is seated.",
        "One untimed practice trial is recommended (R1).",
    ],
    "observations": [
        "Slow tentative pace", "Loss of balance", "Short strides",
        "Little or no arm swing", "Steadying self on walls", "Shuffling",
        "En-bloc turning", "Not using assistive device properly",
    ],
    "cutoffs": {
        "general": {"cutoff_s": 13.5, "label": "Community-dwelling / general", "source": "R1/R2"},
        "stroke": {"cutoff_s": 14.0, "label": "Stroke patients", "source": "R2/R3 + deck"},
        "le_amputee": {"cutoff_s": 19.0, "label": "Lower-limb amputees", "source": "deck"},
        "hip_oa": {"cutoff_s": 10.0, "label": "Hip osteoarthritis", "source": "deck/R2"},
        "vestibular": {"cutoff_s": 11.1, "label": "Vestibular disorders", "source": "deck/R2"},
        "community_elderly": {"cutoff_s": 12.0, "label": "Community-dwelling elderly 65-85", "source": "R4"},
    },
}

# ---------------------------------------------------------------------------
# GMFCS-E&R (classification — 5 levels x 5 age bands)
# ---------------------------------------------------------------------------

GMFCS_LEVELS: Dict[str, Dict[str, str]] = {
    "I": {"title": "Walks without limitations"},
    "II": {"title": "Walks with limitations (balance, endurance)"},
    "III": {"title": "Walks using a hand-held mobility device"},
    "IV": {"title": "Self-mobility with limitations; may use powered mobility"},
    "V": {"title": "Transported in a manual wheelchair"},
}

GMFCS_AGE_BANDS: List[Dict[str, Any]] = [
    {"band": "under-2", "label": "Under 2 years", "min": 0.0, "max": 2.0},
    {"band": "2-4", "label": "2 to 4 years", "min": 2.0, "max": 4.0},
    {"band": "4-6", "label": "4 to 6 years", "min": 4.0, "max": 6.0},
    {"band": "6-12", "label": "6 to 12 years", "min": 6.0, "max": 12.0},
    {"band": "12-18", "label": "12 to 18 years", "min": 12.0, "max": 18.0},
]

GMFCS_NOTES = [
    "Classification of usual performance (what the child does), not capability or best performance (R9, R10).",
    "Not a diagnostic tool and not an outcome measure for detecting change over time (deck; R10).",
    "Family Report Questionnaire variant available for parent/classification involvement (R10).",
    "© GMFCS-E&R: Palisano, Rosenbaum, Bartlett, Livingston 2007, CanChild Centre for Childhood "
    "Disability Research, McMaster University. Used as a clinical classification reference.",
]

# ---------------------------------------------------------------------------
# Rancho Los Amigos Observational Gait Analysis (48 descriptors, GHORT)
# ---------------------------------------------------------------------------

OGA_SYSTEM = {
    "name": "Rancho Los Amigos Observational Gait Analysis (OGA)",
    "acronym": "GHORT — Gait, Homunculus, Observed, Relational, Tabulator",
    "segments": ["Ankle & Foot", "Knee", "Hip", "Pelvis", "Trunk"],
    "procedure": [
        "1. Select and measure the walking area.",
        "2. Position for unobstructed view (sagittal and/or coronal).",
        "3. Pick the first segment; mentally review its normal displacement and muscle function.",
        "4. Choose sagittal (side) or coronal (front/back) observation.",
        "5. Observe each segment across stance/swing portions; note deviations and their timing.",
        "6-7. Iterate segment-by-segment, one segment at a time in one phase at a time.",
        "8. Always observe and record BOTH sides (right and left).",
        "9-11. Hypothesize causes; confirm against clinical evaluation; plan treatment.",
        "12. Reassess periodically to measure treatment response.",
    ],
    # 48-deviator checklist condensed to the canonical per-segment deviation
    # groupings used by the digital form. Both sides are recorded per item.
    "deviators": {
        "Ankle & Foot": [
            "Forefoot initial contact (equinus)", "Foot slap", "Excessive DF at loading",
            "Heel rise early / delayed", "Toe drag in swing", "Varus foot posture",
            "Valgus foot posture", "Forefoot abduction", "Unclear (not assessable)",
        ],
        "Knee": [
            "Excessive knee flexion in stance (crouch)", "Knee hyperextension in stance (recurvatum)",
            "Insufficient knee flexion in stance", "Early knee flexion spike in loading (jump)",
            "Reduced knee flexion in swing (stiff)", "Varus thrust", "Valgus thrust",
            "Unclear (not assessable)",
        ],
        "Hip": [
            "Excessive flexion in stance", "Reduced extension at terminal stance",
            "Excessive adduction (scissoring)", "Excessive abduction", "Hip hiking",
            "Circumduction", "Unclear (not assessable)",
        ],
        "Pelvis": [
            "Anterior tilt", "Posterior tilt", "Pelvic drop (ipsilateral)",
            "Pelvic drop (contralateral) / Trendelenburg", "Increased pelvic rotation (cyclic)",
            "Reduced pelvic rotation", "Lateral pelvic protrusion",
            "Unclear (not assessable)",
        ],
        "Trunk": [
            "Anterior lean", "Lateral lean (ipsilateral)", "Lateral lean (contralateral)",
            "Increased lumbar lordosis", "Decreased arm swing", "En-bloc rotation",
            "Unclear (not assessable)",
        ],
    },
    # Timing buckets approximating the traditional + Rancho split.
    "phases": [
        "Initial contact (0-2%)", "Loading response (2-10%)", "Mid stance (10-30%)",
        "Terminal stance (30-50%)", "Pre-swing (50-60%)", "Initial swing (60-73%)",
        "Mid swing (73-87%)", "Terminal swing (87-100%)",
    ],
    "note": "Digital OGA is a corroborating observational record. It complements objective "
            "video analysis; deviations here never replace engine measurements.",
}

# ---------------------------------------------------------------------------
# Future-ready stubs (defined; UI marks them coming-soon)
# ---------------------------------------------------------------------------

SCALE_STUBS: Dict[str, Dict[str, Any]] = {
    "6mwt": {
        "label": "6-Minute Walk Test",
        "need": "Gait-test batteries (distance walked, standardized course)",
        "status": "stub",
    },
    "2mwt": {"label": "2-Minute Walk Test", "status": "stub"},
    "10mwt": {"label": "10-Meter Walk Test", "status": "stub"},
    "fac": {"label": "Functional Ambulation Categories", "status": "stub"},
    "tinetti": {"label": "Tinetti Performance-Oriented Mobility Assessment", "status": "stub"},
    "dgi": {"label": "Dynamic Gait Index", "status": "stub"},
    "fap": {"label": "Functional Ambulation Profile (parallel bars protocol)", "status": "stub"},
    "iowa_loa": {"label": "Iowa Level of Assistance Scale (7-level)", "status": "stub"},
}


def scale_payload(scale_type: str, data: Dict[str, Any]) -> Dict[str, Any]:
    """Aggregate a scale's data into a normalized payload with interpretation.

    Args:
        scale_type: 'bbs' | 'tug' | 'gmfcs' | 'oga'.
        data: raw fields (engine agnostic — see CLI for the formats).
    Returns:
        Normalized dict: includes every field the Node layer persists.
    Raises:
        ValueError: unknown scale type.
    """
    st = scale_type.lower()
    ts = datetime.now(timezone.utc).isoformat(timespec="seconds")

    if st == "bbs":
        # import here to avoid a circular import when bbs engines evolve separately
        from bbs_engine import GaitLabBBSModule as BBS

        mod = BBS(str(data.get("patient_id", "unknown")), data.get("evaluator_id"))
        for item, score in (data.get("item_scores") or {}).items():
            mod.set_item_score(int(item), int(score))
        payload = mod.export_data()
        payload["total"] = payload["total_score"]
        payload["interpretation"] = {
            "mobility_band": payload["mobility_band"]["level"],
            "fall_population": payload["fall_screen"]["population_label"],
            "fall_risk_flagged": payload["fall_screen"]["risk_flagged"],
        }
        payload["timestamp"] = ts
        return payload

    if st == "tug":
        seconds = data.get("seconds")
        population = (data.get("population") or "general").lower()
        rule = TUG_METHOD["cutoffs"].get(population) or TUG_METHOD["cutoffs"]["general"]
        used_rule = rule
        payload: Dict[str, Any] = {
            "scale_type": "tug",
            "seconds": seconds,
            "population": population,
            "population_label": used_rule["label"],
            "assistive_device": data.get("assistive_device"),
            "observations": data.get("observations") or [],
            "timestamp": ts,
        }
        if isinstance(seconds, (int, float)) and seconds > 0:
            payload["status"] = "assessed"
            payload["total"] = float(seconds)
            payload["fallback_risk"] = float(seconds) >= used_rule["cutoff_s"]
            payload["interpretation"] = {
                "cutoff_s": used_rule["cutoff_s"],
                "text": (
                    f"TUG {seconds:.1f} s vs cutoff {used_rule['cutoff_s']:.1f} s "
                    f"('{used_rule['label']}' population). {'Fall-risk flagged: rule-in only — interpret alongside other screens (R2/R3).'}"
                    if float(seconds) >= used_rule["cutoff_s"]
                    else f"TUG {seconds:.1f} s is below the {used_rule['label']} cutoff ({used_rule['cutoff_s']:.1f} s). Not a guarantee (R2)."
                ),
                "source": used_rule["source"],
            }
        else:
            payload["status"] = "unassessed"
            payload["reason"] = "No valid timing recorded; nothing interpreted."
        return payload

    if st == "gmfcs":
        age = data.get("age_years")
        level = data.get("level")
        payload = {"scale_type": "gmfcs", "timestamp": ts, "notes": GMFCS_NOTES,
                   "reported_via": data.get("reported_via", "clinician")}
        band = next((b for b in GMFCS_AGE_BANDS
                     if (age is not None and (b["min"] <= float(age) < b["max"]))), None)
        if level in GMFCS_LEVELS and band:
            payload["status"] = "assessed"
            payload["level"] = level
            payload["level_title"] = GMFCS_LEVELS[level]["title"]
            payload["age_band"] = band["band"]
            payload["age_label"] = band["label"]
            payload["total"] = level  # ordinal identifier, not a score
            payload["interpretation"] = {
                "text": f"GMFCS-E&R Level {level} — {GMFCS_LEVELS[level]['title']} ({band['label']} age band).",
                "source": "R9/R10 (Palisano 1997/2007, CanChild McMaster)",
                "caveats": GMFCS_NOTES,
            }
        else:
            payload["status"] = "unassessed"
            payload["reason"] = ("GMFCS level and a valid age band (child/adolescent) are both required — "
                                 "P1: withheld, not inferred.")
        return payload

    if st == "oga":
        entries = data.get("observations") or []
        payload = {
            "scale_type": "oga",
            "timestamp": ts,
            "method": OGA_SYSTEM["name"],
            "acronym": OGA_SYSTEM["acronym"],
            "entries": entries,
            "status": "assessed" if entries else "unassessed",
            "reason": None if entries else "No observational entries recorded.",
            "total": len(entries),
        }
        return payload

    if st in SCALE_STUBS:
        return {"scale_type": st, "status": "stub",
                "label": SCALE_STUBS[st]["label"],
                "reason": "Scale defined but not yet implemented as a form; logged as a placeholder record."}

    raise ValueError(f"Unknown scale type: {scale_type!r}")


# ---------------------------------------------------------------------------
# CLI (offline terminal use, per y.txt execution-environment contract)
# ---------------------------------------------------------------------------

def main(argv: Optional[List[str]] = None) -> int:
    import sys

    args = sys.argv[1:] if argv is None else argv
    if len(args) < 2 or args[0] in ("-h", "--help"):
        print("Usage: python scales_registry.py SCALE '{...data json...}'")
        print("Scales: bbs | tug | gmfcs | oga")
        print("Examples:")
        print("  python scales_registry.py tug '{\"seconds\": 15.4, \"population\": \"stroke\"}'")
        print("  python scales_registry.py gmfcs '{\"level\": \"III\", \"age_years\": 7}'")
        return 0

    data = json.loads(args[1])
    print(json.dumps(scale_payload(args[0], data), indent=4))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
