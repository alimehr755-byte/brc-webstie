#!/usr/bin/env python
"""BRC Gait Lab — Clinical Scales unified offline CLI.

One terminal entry point for every clinical scale engine. Zero network
requirements (project brief ``y.txt``: fully offline local terminal).

Usage:
    python scales_cli.py bbs  PATIENT_ID '<json item scores>' [POPULATION]
    python scales_cli.py tug  '<json data>'          e.g. {"seconds": 15.4, "population": "stroke"}
    python scales_cli.py gmfcs '<json data>'         e.g. {"level": "III", "age_years": 7}
    python scales_cli.py oga  '<json data>'          e.g. {"observations": [...]}
    python scales_cli.py list
"""

from __future__ import annotations

import json
import sys
from typing import List, Optional


def _read_stdin_json() -> dict:
    """Read a JSON object from stdin (avoids Windows argv-quoting issues)."""
    raw = sys.stdin.read() if not sys.stdin.isatty() else ""
    if not raw.strip():
        return {}
    return json.loads(raw)


def main(argv: Optional[List[str]] = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if not args or args[0] in ("-h", "--help"):
        print(__doc__)
        return 0

    scale = args[0].lower()

    if scale in ("list", "scales"):
        print(json.dumps({
            "implemented": ["bbs", "tug", "gmfcs", "oga"],
            "stubs": list(__import__("scales_registry").SCALE_STUBS.keys()),
        }, indent=2))
        return 0

    if scale == "bbs":
        data: dict = {}
        if len(args) >= 3 and args[2] != "-":
            data = {"patient_id": args[1],
                    "item_scores": json.loads(args[2]),
                    **({"population": args[3]} if len(args) > 3 else {})}
        elif not sys.stdin.isatty():
            # Payload piped over stdin (HTTP route path) — with or without a
            # positional patient id. Never let isatty=True swallow the JSON.
            data = _read_stdin_json()
            if data and len(args) >= 2 and "patient_id" not in data:
                data["patient_id"] = args[1]
        else:
            data = {"patient_id": args[1] if len(args) > 1 else "unknown"}
        from bbs_engine import GaitLabBBSModule
        mod = GaitLabBBSModule(str(data.get("patient_id", "unknown")),
                               data.get("evaluator_id"))
        for k, v in (data.get("item_scores") or {}).items():
            mod.set_item_score(int(k), int(v))
        population = data.get("population")
        exp = mod.export_data(population)
        # Tracking envelope keys so the persistence contract is uniform:
        # every engine payload carries `status` and `total` (BBS total_score/pass).
        exp["total"] = exp.get("total_score")
        exp["status"] = "assessed" if exp.get("complete") else "unassessed"
        print(json.dumps(exp, indent=4))
        return 0

    if scale in ("tug", "gmfcs", "oga"):
        data = _read_stdin_json() if (len(args) < 2 or args[1] == "-") else json.loads(args[1])
        from scales_registry import scale_payload
        print(json.dumps(scale_payload(scale, data), indent=4))
        return 0

    # Anything else (including stub scales) is routed through the registry
    # so the payload shape and persistence contract stay identical.
    from scales_registry import scale_payload
    data = _read_stdin_json() if (len(args) < 2 or args[1] == "-") else json.loads(args[1])
    print(json.dumps(scale_payload(scale, data), indent=4))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
