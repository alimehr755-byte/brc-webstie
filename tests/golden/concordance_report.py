#!/usr/bin/env python3
# tests/golden/concordance_report.py
# Auto-generates an engine-vs-physio concordance report from golden sessions.
#
# Usage:
#   python tests/golden/concordance_report.py [--out tests/golden/concordance_report.html]
#
# Reads:
#   tests/golden/golden_dataset.csv          (physio ground truth)
#   uploads/gait/analysis-<session_id>.json  (engine results)
#
# Writes:
#   <out>                                     (HTML report)
#   tests/golden/concordance_summary.json     (machine-readable summary)
#
# Zero-assumption: missing engine results or missing physio values are
# reported as "unassessed" — never inferred. Fails gracefully (exit 0) when
# no golden data exists; exits 1 when thresholds are breached AND data exists.

import argparse
import csv
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
GOLDEN_CSV = HERE / "golden_dataset.csv"
UPLOADS_DIR = ROOT / "uploads" / "gait"
SUMMARY_JSON = HERE / "concordance_summary.json"

MAE_KNEE_STANCE_DEG = 8.0
PATTERN_AGREEMENT_MIN = 0.80


def _engine_result(session_id):
    p = UPLOADS_DIR / f"analysis-{session_id}.json"
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None


def _engine_knee_flexion(result, side):
    if not result:
        return None
    angles = ((result.get("cv3d") or {}).get("joint_angles_3d") or {})
    kf = angles.get("knee_flex") or {}
    entry = kf.get(side.upper()) or kf.get(side)
    if entry is None:
        return None
    try:
        return float(entry)
    except (TypeError, ValueError):
        return None


def _engine_cp_pattern(result):
    if not result:
        return None
    cp = result.get("cp_knee") or {}
    sides = cp.get("sides") or {}
    pats = []
    for side in ("L", "R"):
        p = sides.get(side, {}).get("pattern")
        if p:
            pats.append(p)
    if not pats:
        return None
    order = ["recurvatum", "crouch", "jump", "stiff", "not_classified"]
    for pat in order:
        if pat in pats:
            return pat
    return pats[0]


def _build_report():
    rows = []
    if GOLDEN_CSV.exists():
        with open(GOLDEN_CSV, newline="", encoding="utf-8") as fh:
            rows = list(csv.DictReader(fh))

    sessions = []
    errs = []
    pattern_assessed = 0
    pattern_agrees = 0

    for row in rows:
        sid = (row.get("session_id") or "").strip()
        if not sid:
            continue
        engine = _engine_result(sid)
        side_rows = []
        for side in ("L", "R"):
            physio_stance_raw = (row.get(f"knee_flex_stance_{side}_deg") or "").strip()
            eng = _engine_knee_flexion(engine, side)
            physio_stance = None
            if physio_stance_raw:
                try:
                    physio_stance = float(physio_stance_raw)
                except (TypeError, ValueError):
                    physio_stance = None
            err = None
            status = "unassessed"
            if physio_stance is not None and eng is not None:
                err = abs(physio_stance - eng)
                status = "assessed"
                errs.append(err)
            side_rows.append({
                "side": side,
                "physio_stance_deg": physio_stance,
                "engine_stance_deg": eng,
                "abs_err_deg": round(err, 1) if err is not None else None,
                "status": status,
            })

        physio_pat = (row.get("cp_knee_pattern") or "").strip().lower() or None
        engine_pat = _engine_cp_pattern(engine)
        pat_agree = None
        pat_status = "unassessed"
        if physio_pat and engine_pat:
            pat_status = "assessed"
            pattern_assessed += 1
            pat_agree = (physio_pat == engine_pat)
            if pat_agree:
                pattern_agrees += 1

        mae = (sum(e for e in errs) / len(errs)) if errs else None
        sessions.append({
            "session_id": sid,
            "patient_id": row.get("patient_id", ""),
            "age_years": row.get("age_years", ""),
            "diagnosis": row.get("diagnosis", ""),
            "engine_status": (engine or {}).get("mode", "missing") if engine else "missing",
            "sides": side_rows,
            "session_mae_deg": round(mae, 1) if mae is not None else None,
            "pattern_physio": physio_pat,
            "pattern_engine": engine_pat,
            "pattern_agree": pat_agree,
            "pattern_status": pat_status,
        })

    overall_mae = round(sum(errs) / len(errs), 1) if errs else None
    overall_pattern_agree = round(pattern_agrees / pattern_assessed, 3) if pattern_assessed else None

    summary = {
        "generated_at": __import__("datetime").datetime.now().isoformat(),
        "golden_sessions": len(sessions),
        "assessed_knee_sides": len(errs),
        "overall_mae_knee_stance_deg": overall_mae,
        "mae_gate_deg": MAE_KNEE_STANCE_DEG,
        "mae_pass": (overall_mae is not None and overall_mae <= MAE_KNEE_STANCE_DEG),
        "assessed_pattern_sessions": pattern_assessed,
        "pattern_agreement": overall_pattern_agree,
        "pattern_agreement_gate": PATTERN_AGREEMENT_MIN,
        "pattern_pass": (
            overall_pattern_agree is not None and overall_pattern_agree >= PATTERN_AGREEMENT_MIN
        ),
        "sessions": sessions,
    }
    return summary


