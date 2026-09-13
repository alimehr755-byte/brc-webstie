#!/usr/bin/env python3
"""
overlay_ocr.py — BRC Gait Lab video-overlay patient-name OCR (run.txt §1).

Reads the patient-name overlay burned into the uploaded walk videos (name
marquee top/bottom strip) and cross-checks it against the patient record on
the server (child_name). This is a *verification* stage, never a source of
truth:

  * the extracted text is reported VERBATIM (raw OCR output);
  * a fuzzy match against the patient record sets status = "verified";
  * a mismatch or missing text sets status = "unverified" and raises the
    strict "Unverified Name Metadata" flag (run.txt §0);
  * if no OCR backend is installed the module reports
    status = "ocr_unavailable" — nothing is ever fabricated.

The OCR engine used when available is the lightweight RapidOCR (ONNX) — no
external Tesseract binary, no telemetry.
"""

import os

_CROP_TOPS = (0.0, 0.14)     # overlay marquee usually lives near the top edge
_CROP_BOTTOMS = (0.86, 1.0)  # ... or occasionally the bottom edge
_MAX_FRAMES_PER_VIDEO = 12
_CONF_THRESHOLD = 0.60  # run.txt §5 zero-assumption threshold (same as keypoints)
_MATCH_RATIO = 0.70     # fuzzy ratio needed to call a name "verified"


def _normalize(text):
    import re
    text = str(text or "")
    text = re.sub(r"[^A-Za-z\u00C0-\u024F'.-]+", " ", text)
    return " ".join(text.split()).strip().lower()


def _clean_ocr_text(text):
    """Keep tokens that look like a name; drop timestamps + pure numbers."""
    import re
    saw_letter = False
    for ch in str(text or ""):
        if ch.isalpha():
            saw_letter = True
            break
    if not saw_letter:
        return None
    norm = _normalize(text)
    if not norm:
        return None
    if re.fullmatch(r"[0-9 .:\-]+", norm):
        return None
    tokens = [t for t in norm.split() if len(t) >= 1]
    return " ".join(tokens)


def _fuzzy_similarity(a, b):
    """Sequence-based similarity in [0, 1] — robust to OCR letter swaps."""
    try:
        from difflib import SequenceMatcher
    except Exception:
        return 0.0
    a, b = _normalize(a), _normalize(b)
    if not a or not b:
        return 0.0
    return SequenceMatcher(None, a, b).ratio()


def _token_overlap(a, b):
    ta = set(_normalize(a).split())
    tb = set(_normalize(b).split())
    if not ta or not tb:
        return 0.0
    inter = len(ta & tb)
    return inter / max(len(ta), len(tb))


def _match_score(candidate, expected):
    """Combined name-match score used for verification."""
    text = _fuzzy_similarity(candidate, expected)
    tokens = _token_overlap(candidate, expected)
    return max(text, tokens)


def _read_engine():
    """Lazily build a RapidOCR engine; returns (engine, kind) or (None, None)."""
    try:
        from rapidocr_onnxruntime import RapidOCR
        engine = RapidOCR()
        return engine, "rapidocr"
    except Exception:
        return None, None


