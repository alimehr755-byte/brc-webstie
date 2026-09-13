"""2e.txt — gait-validity pre-screening gate.

Before ANY full kinematic processing (MediaPipe / Pose2Sim) is allowed to run,
the uploaded recording must pass a strict heuristic screen proving a genuine,
cyclic human walking (gait) pattern is present:

  1. A detectable, upright human pose is tracked in a majority of sampled frames.
  2. The limbs (sagittal view: knee flexion) or pelvis (frontal view: vertical
     bob) show rhythmic oscillation with a dominant component inside a plausible
     walking-cadence band (~0.35-2.2 Hz) and physically meaningful amplitude.
  3. The oscillation repeats periodically (phase-locked cadence across the clip)
     across at least 3 full cycles.

Any failure returns status="rejected" with a plain-language reason. The calling
pipeline MUST then block kinematic processing and MUST NOT fabricate metrics.

This module is deliberately dependency-light: cv2 + numpy + MediaPipe only, so
the upload-time probe can import it without pulling in matplotlib / gait_analyzer.
"""

import math
import os

import numpy as np
import cv2

# Exact wording required by 2e.txt for user-facing rejection notices.
NO_VALID_GAIT_MSG = (
    "The uploaded video does not contain a recognizable walking (gait) pattern. "
    "Please upload a clear video of the patient walking straight in the specified "
    "plane to proceed with the clinical analysis."
)

L_INDEX = dict(ear=7, shoulder=11, elbow=13, wrist=15, hip=23, knee=25, ankle=27, foot=31, toe=29)
R_INDEX = dict(ear=8, shoulder=12, elbow=14, wrist=16, hip=24, knee=26, ankle=28, foot=32, toe=30)
SIDES = {"L": L_INDEX, "R": R_INDEX}

# Cadence band (Hz) for a walking stride/gait cycle, real-time. Slow-walking
# ~0.4 Hz up to a brisk jog ~2.0 Hz; faster bursts are jumping/random motion,
# slower is static.
CADENCE_LO, CADENCE_HI = 0.35, 2.2
MIN_FULL_CYCLES = 3.0        # at least 3 stride cycles must be present
MIN_PERIODICITY = 0.5        # min phase-regularity (mean resultant length) of the cadence
MIN_TRACKED_FRACTION = 0.50  # fraction of sampled frames with an upright pose

# Sampling budget shared by the gait-validity screen AND the kinematic analyzer.
# target_eff keeps the effective sampling rate at ~5 Hz so the Nyquist fold-over
# (2.5 Hz) stays above the cadence band top (2.2 Hz). max_samples bounds the
# number of MediaPipe pose calls per video regardless of clip length — for clips
# longer than max_samples/target_eff seconds the sampler uses a contiguous
# middle window (see bounded_frame_plan) instead of the whole clip, so runtime
# no longer scales linearly with recording length.
TARGET_EFF = 5.0
MAX_SAMPLES = 150

# ---- playback-speed awareness -------------------------------------------------
# Gait is analyzed from the *video* clock, but cadence/cycle timing is only
# clinical if expressed in *real* time. A clip filmed in slow motion (or sped up)
# shifts the measured stride frequency out of the human band without changing the
# underlying movement. We therefore find the video fundamental stride frequency
# anywhere in [PY_SLOW, PY_FAST] and re-interpret it as the nearest plausible
# real-time cadence when it falls clearly outside the human band.
PY_SLOW = 0.03                 # lowest frequency ever worth calling walking
PY_FAST = 3.2                  # highest frequency scanned (walk FF or running)
SLOW_THRESH = 0.34             # below CADENCE_LO -> may be slow-motion
FAST_THRESH = 1.75             # above brisk real jog -> may be fast-forwarded or running
REAL_CADENCE_MIN, REAL_CADENCE_MAX = 0.7, 1.7   # plausible real-time WALKING-cycle band
HUMAN_TARGET = 1.2             # preferred real-time gait-cycle rate used to resolve k