def _html(summary):
    esc = lambda s: str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    rows_html = ""
    for s in summary["sessions"]:
        side_html = ""
        for sd in s["sides"]:
            err = sd["abs_err_deg"]
            err_txt = f"{err}°" if err is not None else "—"
            side_html += (
                f"<tr><td>{esc(sd['side'])}</td>"
                f"<td>{sd['physio_stance_deg'] if sd['physio_stance_deg'] is not None else '—'}</td>"
                f"<td>{sd['engine_stance_deg'] if sd['engine_stance_deg'] is not None else '—'}</td>"
                f"<td>{err_txt}</td>"
                f"<td>{sd['status']}</td></tr>"
            )
        pat_agree_txt = "—" if s["pattern_agree"] is None else ("yes" if s["pattern_agree"] else "no")
        rows_html += (
            f"<tr>"
            f"<td>{esc(s['session_id'])}</td>"
            f"<td>{esc(s['engine_status'])}</td>"
            f"<td>{side_html}</td>"
            f"<td>{s['session_mae_deg'] if s['session_mae_deg'] is not None else '—'}</td>"
            f"<td>{esc(s['pattern_physio'] or '—')}</td>"
            f"<td>{esc(s['pattern_engine'] or '—')}</td>"
            f"<td>{pat_agree_txt}</td>"
            f"<td>{s['pattern_status']}</td>"
            f"</tr>"
        )

    mae_pass_txt = (
        "PASS"
        if summary["mae_pass"] is True
        else ("FAIL" if summary["mae_pass"] is False else "n/a (no data)")
    )
    pat_pass_txt = (
        "PASS"
        if summary["pattern_pass"] is True
        else ("FAIL" if summary["pattern_pass"] is False else "n/a (no data)")
    )

    return f"""<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>BRC Gait Lab — Engine vs Physio Concordance</title>
<style>body{{font-family:system-ui,-apple-system,Segoe UI,sans-serif;margin:24px;}}
h1{{font-size:1.4rem;margin-bottom:8px;}}
.sub{{color:#5a5d55;font-size:.9rem;margin-bottom:20px;}}
table{{border-collapse:collapse;width:100%;margin-top:12px;}}
th,td{{border:1px solid #e1eef8;padding:6px 8px;text-align:left;font-size:.85rem;}}
th{{background:#f0f7fc;font-weight:600;}}
tr:nth-child(even){{background:#fbfdfe;}}
.kpi{{display:flex;gap:16px;margin-bottom:20px;}}
.kpi div{{border:1px solid #e1eef8;border-radius:8px;padding:12px 16px;flex:1;}}
.kpi .v{{font-size:1.5rem;font-weight:700;color:#1e3c82;}}
.kpi .l{{font-size:.75rem;color:#5a5d55;text-transform:uppercase;letter-spacing:.6px;}}
.pass{{color:#2f7a4d;}}.fail{{color:#b3452f;}}.na{{color:#8a5a00;}}
.note{{font-size:.8rem;color:#5a5d55;margin-top:16px;}}</style></head>
<body>
<h1>BRC Gait Lab — Engine vs Physio Concordance</h1>
<p class="sub">Generated {esc(summary['generated_at'])} &nbsp;·&nbsp; {summary['golden_sessions']} golden session(s)</p>
<div class="kpi">
  <div><div class="l">Overall knee-stance MAE</div><div class="v">{summary['overall_mae_knee_stance_deg'] if summary['overall_mae_knee_stance_deg'] is not None else '—'}°</div><div class="note">Gate ≤ {summary['mae_gate_deg']}° · <span class="{'pass' if summary['mae_pass'] is True else ('fail' if summary['mae_pass'] is False else 'na')}">{mae_pass_txt}</span></div></div>
  <div><div class="l">CP pattern agreement</div><div class="v">{summary['pattern_agreement'] if summary['pattern_agreement'] is not None else '—'}</div><div class="note">Gate ≥ {int(summary['pattern_agreement_gate']*100)}% · <span class="{'pass' if summary['pattern_pass'] is True else ('fail' if summary['pattern_pass'] is False else 'na')}">{pat_pass_txt}</span></div></div>
  <div><div class="l">Assessed knee sides</div><div class="v">{summary['assessed_knee_sides']}</div><div class="note">of {summary['golden_sessions']*2} possible</div></div>
  <div><div class="l">Assessed pattern sessions</div><div class="v">{summary['assessed_pattern_sessions']}</div><div class="note">of {summary['golden_sessions']} possible</div></div>
</div>
<table>
<thead><tr>
<th>Session</th><th>Engine status</th><th colspan="2">Knee stance (L / R)</th><th>Session MAE</th><th>Pattern physio</th><th>Pattern engine</th><th>Agree</th><th>Status</th>
</tr></thead>
<tbody>{rows_html}</tbody>
</table>
<p class="note">Zero-assumption: '—' means the value was not measured (engine missing, physio blank, or pattern unclassified). No values are inferred.</p>
</body></html>"""