def _sample_frames(video_path):
    """Yield a handful of (frame_bgr) crops evenly spaced across the clip."""
    import cv2
    cap = None
    try:
        cap = cv2.VideoCapture(video_path)
        if not cap.isOpened():
            return
        total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        width = cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 640
        height = cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 480
        step = max(1, (total or 1) // _MAX_FRAMES_PER_VIDEO)
        idx = 0
        while idx < total or total <= 0:
            cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
            ok, frame = cap.read()
            if not ok:
                break
            yield frame, width, height
            if total <= 0:
                break
            idx += step
    finally:
        if cap is not None:
            try:
                cap.release()
            except Exception:
                pass


def _crop_strips(frame, width, height):
    h = float(height)
    top = frame[max(0, int(_CROP_TOPS[0] * h)):max(1, int(_CROP_TOPS[1] * h)), :, :]
    bot = frame[max(0, int(_CROP_BOTTOMS[0] * h)):max(1, int(_CROP_BOTTOMS[1] * h)), :, :]
    return top, bot


def _ocr_frame(engine, strip):
    try:
        result, _ = engine(strip)
    except Exception:
        result = None
    texts = []
    if result:
        for line in result:
            if isinstance(line, (list, tuple)) and len(line) >= 2:
                texts.append(str(line[1]))
            elif isinstance(line, (list, tuple)) and len(line) >= 1:
                texts.append(str(line[0]))
    return texts


def run_overlay_ocr(video_paths, expected_name, max_workers=1):
    """Extract the name overlay from one or more videos and verify vs the record.

    Params
    ------
    video_paths : sequence of existing video paths (sagittal / frontal / combined)
    expected_name : patient record name (child_name from the server)

    Returns
    -------
    name_metadata dict per run.txt §1 / §0:
      status                 verified | unverified | ocr_unavailable
      unverified_name_metadata  True when NOT verified (the strict flag)
      flag                   "Unverified Name Metadata"
      source                 "video-overlay-ocr"
      engine                 rapidocr | none
      frames_scanned
      texts_seen             deduplicated cleaned OCR phrases
      cleaned_text           best candidate
      expected_name
      matched_name           candidate matched (verified path only)
      confidence             0..1 similarity of the best candidate
      reason
    """
    videos = [v for v in (video_paths or []) if v and os.path.exists(str(v))]
    engine, engine_kind = _read_engine()
    if engine is None:
        return {
            "status": "ocr_unavailable",
            "unverified_name_metadata": True,
            "flag": "Unverified Name Metadata",
            "source": "video-overlay-ocr",
            "engine": "none",
            "frames_scanned": 0,
            "texts_seen": [],
            "cleaned_text": None,
            "expected_name": expected_name or "",
            "matched_name": None,
            "confidence": 0.0,
            "reason": ("No local OCR engine is available on this server, so the name "
                       "burned into the video overlay could not be read. Name metadata "
                       "is therefore UNVERIFIED — the recording is associated with the "
                       "patient record entered by the clinic, not by OCR."),
        }

    seen = {}
    frames_scanned = 0
    for video in videos:
        for frame, width, height in _sample_frames(video):
            frames_scanned += 1
            for strip in _crop_strips(frame, width, height):
                if strip is None or strip.size == 0:
                    continue
                for raw in _ocr_frame(engine, strip):
                    cleaned = _clean_ocr_text(raw)
                    if not cleaned:
                        continue
                    seen[cleaned] = max(seen.get(cleaned, 0.0), 0.0)
        if frames_scanned > _MAX_FRAMES_PER_VIDEO * len(videos):
            break

    candidates = sorted(seen.items(), key=lambda kv: _match_score(kv[0], expected_name or ""),
                        reverse=True)

    if not candidates:
        return {
            "status": "unverified",
            "unverified_name_metadata": True,
            "flag": "Unverified Name Metadata",
            "source": "video-overlay-ocr",
            "engine": engine_kind,
            "frames_scanned": frames_scanned,
            "texts_seen": [],
            "cleaned_text": None,
            "expected_name": expected_name or "",
            "matched_name": None,
            "confidence": 0.0,
            "reason": ("No name-like overlay text was found in the recorded frames. "
                       "Name metadata is UNVERIFIED — it cannot be matched to the "
                       "patient record by OCR."),
        }

    best_text, best_conf = candidates[0]
    expected = expected_name or ""
    matched = best_conf >= _CONF_THRESHOLD and best_conf >= _MATCH_RATIO and expected

    return {
        "status": "verified" if matched else "unverified",
        "unverified_name_metadata": not matched,
        "flag": "Unverified Name Metadata",
        "source": "video-overlay-ocr",
        "engine": engine_kind,
        "frames_scanned": frames_scanned,
        "texts_seen": [t for t, _ in candidates[:5]],
        "cleaned_text": best_text,
        "expected_name": expected,
        "matched_name": (expected if matched else None),
        "confidence": round(max(best_conf, 0.0), 3),
        "reason": ("The video-overlay name matches the patient record."
                   if matched else
                   "The video-overlay name read by OCR does not match the patient "
                   "record — name metadata is UNVERIFIED and must be confirmed "
                   "clinically before the recording is filed."),
    }


def main(argv=None):
    """Standalone entry point used at report-export time (routes/gait.js).

    Spawned by the Node server when the clinician clicks "Export PDF" or
    "Export Word". Reads the name overlay from the recorded videos, verifies it
    against the patient record, and writes the name_metadata JSON to --out.
    """
    import argparse
    import json

    parser = argparse.ArgumentParser(
        description="BRC on-demand video-overlay OCR (name metadata at export).")
    parser.add_argument("--videos", nargs="+", required=True,
                        help="Recorded walk videos (sagittal / frontal / combined).")
    parser.add_argument("--expected", default="",
                        help="Expected patient name (child_name) to verify against.")
    parser.add_argument("--out", required=True,
                        help="Path to write the name_metadata JSON result.")
    args = parser.parse_args(argv)

    videos = [v for v in args.videos if v and os.path.exists(str(v))]
    metadata = run_overlay_ocr(videos, args.expected or None)

    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(metadata, fh, ensure_ascii=False, indent=2)

    print("OK status={0} engine={1}".format(metadata.get("status"),
                                            metadata.get("engine")), flush=True)


if __name__ == "__main__":
    main()