# Running vs walking. Physiologically running differs from walking by a double-
# float (flight) phase where neither foot is on the ground AND by a shorter,
# faster stride CYCLE. The measured frequency is STRIDE-CYCLES/second (one full
# cycle per knee-flexion period), whose real-time value is ~1.4-1.6 Hz for an
# average run — i.e. it OVERLAPS the walking band (0.35-2.2). Cadence alone can
# therefore NOT separate running from brisk walking; the flight phase (or the
# clinician's "Running" hint) is the reliable disambiguator, exactly as user.txt
# Option 4 states ("flight phase + high frequency -> Running").
RUNNING_LO = 1.2               # conservative low bound on real run cycle rate (Hz)
RUNNING_MAX = 2.3              # upper bound on a real run cycle rate (Hz, sprint)
FAST_FWD_LO = 2.2              # no flight + video cadence > this -> fast-forwarded walk

# Flight-phase detection: the fraction of the body height one foot must clear
# above its resting (support) position to count as "off the ground".
FLIGHT_ELEV_FRAC = 0.08        # ankle-lift ~>=8% of hip->ankle height
MIN_FLIGHT_FRAC = 0.10         # >=10% of sampled frames double-float -> running
                               # (walking measures ~0; a real run measures ~12%+)
SLOW_K = (1.5, 2.0, 2.5, 3.0, 3.333, 4.0, 5.0, 6.0, 8.0, 10.0, 12.0, 15.0, 16.0, 20.0)
FAST_K = (0.8, 0.667, 0.5, 0.4, 0.333, 0.25)


def _resolve_playback(f0):
    """Return (speed_k, real_cadence_hz) mapping a video-frequency stride rate.

    speed_k is *real seconds per video second*: k=1 real-time, k>1 slow-motion
    (the video is k× slower than life), k<1 fast-forward. Returns None when the
    measurement can't be reconciled with a human cadence.

    NOTE: This resolves frequency into the WALKING band only. Running detection
    is handled separately in ``resolve_cadence`` (flight-phase + hint aware),
    since a run cadence must not be mistaken for a fast-forwarded walk.
    """
    if SLOW_THRESH <= f0 <= FAST_FWD_LO:
        # Already inside (or adjacent to) the human band — treat as real-time.
        # A genuinely slow pathological walk reports its true low cadence; only
        # clearly out-of-band frequencies are reinterpreted as playback speed.
        return 1.0, f0
    candidates = SLOW_K if f0 < SLOW_THRESH else FAST_K
    best = None
    for k in candidates:
        real = f0 * k
        if REAL_CADENCE_MIN <= real <= REAL_CADENCE_MAX:
            if best is None or abs(real - HUMAN_TARGET) < abs(best[1] - HUMAN_TARGET):
                best = (k, real)
    return best


def _hint_expected_speed(hint):
    """Map a UI speed-hint to an expected speed_k (real s per video s), else None."""
    if hint == "normal":
        return 1.0
    if hint == "slowmo_120":
        return 4.0            # 120 fps clip replayed ~24-30 fps -> ~4-5x slow; pick 4x
    if hint == "slowmo_240":
        return 8.0            # 240 fps -> ~8x slow
    if hint == "running":
        return 1.0            # running is real-time gait, just fast
    return None               # "auto" or unknown -> fully automatic


def _resolve_running(f0, speed_k_hint):
    """Resolve (speed_k, real_cadence) treating a high-frequency signal as RUNNING.

    Running has a genuine real-time cadence (cycle rate) that can run as high as
    ~3.2 Hz, so it must NOT be scaled down into the walking band. If a slow-mo
    speed is already implied (hint or sub-band f0) we scale up accordingly.
    """
    if speed_k_hint is not None and speed_k_hint > 1.0:
        real = f0 * speed_k_hint
        if RUNNING_LO <= real <= RUNNING_MAX:
            return speed_k_hint, real
    for k in (1.0, 1.5, 2.0, 2.5, 3.0, 4.0):
        real = f0 * k
        if RUNNING_LO <= real <= RUNNING_MAX:
            return k, real
    return None


