#!/usr/bin/env python3
# scripts/mark-golden.py
# Mark a gait session as golden for the engine-vs-physio concordance harness.
#
# A golden session has a completed physiotherapist manual assessment per
# docs/capture-sop.md (goniometry, CP knee pattern, BBS, TUG, GMFCS).
#
# Usage:
#   python scripts/mark-golden.py <session_id> [--golden|--ungolden]
#   python scripts/mark-golden.py 42 --golden
#
# Writes:
#   - sets is_golden on the gait_sessions row (SQLite)
#   - ensures a row exists in tests/golden/golden_dataset.csv for session_id

import argparse
import csv
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import sqlite3

DEFAULT_DB = ROOT / "db" / "brc.db"
# Fall back to common locations
CANDIDATE_DBS = [ROOT / "db" / "brc.db", ROOT / "brc.db", ROOT / "uploads" / "brc.db", ROOT / "database.db"]
DB_PATH = next((p for p in CANDIDATE_DBS if p.exists()), DEFAULT_DB)

GOLDEN_CSV = ROOT / "tests" / "golden" / "golden_dataset.csv"
GOLDEN_CSV.parent.mkdir(parents=True, exist_ok=True)
GOLDEN_CSV_HEADERS = [
    "session_id", "patient_id", "age_years", "gender", "diagnosis", "gmfcS_level", "golden",
    "capture_date", "captured_by",
    "knee_flex_stance_L_deg", "knee_flex_stance_R_deg",
    "knee_flex_swing_L_deg", "knee_flex_swing_R_deg",
    "hip_flex_stance_L_deg", "hip_flex_stance_R_deg",
    "hip_flex_swing_L_deg", "hip_flex_swing_R_deg",
    "ankle_dfx_stance_L_deg", "ankle_dfx_stance_R_deg",
    "cp_knee_pattern", "pelvic_obliquity", "trendelenburg",
    "bbs_total", "bbs_mobility_band", "tug_seconds", "gmfcS_level_physio",
    "engine_knee_flex_stance_L_deg", "engine_knee_flex_stance_R_deg",
    "engine_knee_flex_swing_L_deg", "engine_knee_flex_swing_R_deg",
    "engine_cp_knee_pattern_L", "engine_cp_knee_pattern_R",
    "concordance_pass", "mae_knee_stance_deg", "mae_knee_swing_deg", "notes",
]


def _connect(db_path):
    if not db_path.exists():
        raise FileNotFoundError(f"SQLite DB not found at {db_path}. Pass --db with the correct path.")
    return sqlite3.connect(str(db_path))


def _session_exists(conn, session_id):
    cur = conn.execute("SELECT id, status, user_id FROM gait_sessions WHERE id = ?", (session_id,))
    return cur.fetchone()


def _set_golden(conn, session_id, golden):
    conn.execute(
        "UPDATE gait_sessions SET is_golden = ?, updated_at = datetime('now') WHERE id = ?",
        (1 if golden else 0, session_id),
    )
    conn.commit()


def _ensure_csv_row(session_id):
    rows = []
    exists = False
    if GOLDEN_CSV.exists():
        with open(GOLDEN_CSV, newline="", encoding="utf-8") as fh:
            reader = csv.DictReader(fh)
            headers = reader.fieldnames or GOLDEN_CSV_HEADERS
            for row in reader:
                if row.get("session_id") == str(session_id):
                    exists = True
                    row["session_id"] = str(session_id)
                rows.append(row)
    else:
        headers = GOLDEN_CSV_HEADERS

    if not exists:
        new_row = {h: "" for h in headers}
        new_row["session_id"] = str(session_id)
        new_row["golden"] = "1"
        rows.append(new_row)

    with open(GOLDEN_CSV, "w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=headers)
        writer.writeheader()
        writer.writerows(rows)


def main(argv=None):
    ap = argparse.ArgumentParser(description="Mark/unmark a gait session as golden for concordance testing")
    ap.add_argument("session_id", type=int, help="gait_sessions.id to mark")
    group = ap.add_mutually_exclusive_group(required=True)
    group.add_argument("--golden", action="store_true", help="mark session as golden")
    group.add_argument("--ungolden", action="store_true", help="unmark session as golden")
    ap.add_argument("--db", default=str(DEFAULT_DB), help="path to SQLite DB (default: brc.db)")
    ns = ap.parse_args(argv if argv is not None else sys.argv[1:])

    db_path = Path(ns.db)
    golden = bool(ns.golden)

    conn = _connect(db_path)
    try:
        row = _session_exists(conn, ns.session_id)
        if not row:
            print(f"Session {ns.session_id} not found in gait_sessions.", file=sys.stderr)
            return 1
        if row[1] != "analyzed" and golden:
            print(
                f"Session {ns.session_id} status is '{row[1]}', not 'analyzed'. "
                "Run the analysis pipeline first, then mark golden.",
                file=sys.stderr,
            )
            return 1
        _set_golden(conn, ns.session_id, golden)
        _ensure_csv_row(ns.session_id)
        print(f"Session {ns.session_id} {'marked golden' if golden else 'unmarked golden'}.")
        print(f"CSV row ensured in {GOLDEN_CSV}")
        print("Next: have the treating physiotherapist fill the physio columns in tests/golden/golden_dataset.csv")
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
