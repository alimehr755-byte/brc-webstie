#!/usr/bin/env python3
"""
check_smplx_setup.py — Verify the SMPL-X model files are present and loadable.

This is the **startup validation gate** for the optional SMPL-X hybrid
refinement stage of the BRC Gait Lab engine. When you are asked (or you want to
enable) SMPL-X-refined joint angles, the engine runs this module's checks first
so that a missing model produces a *clear, human-readable* message instead of a
confusing traceback deep inside an optimization routine.

What this script checks, one item at a time:

  1. That the expected models folder exists
     (gait lab/models/smplx). If the folder is missing, nothing else makes
     sense to check — it is reported immediately.

  2. That each required SMPL-X body-model file is present:
       SMPLX_NEUTRAL.npz   (gender-neutral template)
       SMPLX_MALE.npz      (male template)
       SMPLX_FEMALE.npz    (female template)
     These are the *full body + face + hands* SMPL-X models (NOT SMPL / SMPL+H).
     The `smplx` Python package expects exactly these filenames inside a
     `smplx/` folder.

  3. That each present file is not empty / truncated. We use a basic file-size
     sanity floor (a real SMPL-X archive is several megabytes; a partially
     downloaded placeholder will almost always be far smaller). This does not
     replace the real load test in step 5, it only catches the obvious cases
     cheaply.

  4. That the two Python packages the fitting stage needs are installed:
       smplx      (parametric human body model loader / forward model)
       torch      (autograd optimizer used to fit the body to the 2D keypoints)
     We use `importlib.util.find_spec` here, which is *cheap* — it does NOT
     actually import torch (which can take seconds on some machines). The real
     import only happens in step 5 where it is required.

  5. That the models actually LOAD. `smplx.create(...)` parses the .npz file,
     rebuilds joint regressors and tetra-weights, and returns a Python object.
     This is the definitive test that a file is not corrupt. Errors are mapped
     to a human-readable explanation of what likely went wrong and how to fix
     it (e.g. truncated file -> re-download).

When run as a script it prints a labelled ✅/❌ result for every check, a final
summary with a numbered, actionable fix list, and exits with a non-zero status
code if anything failed — so it can be wired into CI or a startup gate.

The checks are also exposed as `run_checks()`, returning a small dict, so the
analysis engine can reuse exactly the same validation without spawning a
subprocess.
"""

import importlib.util
import os
import sys


# ---------------------------------------------------------------------------
# Paths — resolved relative to THIS file so the script works no matter which
# directory you run it from (the folder name contains a space, so we take care
# to use os.path.join rather than hand-built strings).
# ---------------------------------------------------------------------------
_HERE = os.path.dirname(os.path.abspath(__file__))
# smplx.create(model_path=...) expects the folder that CONTAINS the `smplx/`
# subfolder. The raw .npz archives live inside that subfolder.
MODEL_PATH = os.path.join(_HERE, "models")           # parent = 'gait lab/models'
MODEL_DIR = os.path.join(MODEL_PATH, "smplx")        # files = 'gait lab/models/smplx'

# The exact filenames the smplx package requires, and a rough minimum size.
# A real SMPL-X .npz is ~several MB; anything far below 500 KB is almost
# certainly a placeholder, a corrupt file, or a partially downloaded copy.
REQUIRED_FILES = [
    ("SMPLX_NEUTRAL.npz", 500 * 1024),
    ("SMPLX_MALE.npz", 500 * 1024),
    ("SMPLX_FEMALE.npz", 500 * 1024),
]


def _folder_ok():
    """Check 1: does the models/smplx folder exist at all?"""
    return os.path.isdir(MODEL_DIR)