def resolve_cadence(f0, speed_hint="auto", flight_frac=0.0):
    """Decide playback speed and running status for a measured stride frequency.

    Returns a dict with keys:
      speed_k       real seconds per video second (1.0 real time)
      cadence_real  real-time cadence in Hz
      running       True when the motion is classified as running (not walking)
      via           short explanation of the decision path

    This is the single place where running is distinguished from a fast-forwarded
    walk (user.txt Option 4). A real-time running cadence overlaps the walking
    band, so the POINT of the classifier is the double-float flight phase (or the
    clinician's "Running" hint), NOT the frequency. The clinician's explicit
    "Normal" hint is treated as ground truth and suppresses auto-running.
    """
    hint_running = (speed_hint == "running")
    hint_speed = _hint_expected_speed(speed_hint)
    flight = flight_frac is not None and flight_frac >= MIN_FLIGHT_FRAC

    # Running is flagged when the clinician selects Running, or — for the auto /
    # slow-motion paths — when a flight phase is objectively measured. An explicit
    # "Normal" hint wins: the user has stated this is a real-time walk, so the
    # (noisy) flight signal is not allowed to relabel it as a run.
    is_run = hint_running or (speed_hint != "normal" and flight)

    if is_run:
        # Real-time (or slow-mo-hinted) run whose cadence is a plausible running
        # cycle rate: report it at real cadence, preserving slow-motion scaling
        # only when the hint/speed implies one. Don't up-shift in-band runs.
        base = f0 * (hint_speed if (hint_speed is not None and hint_speed > 1.0) else 1.0)
        if RUNNING_LO <= base <= RUNNING_MAX:
            return {"speed_k": (hint_speed if hint_speed and hint_speed > 1.0 else 1.0),
                    "cadence_real": base, "running": True,
                    "via": "running (flight phase)" if flight else "running (clinician hint)"}
        # Flight but cadence not in the run cycle band: try a slow-motion scale to
        # pull a slow-mo run back to a plausible real cadence.
        r = _resolve_running(f0, hint_speed)
        if r is not None:
            return {"speed_k": r[0], "cadence_real": r[1], "running": True,
                    "via": "running (slow-motion scale)"}
        if f0 < SLOW_THRESH and hint_speed and hint_speed > 1.0:
            real = f0 * hint_speed
            if REAL_CADENCE_MIN <= real <= REAL_CADENCE_MAX:
                return {"speed_k": hint_speed, "cadence_real": real, "running": True,
                        "via": "slow-motion running (hint)"}

    # Walking (incl. a fast-forwarded walk). No run, so a clearly high video
    # cadence re-anchors as a fast-forwarded walk; anything in/near the human
    # band is a real-time walk. The clinician's slow-motion hint is ground truth
    # (user.txt Option 4) and wins over automatic frequency scaling whenever it
    # lands in the plausible real-time walking band.
    if hint_speed is not None and hint_speed > 1.0:
        real = f0 * hint_speed
        if REAL_CADENCE_MIN <= real <= REAL_CADENCE_MAX:
            return {"speed_k": hint_speed, "cadence_real": real, "running": False,
                    "via": "playback scale (clinician hint)"}
    resolved = _resolve_playback(f0)
    if resolved is not None:
        return {"speed_k": resolved[0], "cadence_real": resolved[1], "running": False,
                "via": "fast-forwarded walk" if f0 > FAST_THRESH else "playback scale"}
    return None


def _make_pose_runner():
    """Return (run, closer) using the Tasks-vision PoseLandmarker model.

    MediaPipe's legacy ``solutions.pose`` API was removed in mediapipe >= 0.10.14,
    so the Tasks-vision PoseLandmarker backed by ``pose_landmarker_full.task`` is
    the single supported inference path.
    """
    import mediapipe as mp
    from mediapipe.tasks import python as mp_python
    BaseOptions = mp_python.BaseOptions
    PoseLandmarker = mp_python.vision.PoseLandmarker
    Options = mp_python.vision.PoseLandmarkerOptions
    RunningMode = mp_python.vision.RunningMode
    model = os.environ.get(
        "POSE_LANDMARKER_MODEL",
        os.path.join(os.path.dirname(__file__), "..", "gait lab", "pose_landmarker_full.task"),
    )
    landmarker = PoseLandmarker.create_from_options(Options(
        base_options=BaseOptions(model_asset_path=model),
        running_mode=RunningMode.VIDEO,
    ))
    state = {"fc": 0}

    def run(rgb):
        ts = int(state["fc"] * 33)
        state["fc"] += 1
        img = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
        res = landmarker.detect_for_video(img, ts)
        return res.pose_landmarks[0] if (res.pose_landmarks and len(res.pose_landmarks) > 0) else None

    return run, landmarker