def main():
    ap = argparse.ArgumentParser(description="Generate engine-vs-physio concordance report")
    ap.add_argument("--out", default=str(HERE / "concordance_report.html"),
                    help="HTML output path")
    ns = ap.parse_args()

    summary = _build_report()
    SUMMARY_JSON.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    Path(ns.out).write_text(_html(summary), encoding="utf-8")

    print(f"Golden sessions: {summary['golden_sessions']}")
    print(f"Assessed knee sides: {summary['assessed_knee_sides']}")
    mae_val = summary['overall_mae_knee_stance_deg'] if summary['overall_mae_knee_stance_deg'] is not None else 'n/a'
    print(f"Overall knee-stance MAE: {mae_val} deg (gate <= {summary['mae_gate_deg']} deg)")
    pat_val = summary['pattern_agreement'] if summary['pattern_agreement'] is not None else 'n/a'
    print(f"Pattern agreement: {pat_val} (gate >= {int(summary['pattern_agreement_gate']*100)}%)")
    print(f"HTML report: {ns.out}")
    print(f"Summary JSON: {SUMMARY_JSON}")

    # Exit 1 only when data exists AND a gate is breached with actual values.
    if summary["golden_sessions"] > 0:
        breached = []
        if summary["assessed_knee_sides"] > 0 and summary["mae_pass"] is False:
            breached.append("knee-stance MAE")
        if summary["assessed_pattern_sessions"] > 0 and summary["pattern_pass"] is False:
            breached.append("CP pattern agreement")
        if breached:
            print(f"GATE BREACHED: {', '.join(breached)}", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