def _file_checks():
    """Checks 2-3: presence + size sanity for every required .npz file."""
    out = []  # list of (name, ok, detail)
    for fname, floor in REQUIRED_FILES:
        path = os.path.join(MODEL_DIR, fname)
        if not os.path.isfile(path):
            out.append((fname, False, "NOT FOUND"))
            continue
        try:
            size = os.path.getsize(path)
        except OSError as exc:
            out.append((fname, False, "unreadable: %s" % exc))
            continue
        if size <= 0:
            out.append((fname, False, "EMPTY FILE (0 bytes)"))
        elif size < floor:
            out.append((fname, False,
                        "suspiciously small (%d bytes < %d byte floor) — "
                        "likely truncated or a placeholder" % (size, floor)))
        else:
            out.append((fname, True, "present, %d bytes" % size))
    return out


def _pkg_available(name):
    """Cheap availability probe for a Python package (no heavy import)."""
    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, ValueError):
        return False


def _try_load_models(present_files):
    """Check 5: actually load each present model with the smplx package.

    Returns (loaded_names, errors) where loaded_names is the list of genders
    that loaded cleanly and errors is a list of human-readable strings.
    """
    loaded, errors = [], []
    try:
        # Only import the real package here; by this point we know the files
        # exist, so the seconds this costs are not wasted on a broken setup.
        import torch  # noqa: F401  (required by smplx)
        import smplx  # noqa: F401
    except Exception as exc:
        errors.append(
            "The smplx/torch packages could not be imported (%s). "
            "Run: pip install torch --index-url https://download.pytorch.org/whl/cpu "
            "then: pip install smplx" % exc)
        return loaded, errors

    for fname in present_files:
        # Map the archive filename to the gender token smplx.create expects.
        gender = {"SMPLX_NEUTRAL.npz": "neutral",
                  "SMPLX_MALE.npz": "male",
                  "SMPLX_FEMALE.npz": "female"}.get(fname)
        if gender is None:
            continue
        try:
            model = smplx.create(
                model_path=MODEL_PATH,          # parent dir containing smplx/
                model_type="smplx",             # full body+face+hands, not SMPL
                gender=gender,
                ext="npz",
                use_pca=True,
                num_pca_comps=12,
            )
            _ = model()  # force a forward pass so latent load problems surface
            loaded.append(gender)
        except FileNotFoundError:
            errors.append(
                "smplx could not find %s inside %s — re-download from the "
                "SMPL-X website's Downloads section and place it there." %
                (fname, MODEL_DIR))
        except Exception as exc:
            errors.append(
                "smplx could not load %s (%s). The file is likely corrupt or "
                "truncated — re-download it from the SMPL-X website and replace "
                "the copy in %s." % (fname, exc, MODEL_DIR))
    return loaded, errors