def _landmark_pts(lm, idx_map, width, height, vis_min=0.35):
    pts = {}
    for key, idx in idx_map.items():
        l = lm[idx]
        vis = getattr(l, "visibility", getattr(l, "presence", 1.0))
        if vis > vis_min:
            pts[key] = (float(l.x) * width, float(l.y) * height)
    return pts


def _landmark_vis(lm, idx_map):
    """Per-keypoint raw visibility (0-1) map — powers the run.txt §5 confidence gate."""
    vis = {}
    for key, idx in idx_map.items():
        l = lm[idx]
        vis[key] = float(getattr(l, "visibility", getattr(l, "presence", 1.0)))
    return vis


def _three_point_angle(a, b, c):
    a = np.array(a, dtype=float)
    b = np.array(b, dtype=float)
    c = np.array(c, dtype=float)
    ba, bc = a - b, c - b
    denom = np.linalg.norm(ba) * np.linalg.norm(bc) + 1e-9
    return float(np.degrees(np.arccos(np.clip(np.dot(ba, bc) / denom, -1.0, 1.0))))


def _lean_from_vertical(bottom, top):
    dx = float(top[0] - bottom[0])
    dy = float(top[1] - bottom[1])
    if abs(dy) < 1e-6:
        return 0.0
    return float(np.degrees(np.arctan2(dx, -dy)))


def _reject(reason, explanation):
    return {
        "status": "rejected",
        "reason": reason,
        "explanation": explanation,
        "message": NO_VALID_GAIT_MSG if reason != "error" else explanation,
    }


def _flight_phase_fraction(low_foot_y, sample_hgt):
    """Fraction of sampled frames where BOTH feet are clearly off the ground.

    ``low_foot_y`` = per-side lowest foot pixel-y per frame; ``sample_hgt`` = the
    hip->ankle height in pixels per frame (camera scale reference). For each side
    the ground reference is that foot's minimum low-point across the whole clip
    (lowest it ever reaches = fully planted). A frame is "double-float" (running
    flight phase) when both feet are simultaneously lifted well above their ground
    references. Returns 0.0 when the signal is unusable.
    """
    L = np.asarray(low_foot_y.get("L", []), dtype=float)
    R = np.asarray(low_foot_y.get("R", []), dtype=float)
    n = max(len(L), len(R))
    if n < 8:
        return 0.0
    hgt = np.asarray(sample_hgt, dtype=float)
    med_h = float(np.nanmedian(hgt)) if np.isfinite(hgt).sum() else 0.0
    if med_h <= 1e-6:
        return 0.0
    n = min(len(L), len(R), len(hgt))
    if n < 8:
        return 0.0
    Lv, Rv = L[:n], R[:n]
    groundL = np.nanmedian(Lv) + 0.3 * (np.nanpercentile(Lv, 90) - np.nanpercentile(Lv, 10))
    groundR = np.nanmedian(Rv) + 0.3 * (np.nanpercentile(Rv, 90) - np.nanpercentile(Rv, 10))
    liftL = (groundL - Lv) / med_h
    liftR = (groundR - Rv) / med_h
    both = np.isfinite(liftL) & np.isfinite(liftR)
    if both.sum() < max(6, 0.3 * n):
        return 0.0
    f = float(np.mean((liftL[both] >= FLIGHT_ELEV_FRAC) & (liftR[both] >= FLIGHT_ELEV_FRAC)))
    return round(max(0.0, min(1.0, f)), 4)


# Per-video landmark cache shared with gait_lab so the full kinematic analysis
# reuses the screening pass's MediaPipe results instead of reinferring the same
# frames. Keyed by absolute frame index -> {"pts": {"L": {...}, "R": {...}},
# "vis": {"L": {joint: visibility}, "R": {...}}}.
POSE_CACHE = {}


def cached_pts(video_path, abs_frame):
    """Return cached per-side landmark pts for ``abs_frame`` or None."""
    return POSE_CACHE.get(os.path.abspath(video_path), {}).get(abs_frame, {}).get("pts")


def cached_vis(video_path, abs_frame):
    """Return cached per-keypoint visibility map for ``abs_frame`` or None.

    Powers the run.txt §5 per-parameter confidence gate in gait_lab.py.
    """
    return POSE_CACHE.get(os.path.abspath(video_path), {}).get(abs_frame, {}).get("vis")