def run_checks():
    """Run every check and return a machine-readable summary dict.

    Returns:
        {
          "ok": bool,                 # True iff every requirement is satisfied
          "model_dir": str,           # absolute path to models/smplx
          "model_path": str,          # parent dir passed to smplx.create()
          "results": [{name, ok, detail}, ...],   # per-check ledger
          "loaded": [gender, ...],    # genders that loaded via smplx.create()
          "missing": [filename, ...], # required files that are absent
          "fixes": [str, ...],        # numbered, actionable instructions
        }

    The engine's graceful gate calls this for availability; the CLI prints it.
    """
    results = []      # per-check ledger {name, ok, detail}
    fixes = []        # actionable instructions, numbered at print time
    missing = []      # absent required file names

    # --- 1. folder exists --------------------------------------------------
    if not _folder_ok():
        results.append({"name": "models/smplx folder", "ok": False,
                        "detail": "NOT FOUND — expected %s" % MODEL_DIR})
        fixes.append("Create the folder %s (fetch the files as described in "
                     "SETUP_SMPLX.md)." % MODEL_DIR)
        return {"ok": False, "model_dir": MODEL_DIR, "model_path": MODEL_PATH,
                "results": results, "loaded": [], "missing": missing,
                "fixes": fixes}

    results.append({"name": "models/smplx folder", "ok": True,
                    "detail": "found (%s)" % MODEL_DIR})

    # --- 2 + 3. per-file presence + size sanity -----------------------------
    file_results = _file_checks()
    for fname, ok, detail in file_results:
        if not ok and fname.startswith("SMPLX"):
            missing.append(fname)
    present_files = [fname for fname, ok, _ in file_results if ok]
    for fname, ok, detail in file_results:
        results.append({"name": fname, "ok": ok, "detail": detail})
        if not ok:
            fixes.append("Missing/invalid %s — re-download from the SMPL-X "
                         "website's Downloads section and place it in %s." %
                         (fname, MODEL_DIR))

    # --- 4. python packages (cheap find_spec probes) ------------------------
    for pkg in ("smplx", "torch"):
        ok = _pkg_available(pkg)
        results.append({"name": "package: %s" % pkg, "ok": ok,
                        "detail": "installed" if ok else "NOT installed"})
        if not ok and present_files:
            fixes.append("Install %s: pip install %s%s" % (
                pkg,
                pkg,
                " --index-url https://download.pytorch.org/whl/cpu"
                if pkg == "torch" else ""))

    # --- 5. real load (only meaningful once files + packages exist) ----------
    if present_files and file_results:
        loaded, load_errors = _try_load_models(present_files)
        for gender in loaded:
            results.append({"name": "load: SMPL-X %s" % gender, "ok": True,
                            "detail": "smplx.create(...) loaded and ran a "
                                      "forward pass"})
        for err in load_errors:
            results.append({"name": "model load", "ok": False, "detail": err})
            fixes.append(err)
    elif present_files:
        results.append({"name": "model load", "ok": True,
                        "detail": "skipped (no model files to load)"})

    ok = all(r["ok"] for r in results)
    return {"ok": ok, "model_dir": MODEL_DIR, "model_path": MODEL_PATH,
            "results": results, "loaded": {
                r["name"].replace("load: SMPL-X ", "")
                for r in results if r["name"].startswith("load: SMPL-X") and r["ok"]
            },
            "missing": missing, "fixes": fixes}


def _print_header():
    """Friendly, explanatory banner so the operator knows what is happening
    and why before any check runs."""
    print("=" * 76)
    print("SMPL-X SETUP CHECKER — BRC Gait Lab hybrid refinement gate")
    print("=" * 76)
    print("")
    print("This verifies the manually-downloaded SMPL-X body models are in")
    print("place and loadable, plus the smplx/torch Python packages, so the")
    print("optional MediaPipe + SMPL-X refinement stage can run.")
    print("")
    print("Model folder : %s" % MODEL_DIR)
    print("smplx path   : %s (folder that contains smplx/)" % MODEL_PATH)
    print("")


def main():
    """CLI entry point: print the header, every check, a numbered fix list,
    and exit non-zero if anything failed (so it gates startup/CI)."""
    _print_header()

    summary = run_checks()

    passed = sum(1 for r in summary["results"] if r["ok"])
    failed = len(summary["results"]) - passed
    for r in summary["results"]:
        mark = "ok" if r["ok"] else "FAIL"
        print("  [%s] %s -- %s" % (mark, r["name"], r["detail"]))

    print("")
    print("-" * 76)
    print("Summary: %d passed, %d failed" % (passed, failed))
    print("-" * 76)
    if summary["ok"]:
        # Grade the depth of readiness so the operator knows exactly how much
        # refinement will actually be active once analysis runs.
        n_loaded = len(summary["loaded"])
        if n_loaded >= 1:
            print("  All checks passed — SMPL-X hybrid refinement is ready to run.")
        else:
            print("  All checks passed, but no model could be loaded — the gate")
            print("  will keep the refinement stage disabled.")
    else:
        print("  The following MUST be fixed before SMPL-X refinement can run:")
        for i, fix in enumerate(summary["fixes"], 1):
            print("    %d. %s" % (i, fix))
        print("")
        print("  The engine is designed to DEGRADE GRACEFULLY: until this is")
        print("  resolved it continues with MediaPipe-only analysis.")
        # Non-zero exit so scripts / CI / the startup gate can detect failure.
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())