def bounded_frame_plan(video_path, max_samples=None, target_eff=None, fps=None, total=None):
    """Shared (step, start, count) sampling plan for the screen + analyzer.

    The analyzer reuses the screen's MediaPipe landmarks via POSE_CACHE, so both
    passes MUST sample the same absolute frames. Cadence resolution sets a floor
    on the sampling rate (≈ target_eff, so Nyquist stays above the 2.2 Hz cadence
    top); the pose budget sets a cap on MediaPipe calls (max_samples).

    For clips longer than max_samples/target_eff seconds, sampling the whole clip
    would either blow the pose budget or alias the cadence band, so we sample a
    CONTIGUOUS MIDDLE WINDOW instead — steady walking content, full cadence
    resolution, bounded cost. Short clips are sampled in full from frame 0.
    """
    if fps is None or total is None:
        cap = cv2.VideoCapture(video_path)
        try:
            fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
            total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        finally:
            cap.release()
    max_samples = max_samples or MAX_SAMPLES
    target_eff = target_eff or TARGET_EFF
    step = max(1, int(round(fps / target_eff)))
    if total <= 0:
        return {"step": step, "start": 0, "count": max_samples}
    window = min(total, step * max_samples)
    start = max(0, (total - window) // 2)
    count = min(max_samples, int(math.ceil(window / step)))
    return {"step": step, "start": start, "count": count}


def _score_rhythm(series, eff_fps, plane, speed_hint="auto", flight_frac=0.0):
    """Score a limb/pelvic rhythm time series for genuine walking periodicity."""
    x = np.asarray(series, dtype=float)
    n = len(x)
    if n < 12 or eff_fps <= 0:
        return _reject("too_short", "The clip is too short to establish a walking rhythm.")
    valid = np.isfinite(x)
    if valid.sum() < max(6, 0.30 * n):
        return _reject("no_human_track", "A human figure could not be tracked consistently across the clip.")

    filled = np.copy(x)
    idx = np.arange(n)
    if valid.sum() >= 2:
        filled[~valid] = np.interp(idx[~valid], idx[valid], x[valid])
    filled = filled - float(np.mean(filled))
    # Detrend linear drift (walking toward/away from camera rescales the body).
    try:
        slope, intercept = np.polyfit(idx, filled, 1)
        filled = filled - (slope * idx + intercept)
    except Exception:
        pass

    std = float(np.std(filled))
    pct = float(np.percentile(filled, 90) - np.percentile(filled, 10))

    # Physically meaningful movement floor: knee flexion during swing is tens of
    # degrees; frontal pelvic bob is a few % of body height.
    amp_floor = 5.0 if plane != "frontal" else 0.004
    if std < amp_floor * 0.5 and pct < (amp_floor * 0.5 * 2.0):
        return _reject("static_or_slow",
                       "No rhythmic limb or pelvic motion — subject appears stationary, sitting, or standing still.")

    # Dominant stride frequency anywhere in the scan band, then re-anchor its
    # periodicity analysis and cadence reporting to real time.
    freqs = np.fft.rfftfreq(n, 1.0 / eff_fps)
    sig_fft = np.fft.rfft(filled)
    power = np.abs(sig_fft) ** 2
    total = float(power.sum()) + 1e-12

    def _windowed_power(power, freqs, fc, half=0.10):
        w = (freqs >= (fc - half)) & (freqs <= (fc + half))
        return float(power[w].sum())

    nyquist = eff_fps / 2.0
    if nyquist <= PY_SLOW:
        return _reject("no_walking_cadence", "Clip sampling rate is too low to resolve a gait cadence.")

    # 1) Prefer a fundamental that already lands in the human WALKING cadence band
    #    — a normal-speed walking recording reports that frequency directly. Band
    #    power sums the stride fundamental AND its harmonics inside the band.
    in_band = (freqs >= CADENCE_LO) & (freqs <= min(CADENCE_HI, nyquist))
    if in_band.any():
        fb = float(freqs[in_band][int(np.argmax(power[in_band]))])
        band_power = float(power[in_band].sum())
        if (band_power / total) >= 0.25:
            f0 = fb
        else:
            f0 = None
    else:
        f0 = None

    # 2) No clean in-band fundamental: the rhythm may sit below the human band
    #    (slow-motion clip), above it (fast-forwarded clip), or in the running
    #    band. Resolve cadence in a running-aware way (flight phase + clinician
    #    hint decide whether a high cadence is RUNNING vs a FAST-FORWARDED WALK).
    running = False
    resolution = None
    if f0 is not None:
        # In-band frequency: real-time walking unless the clinician/flight says run.
        if speed_hint == "running" or (flight_frac or 0.0) >= MIN_FLIGHT_FRAC:
            resolution = resolve_cadence(f0, speed_hint, flight_frac)
        if resolution is None:
            resolution = {"speed_k": 1.0, "cadence_real": f0, "running": False,
                          "via": "real-time walking"}
    else:
        lo_scan = (freqs >= PY_SLOW) & (freqs < CADENCE_LO)
        hi_scan = (freqs > min(CADENCE_HI, nyquist)) & (freqs <= min(PY_FAST, nyquist))
        lo_pow = float(power[lo_scan].sum())
        hi_pow = float(power[hi_scan].sum())
        if not lo_scan.any() and not hi_scan.any():
            return _reject("no_walking_cadence", "No oscillation in a human walking-cadence range was found.")
        use_lo = lo_pow >= hi_pow
        scan = (freqs >= PY_SLOW) & (freqs < CADENCE_LO) if use_lo else \
               (freqs > min(CADENCE_HI, nyquist)) & (freqs <= min(PY_FAST, nyquist))
        if not scan.any():
            return _reject("no_walking_cadence", "No oscillation in a human walking-cadence range was found.")
        f0 = float(freqs[scan][int(np.argmax(power[scan]))])
        band_power = _windowed_power(power, freqs, f0)
        if (band_power / total) < 0.30:
            return _reject("no_walking_cadence",
                           "Motion energy is spread outside a human walking cadence (likely jumping, fidgeting, or scenery).")
        resolution = resolve_cadence(f0, speed_hint, flight_frac)
        if resolution is None:
            return _reject("no_walking_cadence",
                           "The detected oscillation maps to no plausible human walking or running cadence "
                           "(extremely slow drift, scenery, or a stationary figure).")

    speed_k = float(resolution["speed_k"])
    real_cadence = float(resolution["cadence_real"])
    running = bool(resolution.get("running", False))

    cycles = n * f0 / eff_fps
    if cycles < MIN_FULL_CYCLES:
        return _reject("too_few_cycles",
                       "Fewer than {0} full stride cycles appear in the clip — not enough walking rhythm to analyze.".format(int(MIN_FULL_CYCLES)))

    # Band-pass the signal around the stride fundamental before measuring rhythm
    # regularity: this strips slow drift and high-freq jitter that would mask a
    # genuine but unsteady walk (e.g. a child's gait or a slow-motion clip).
    lo = max(0.02, f0 * 0.55)
    hi = min(nyquist, f0 * 1.8)
    mask = np.zeros_like(freqs, dtype=float)
    mask[(freqs >= lo) & (freqs <= hi)] = 1.0
    bp = np.real(np.fft.irfft(sig_fft * mask, n=n))
    std_bp = float(np.std(bp))
    if std_bp < 1e-9:
        return _reject("no_walking_cadence", "No oscillation in a human walking-cadence range was found.")

    # Rhythm regularity from the analytic-signal phase: amplitude-correlation is
    # too sensitive to landmark jitter, but a genuine stride produces a steady
    # phase advance. Mean resultant length R of the phase increments vs the
    # expected advance is ~0.7+ for a real rhythm and ~0 for random motion.
    X = np.fft.fft(bp)
    h = np.zeros(n)
    h[0] = h[n // 2] = 1.0
    h[1:(n + 1) // 2] = 2.0
    analytic = np.fft.ifft(X * h)
    phase = np.unwrap(np.angle(analytic))
    dphi = np.diff(phase)
    mu = 2.0 * np.pi * f0 / eff_fps
    periodic = float(np.abs(np.exp(1j * (dphi - mu)).mean()))
    if periodic < MIN_PERIODICITY:
        return _reject("not_cyclic",
                       "Body motion is not repeating in a steady cyclic pattern (standing, sitting, jumping, or random clip).")

    label = ("real time" if speed_k == 1.0 else
             "slow motion (×{0:g})" if speed_k > 1.0 else
             "fast-forward (×{0:g})".format(1.0 / speed_k))
    if running:
        label = "running (real time)" if speed_k == 1.0 else "running / slow motion (×{0:g})".format(speed_k)
    kind = "running" if running else "walking"
    return {
        "status": "ok",
        "reason": None,
        "explanation": "Genuine cyclic {0} rhythm confirmed ({1}); cadence normalized to real time.".format(kind, label),
        "message": "",
        "std": round(std, 3),
        "p90_p10": round(pct, 3),
        "dominant_freq_hz": round(f0, 3),
        "playback_speed": speed_k,
        "cadence_real_hz": round(real_cadence, 3),
        "running": running,
        "approx_cycles": round(cycles, 1),
        "periodicity": round(periodic, 3),
    }


def screen_gait_validity(video_path, plane="sagittal", speed_hint="auto",
                         step=None, start=0, count=None):
    """Pre-screen a recording for a genuine walking pattern.

    ``speed_hint`` is the clinician's playback-speed selection (ground truth):
    "auto", "normal", "running", "slowmo_120" or "slowmo_240". It overrides /
    disambiguates the automated frequency measurement (user.txt Option 4).

    ``step`` / ``start`` / ``count`` come from ``bounded_frame_plan``: the screen
    samples the same absolute frames the kinematic pass will reuse (see
    POSE_CACHE / cached_pts), so long clips are assessed on a contiguous middle
    window (bounded pose cost) rather than the whole recording.

    Returns a dict: {status: 'ok'|'rejected', reason, explanation, message,
                     evidence: {...}}. When status != 'ok' the analysis pipeline
    must be blocked (2e.txt) and NO metrics may be produced.
    """
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        return _reject("error", "Could not open the video for gait-validity screening.")

    try:
        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)) or 640
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)) or 480
        fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
        if step is None:
            plan = bounded_frame_plan(video_path, fps=fps,
                                      total=int(cap.get(cv2.CAP_PROP_FRAME_COUNT)))
            step, start, count = plan["step"], plan["start"], plan["count"]
        count = count or MAX_SAMPLES
        # Stay inside the clip when the window plan overruns a short recording.
        total = max(0, int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) - start)
        eff_fps = max(1.0, fps / step)

        knee_sig = {"L": [], "R": []}
        pelvis_y = []
        pelvis_x = []
        trunk = []
        body_h_smpl = []
        # Flight-phase collection: one ankle/foot vertical position per side per
        # sampled frame, used to detect a double-float (running) signature.
        low_foot_y = {"L": [], "R": []}
        sample_hgt = []

        runner, closer = _make_pose_runner()
        n_samples = 0
        frame_idx = 0
        try:
            # One seek to the window start, then a sequential read — random
            # per-frame seeks are catastrophic on some 720p codecs (0.9s/seek);
            # sequential read is instant.
            cap.set(cv2.CAP_PROP_POS_FRAMES, start)
            while True:
                ok, frame = cap.read()
                if not ok:
                    break
                if frame_idx % step == 0:
                    sidx = start + frame_idx
                    rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                    # Landmarks are normalized 0-1, so downscaling is lossless for
                    # scoring and keeps Helix CPU inference cheap on HD uploads.
                    if max(rgb.shape[:2]) > 480:
                        s = 480.0 / max(rgb.shape[:2])
                        rgb = cv2.resize(rgb, (int(rgb.shape[1] * s), int(rgb.shape[0] * s)),
                                         interpolation=cv2.INTER_AREA)
                    lm = runner(rgb)
                    pts = {"L": {}, "R": {}}
                    vis = {"L": {}, "R": {}}
                    if lm is not None:
                        for s, imap in SIDES.items():
                            pts[s] = _landmark_pts(lm, imap, width, height)
                            vis[s] = _landmark_vis(lm, imap)
                    POSE_CACHE.setdefault(os.path.abspath(video_path), {})[sidx] = {
                        "pts": pts, "vis": vis}
                    if all(k in pts.get("L", {}) and k in pts.get("R", {}) for k in ("hip", "shoulder")):
                        hip_mid = (np.array(pts["L"]["hip"]) + np.array(pts["R"]["hip"])) / 2.0
                        sh_mid = (np.array(pts["L"]["shoulder"]) + np.array(pts["R"]["shoulder"])) / 2.0
                        trunk.append(_lean_from_vertical(hip_mid, sh_mid))
                        if all(k in pts.get("L", {}) and k in pts.get("R", {}) for k in ("hip", "ankle")):
                            hgt = abs(hip_mid[1] - np.mean([pts["R"]["ankle"][1], pts["L"]["ankle"][1]]))
                            if hgt > 1e-6:
                                body_h_smpl.append(hgt)
                                pelvis_y.append(hip_mid[1] / hgt)
                                pelvis_x.append(hip_mid[0] / hgt)
                    for s in ("L", "R"):
                        p = pts[s]
                        if all(k in p for k in ("hip", "knee", "ankle")):
                            knee_sig[s].append(_three_point_angle(p["hip"], p["knee"], p["ankle"]))
                        else:
                            knee_sig[s].append(np.nan)
                        # Lowest weight-bearing point of the foot (ankle or foot index).
                        cand = [v for k in ("ankle", "foot") if k in p for v in [p[k][1]]]
                        low_foot_y[s].append(float(min(cand)) if cand else np.nan)
                        if all(k in p for k in ("hip", "ankle")):
                            sample_hgt.append(abs(p["hip"][1] - p["ankle"][1]))
                        else:
                            sample_hgt.append(np.nan)
                    n_samples += 1
                    if n_samples >= count:
                        break
                frame_idx += 1
                if total > 0 and frame_idx >= total:
                    break
        finally:
            try:
                closer.close()
            except Exception:
                pass
    finally:
        cap.release()

    n_sampled = len(trunk)
    if n_sampled == 0:
        return _reject("no_human_pose", "No human figure was detected in the recording.")
    tracked = sum(1 for t in trunk if np.isfinite(t))
    if tracked / n_sampled < MIN_TRACKED_FRACTION:
        return _reject("no_human_pose", "A human figure could not be tracked in most of the clip.")

    upright = sum(1 for t in trunk if np.isfinite(t) and abs(t) <= 25.0)
    if upright / tracked < MIN_TRACKED_FRACTION:
        return _reject("not_upright",
                       "The detected figure is not standing upright (lying, sitting, or at a strongly tilted angle).")

    flight_frac = _flight_phase_fraction(low_foot_y, sample_hgt)

    if plane == "frontal" and pelvis_y and body_h_smpl:
        # Frontal view: pelvic vertical bob + lateral sway both encode stride rhythm.
        y = np.asarray(pelvis_y, dtype=float)
        x = np.asarray(pelvis_x, dtype=float)
        y = y - float(np.median(y))
        x = x - float(np.median(x))
        # Pick whichever channel oscillates more strongly as the rhythm signal.
        sig = y if float(np.std(y)) >= float(np.std(x)) else x
        result = _score_rhythm(sig, eff_fps, "frontal", speed_hint=speed_hint,
                               flight_frac=flight_frac)
    else:
        # Sagittal view: knee flexion oscillation of the better-tracked leg.
        best = "L" if np.isfinite(np.asarray(knee_sig["L"])).sum() >= np.isfinite(np.asarray(knee_sig["R"])).sum() else "R"
        n_ok = int(np.isfinite(np.asarray(knee_sig[best])).sum())
        if n_ok < max(6, 0.3 * n_sampled):
            return _reject("no_human_track", "The legs could not be tracked to measure gait rhythm.")
        result = _score_rhythm(knee_sig[best], eff_fps, "sagittal", speed_hint=speed_hint,
                               flight_frac=flight_frac)

    evidence = {
        "sampled_frames": n_sampled,
        "tracked_frames": tracked,
        "upright_frames": upright,
        "fps_effective": round(eff_fps, 2),
        "flight_phase_frac": flight_frac,
    }
    if isinstance(result.get("std"), float):
        evidence.update({k: result[k] for k in
                         ("std", "p90_p10", "dominant_freq_hz", "playback_speed",
                          "cadence_real_hz", "approx_cycles", "periodicity")
                         if k in result})
    result["evidence"] = evidence
    return result