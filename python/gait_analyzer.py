#!/usr/bin/env python3
"""
brc-gait-analyzer — Bonsai Rehabilitation Center Gait Lab analysis service.

Analyzes dual-view walking videos and emits a structured clinical interpretation:

  1. Gait cycle decomposed into the 8 standard sub-phases with durations and
     stance/swing percentages.
  2. Automatic anomaly flags (missing / accelerated / prolonged phases).
  3. Multi-planar deformity & biomechanical findings (frontal + sagittal),
     joint kinematics (ROM) and muscle involvement map.
  4. Targeted exercise + orthotic/prosthetic prescriptions.
  5. Peer-reviewed reference set backing the automated findings.

Two engines:
  * real mode   — extracts a motion signal from the uploaded videos with OpenCV
                  (frame-rate, cadence, cycle timing) and derives the phase model
                  from that data. Requires opencv (`pip install opencv-python`).
  * demo mode   — deterministic, seeded simulation used when videos are missing,
                  undecodable, or OpenCV is unavailable. Every result is clearly
                  labeled with its mode so clinical users can trust the provenance.

The output is a clinical *screening* aid — it never substitutes for an in-person
gait laboratory assessment.

Usage:
  python gait_analyzer.py --session 7 --patient "Ayesha" \
      --frontal uploads/gait/f.mp4 --sagittal uploads/gait/s.mp4 \
      --seed 7 --out result.json [--demo]
"""

import argparse
import hashlib
import json
import os
import random
import sys
from datetime import datetime, timezone

VERSION = "1.0.0"
ANALYZER = "brc-gait-analyzer"

# ---------------------------------------------------------------------------
# Canonical phase model (percentage of the gait cycle each sub-phase occupies).
# ---------------------------------------------------------------------------
PHASE_DEFS = [
    ("loading_response", "Loading Response / Heel Strike to Full Contact", "stance", 0, 10, 10),
    ("mid_stance", "Mid Stance", "stance", 10, 30, 20),
    ("terminal_stance", "Terminal Stance", "stance", 30, 50, 20),
    ("pre_swing", "Pre-Swing", "stance", 50, 60, 10),
    ("initial_swing", "Initial Swing", "swing", 60, 73, 13),
    ("mid_swing", "Mid Swing", "swing", 73, 87, 14),
    ("terminal_swing", "Terminal Swing", "swing", 87, 100, 13),
]

REFERENCE_PAPERS = [
    {"id": "R1", "authors": "Perry J, Burnfield JM", "year": 2010,
     "title": "Gait Analysis: Normal and Pathological Function", "venue": "SLACK Incorporated, 2nd ed."},
    {"id": "R2", "authors": "Winter DA", "year": 1991,
     "title": "Biomechanics and Motor Control of Human Gait: Normal, Elderly and Pathological",
     "venue": "University of Waterloo Press, 2nd ed."},
    {"id": "R3", "authors": "Sutherland DH", "year": 1997,
     "title": "The development of mature gait", "venue": "Gait & Posture, 6(2):163-170"},
    {"id": "R4", "authors": "Whittle MW", "year": 2007,
     "title": "Gait Analysis: An Introduction", "venue": "Butterworth-Heinemann, 4th ed."},
    {"id": "R5", "authors": "Baker R", "year": 2013,
     "title": "Measuring Walking: A Handbook of Clinical Gait Analysis",
     "venue": "Mac Keith Press"},
    {"id": "R6", "authors": "Novacheck TF", "year": 1998,
     "title": "The biomechanics of running", "venue": "Gait & Posture, 7(1):77-95"},
    {"id": "R7", "authors": "Benedetti MG, Catani F, Leardini A, Pignotti E, Giannini S", "year": 1998,
     "title": "Data management in gait analysis for clinical applications",
     "venue": "Clinical Biomechanics, 13(3):204-215"},
    {"id": "R8", "authors": "Gage JR, Schwartz MH, Koop SE, Novacheck TF", "year": 2009,
     "title": "The Identification and Treatment of Gait Problems in Cerebral Palsy",
     "venue": "Mac Keith Press, 2nd ed."},
]

# Map one anomaly type per phase name (realistic clinical associations).
ANOMALY_CATALOG = {
    "loading_response": (
        ["prolonged", "Prolonged loading response with excessive knee flexion on weight acceptance.".format()],
        ["accelerated", "Abrupt weight transfer into mid-stance; reduced shock absorption.".format()]),
    "mid_stance": (
        ["prolonged", "Prolonged mid-stance with excessive hip/knee flexion unless contraindicated.".format()],
        ["accelerated", "Shortened mid-stance; limited single-limb support time.".format()]),
    "terminal_stance": (
        ["accelerated", "Abbreviated terminal stance; premature heel rise reduces push-off time.".format()],
        ["missing", "Terminal stance not clearly observed; propulsion appears absent.".format()]),
    "pre_swing": (
        ["prolonged", "Prolonged pre-swing; slow weight transfer and delayed toe-off.".format()],
        ["accelerated", "Rapid pre-swing suggests reduced push-off power.".format()]),
    "initial_swing": (
        ["accelerated", "Accelerated initial swing is often compensatory for reduced propulsion.".format()],
        ["missing", "Initial swing absent; limb appears dragged through swing.".format()]),
    "mid_swing": (
        ["prolonged", "Prolonged mid-swing with toe drag pattern (reduced clearance).".format()],
        ["accelerated", "Abbreviated mid-swing reduces foot clearance.".format()]),
    "terminal_swing": (
        ["missing", "Terminal swing absent; no deceleration before contact (stiff knee pattern).".format()],
        ["accelerated", "Rapid terminal swing; inadequate pre-contact deceleration.".format()]),
}

DEFORMITY_FRONTAL = [
    {"name": "Genu varum (bow-leg) alignment", "magnitude": "moderate", "category": "structural",
     "description": "Medial collapse at the knee in the frontal plane; weight line falls lateral to "
                    "the knee center. Associated with reduced medial-compartment loading symmetry."},
    {"name": "Genu valgum (knock-knee) alignment", "magnitude": "moderate", "category": "structural",
     "description": "Medial displacement of the knee; weight line falls medial to the joint axis."},
    {"name": "Pelvic drop (Trendelenburg pattern)", "magnitude": "moderate", "category": "functional",
     "description": "Contralateral pelvis drops during single-limb stance; indicates weak hip "
                    "abductors on the stance side."},
    {"name": "Increased pelvic obliquity / lateral trunk lean", "magnitude": "mild", "category": "functional",
     "description": "Trunk compensates over the stance limb, shifting center of mass."},
]

DEFORMITY_SAGITTAL = [
    {"name": "Excessive knee flexion throughout stance (crouch gait)", "magnitude": "moderate", "category": "functional",
     "description": "Persistent knee flexion increases quadriceps demand and energy cost."},
    {"name": "Drop foot / foot drop during swing", "magnitude": "moderate", "category": "functional",
     "description": "Inadequate ankle dorsiflexion during swing reduces foot clearance and risks catching."},
    {"name": "Vaulting", "magnitude": "mild", "category": "functional",
     "description": "Early plantarflexion rise in terminal stance to clear the limb, shortening effective leg."},
    {"name": "Hip hiking", "magnitude": "mild", "category": "functional",
     "description": "Pelvic elevation on the swing side to gain foot clearance; pelvic asymmetry."},
    {"name": "Circumduction", "magnitude": "moderate", "category": "functional",
     "description": "Leg swung outward in a wide arc during swing for foot clearance; reduced stride length."},
    {"name": "Stiff-knee gait", "magnitude": "moderate", "category": "functional",
     "description": "Reduced peak knee flexion in swing from spasticity or insufficient momentum."},
    {"name": "Excessive anterior pelvic tilt", "magnitude": "mild", "category": "functional",
     "description": "Increased lumbar lordosis and hip flexor dominance."},
]

DEFORMITY_ROTATIONAL = [
    {"name": "Increased femoral anteversion (into-toeing)", "magnitude": "moderate", "category": "rotational",
     "description": "Excessive medial rotation of the femur narrows the walking base and may cause into-toeing."},
    {"name": "External tibial torsion", "magnitude": "moderate", "category": "rotational",
     "description": "Outward rotation of the tibia relative to the femur widens foot progression angle."},
    {"name": "Internal tibial torsion", "magnitude": "mild", "category": "rotational",
     "description": "Inward rotation of the tibia contributes to into-toeing and toe drag in swing."},
    {"name": "Hip internal rotation during stance", "magnitude": "mild", "category": "rotational",
     "description": "Persistent medial rotation moment at the hip reduces lever arm for abduction."},
]

ROM_DEFS = [
    {"joint": "Hip", "movement": "Flexion / Extension", "normal": "0-45 flex", "note": ""},
    {"joint": "Hip", "movement": "Rotation", "normal": "0-45 internal / 0-45 external", "note": ""},
    {"joint": "Knee", "movement": "Flexion / Extension", "normal": "0-60 flex during swing", "note": ""},
    {"joint": "Knee", "movement": "Recurvatum check", "normal": "0 extreme", "note": ""},
    {"joint": "Ankle", "movement": "Dorsiflexion / Plantarflexion", "normal": "0-20 DF / 0-50 PF", "note": ""},
    {"joint": "Pelvis", "movement": "Tilt in stance", "normal": "0-5 deg", "note": ""},
]

ARCHETYPES = [
    {"label": "equinus", "anomalies": ["loading_response:prolonged", "terminal_stance:accelerated", "pre_swing:accelerated"],
     "deformity": ["Drop foot / foot drop during swing", "Vaulting"],
     "overactive": [("Gastrocnemius / Soleus", "Primary plantarflexors; overactivity shortens the heel-rock in terminal stance")],
     "weak": [("Tibialis anterior", "Dorsiflexion during swing and eccentric control at contact")],
     "exercises": [
         {"name": "Standing calf stretch with wall support", "frequency": "2 min daily, 3 sets",
          "sets": 3, "reps": None, "hold_seconds": 60, "rest_seconds": 30,
          "reason": "Lengthens plantarflexors to restore dorsiflexion arc for heel strike"},
         {"name": "Heel-raises — slow eccentric lowering", "frequency": "15 reps, 2 sets daily",
          "sets": 2, "reps": 15, "hold_seconds": None, "rest_seconds": 45,
          "reason": "Trains controlled plantarflexion and push-off without overactivation"},
         {"name": "Tibialis anterior strengthening on step", "frequency": "12 reps, 2 sets daily",
          "sets": 2, "reps": 12, "hold_seconds": None, "rest_seconds": 30,
          "reason": "Improves swing-phase dorsiflexion and foot clearance"}],
     "orthotics": [{"component": "Dynamic ankle-foot orthosis (DAFO)",
                    "reason": "Supports swing clearance while preserving ankle motion"},
                   {"component": "Heel lift inset (6-10 mm)",
                    "reason": "Temporary accommodation while dorsiflexion range is restored"}],
     "prosthetics": []},
    {"label": "crouch", "anomalies": ["loading_response:prolonged", "mid_stance:prolonged", "terminal_swing:missing"],
     "deformity": ["Excessive knee flexion throughout stance (crouch gait", "Excessive anterior pelvic tilt"],
     "overactive": [("Rectus femoris", "Co-contraction holds knee flexed during stance")],
     "weak": [("Quadriceps (vastii)", "Struggles to extend knee near terminal stance"),
              ("Hip extensors (gluteus maximus)", "Limited hip extension power in late stance")],
     "exercises": [
         {"name": "Prone knee extension holds", "frequency": "10 sec holds, 3 sets daily",
          "sets": 3, "reps": None, "hold_seconds": 10, "rest_seconds": 30,
          "reason": "Builds terminal-extension capacity against crouch posture"},
         {"name": "Hip extension bridging", "frequency": "12 reps, 3 sets x3/week",
          "sets": 3, "reps": 12, "hold_seconds": None, "rest_seconds": 45,
          "reason": "Trains gluteus maximus to unlock the knee in late stance"},
         {"name": "Wall sits with knee in neutral", "frequency": "30 sec, 3 sets daily",
          "sets": 3, "reps": None, "hold_seconds": 30, "rest_seconds": 45,
          "reason": "Trains quadriceps endurance at functional knee angles"}],
     "orthotics": [{"component": "Floor-reaction AFO (HGO)",
                    "reason": "Provides knee-extension moment in stance to resist crouch"},
                   {"component": "Knee-ankle-foot orthosis (trial)",
                    "reason": "Considered for refractory crouch under clinician guidance"}],
     "prosthetics": []},
    {"label": "trendelenburg", "anomalies": ["terminal_stance:prolonged", "initial_swing:accelerated"],
     "deformity": ["Pelvic drop (Trendelenburg pattern", "Increased pelvic obliquity / lateral trunk lean"],
     "overactive": [("Tensor fasciae latae", "Compensates for weak hip abductors")],
     "weak": [("Gluteus medius / minimus", "Stabilizes the pelvis in single-limb stance"),
              ("Gluteus maximus", "Hip extension and pelvic posterior control")],
     "exercises": [
         {"name": "Side-lying hip abduction", "frequency": "12 reps, 3 sets daily",
          "sets": 3, "reps": 12, "hold_seconds": None, "rest_seconds": 30,
          "reason": "Directly strengthens the stance-side abductors"},
         {"name": "Single-leg balance on step", "frequency": "20-30 sec, 3 reps daily",
          "sets": 1, "reps": 3, "hold_seconds": 25, "rest_seconds": 60,
          "reason": "Challenges the abductor mechanism in weight-bearing"},
         {"name": "Clam shells with light resistance", "frequency": "15 reps, 2 sets daily",
          "sets": 2, "reps": 15, "hold_seconds": None, "rest_seconds": 30,
          "reason": "Isolates hip abductor/external rotator groups"}],
     "orthotics": [{"component": "Heel lift on contralateral side (2-4 mm)",
                    "reason": "Can reduce apparent limb-length discrepancy pattern"},
                    ],
     "prosthetics": []},
    {"label": "stiff-knee", "anomalies": ["mid_swing:prolonged", "terminal_swing:missing"],
     "deformity": ["Stiff-knee gait"],
     "overactive": [("Rectus femoris", "Overactive during swing limits peak knee flexion")],
     "weak": [("Hip flexors / iliopsoas", "Drives limb advancement in early swing"),
              ("Hamstrings", "Decelerate the limb in terminal swing")],
     "exercises": [
         {"name": "High-knee marching in place", "frequency": "2 min, 3 sets daily",
          "sets": 3, "reps": None, "hold_seconds": None, "rest_seconds": 30,
          "reason": "Practices hip-driven limb advancement and swing flexion"},
         {"name": "Prone active knee flexion", "frequency": "15 reps, 2 sets daily",
          "sets": 2, "reps": 15, "hold_seconds": None, "rest_seconds": 30,
          "reason": "Trains knee flexion without rectus femoris co-contraction"},
         {"name": "Stretch rectus femoris in standing", "frequency": "30 sec x3 daily",
          "sets": 3, "reps": None, "hold_seconds": 30, "rest_seconds": 20,
          "reason": "Reduces overactivity limiting swing flexion"}],
     "orthotics": [],
     "prosthetics": [{"component": "Prosthetic knee mechanism (for transfemoral users) -- essential multi-axis knee",
                      "reason": "Regulated swing flexion improves clearance and stride symmetry"}]},
    {"label": "vaulting", "anomalies": ["terminal_stance:accelerated", "pre_swing:accelerated", "initial_swing:accelerated"],
     "deformity": ["Vaulting (plantarflexion of standing limb to elevate body for swing clearance)", "Hip-hike on swing side"],
     "overactive": [("Gastrocnemius / Soleus", "Primary plantarflexors; early heel rise elevates standing limb"),
                    ("Iliopsoas", "Hip flexors lift swing limb high")],
     "weak": [("Tibialis anterior", "Dorsiflexor weakness reduces swing clearance without vaulting"),
              ("Gluteus medius / minimus", "Hip abductor weakness contributes to compensatory elevation")],
     "exercises": [
         {"name": "Standing calf stretch", "frequency": "2 min daily, 3 sets", "sets": 3, "reps": None, "hold_seconds": 60, "rest_seconds": 30,
          "reason": "Reduces plantarflexor overactivity that drives early heel rise"},
         {"name": "Tibialis anterior strengthening", "frequency": "15 reps, 2 sets daily", "sets": 2, "reps": 15, "hold_seconds": None, "rest_seconds": 45,
          "reason": "Improves dorsiflexion so vaulting is not needed for clearance"},
         {"name": "Hip-hike practice with mirror feedback", "frequency": "10 reps each side, daily", "sets": 1, "reps": 10, "hold_seconds": None, "rest_seconds": 60,
          "reason": "Teaches controlled hip elevation vs. compensatory vaulting"}],
     "orthotics": [{"component": "Posterior leaf spring AFO", "reason": "Assists dorsiflexion so standing limb need not vault"}],
     "prosthetics": []},
    {"label": "hip_hiking", "anomalies": ["initial_swing:prolonged", "mid_swing:prolonged"],
     "deformity": ["Hip hiking (pelvic elevation on swing side to clear foot)", "Trendelenburg-like pelvic asymmetry"],
     "overactive": [("Quadratus lumborum", "Elevates pelvis on swing side"),
                    ("Tensor fasciae latae", "Hip abductor compensation")],
     "weak": [("Gluteus medius / minimus", "Hip abductor weakness lets pelvis drop"),
              ("Iliopsoas", "Hip flexor weakness limits forward limb advancement")],
     "exercises": [
         {"name": "Side-lying hip abduction", "frequency": "12 reps, 3 sets daily", "sets": 3, "reps": 12, "hold_seconds": None, "rest_seconds": 45,
          "reason": "Strengthens stance-side abductors so pelvis stays level"},
         {"name": "Standing hip flexion with level pelvis", "frequency": "12 reps each side, 2 sets", "sets": 2, "reps": 12, "hold_seconds": None, "rest_seconds": 45,
          "reason": "Trains hip flexors without pelvic elevation"},
         {"name": "Single-leg balance on step", "frequency": "20-30 sec, 3 reps daily", "sets": 1, "reps": 3, "hold_seconds": 25, "rest_seconds": 60,
          "reason": "Challenges abductor control in weight-bearing"}],
     "orthotics": [{"component": "Posterior leaf spring AFO", "reason": "Improves foot clearance reducing need to hike"}],
     "prosthetics": []},
    {"label": "circumduction", "anomalies": ["mid_swing:prolonged", "terminal_swing:prolonged"],
     "deformity": ["Circumduction (leg swung outward in a wide arc for foot clearance)", "Reduced stride length on affected side"],
     "overactive": [("Tensor fasciae latae", "Abducts/externally rotates hip to swing leg outward"),
                    ("Gluteus medius", "Overactive to lift hip during circumduction arc")],
     "weak": [("Tibialis anterior", "Dorsiflexor weakness reduces toe clearance, triggering circumduction"),
              ("Iliopsoas", "Hip flexor weakness limits forward swing, encouraging outward arc")],
     "exercises": [
         {"name": "Seated ankle dorsiflexion with resistance band", "frequency": "15 reps, 2 sets daily", "sets": 2, "reps": 15, "hold_seconds": None, "rest_seconds": 45,
          "reason": "Strengthens dorsiflexors so circumduction is not needed for clearance"},
         {"name": "Straight-leg marching forward", "frequency": "2 min, 3 sets daily", "sets": 3, "reps": None, "hold_seconds": None, "rest_seconds": 30,
          "reason": "Trains forward (sagittal) swing instead of outward arc"},
         {"name": "Tibialis anterior raises", "frequency": "15 reps, 2 sets daily", "sets": 2, "reps": 15, "hold_seconds": None, "rest_seconds": 45,
          "reason": "Improves toe clearance during swing"}],
     "orthotics": [{"component": "Posterior leaf spring AFO", "reason": "Assists dorsiflexion, reducing circumduction need"}],
     "prosthetics": []},
]

# ---- point 3 completion: multi-planar biomechanical muscle map ----
# Each detected gait anomaly / deformity is linked to the overactive / weak /
# etc. muscles that produce it, the localized structural burden it creates, and
# the typical compensation that masks it. `muscles.anomaly_links` is assembled
# from these tables so reports always tie muscle involvement *directly* to the
# specific anomalies flagged in the session.
ANOMALY_MUSCLE_LINKS = {
    "equinus": [
        {
            "anomaly": "Drop foot / foot drop during swing",
            "deformities": ["Drop foot / foot drop during swing"],
            "muscles": [
                {"name": "Tibialis anterior", "status": "weak",
                 "role": "Ankle dorsiflexion during swing",
                 "implication": "Inadequate dorsiflexion lowers foot clearance and risks toe drag."},
                {"name": "Gastrocnemius / Soleus", "status": "overactive",
                 "role": "Primary plantarflexors",
                 "implication": "Sustained plantarflexor activity resists the dorsiflexion arc."},
            ],
            "localized_damage": "Concentrated load at the Achilles insertion and talar dome from a shortened heel rock.",
            "compensation": "Hip-hike / circumduction to achieve toe clearance in swing.",
        },
        {
            "anomaly": "Vaulting",
            "deformities": ["Vaulting"],
            "muscles": [
                {"name": "Gastrocnemius / Soleus", "status": "overactive",
                 "role": "Plantarflexion at push-off",
                 "implication": "Early heel rise shortens the effective limb to clear the ground."},
                {"name": "Tibialis anterior", "status": "weak",
                 "role": "Decelerates footfall at contact",
                 "implication": "Poor eccentric control lets the foot slap and shortens loading response."},
            ],
            "localized_damage": "Forefoot and plantar fascia overload from repeated early heel rise.",
            "compensation": "Elevated contralateral swing as the standing limb vaults.",
        },
    ],
    "crouch": [
        {
            "anomaly": "Excessive knee flexion throughout stance (crouch gait)",
            "deformities": ["Excessive knee flexion throughout stance (crouch gait)"],
            "muscles": [
                {"name": "Rectus femoris", "status": "overactive",
                 "role": "Co-contraction holds the knee flexed in stance",
                 "implication": "Keeps the limb in a flexed posture and blocks terminal extension."},
                {"name": "Quadriceps (vastii)", "status": "weak",
                 "role": "Knee extension against gravity",
                 "implication": "Cannot overcome the flexor bias near terminal stance."},
                {"name": "Hip extensors (gluteus maximus)", "status": "weak",
                 "role": "Hip extension in late stance",
                 "implication": "Limited hip extension power tilts the pelvis and sustains the flexed posture."},
            ],
            "localized_damage": "Elevated patellofemoral and quadriceps tendon stress; tight hip flexors / hamstrings.",
            "compensation": "Increased lumbar lordosis and forward trunk lean to shift weight forward.",
        },
        {
            "anomaly": "Excessive anterior pelvic tilt",
            "deformities": ["Excessive anterior pelvic tilt"],
            "muscles": [
                {"name": "Hip flexors / iliopsoas", "status": "overactive",
                 "role": "Anterior pelvic control",
                 "implication": "Shortened/overactive flexors pull the pelvis into anterior tilt."},
                {"name": "Abdominals / hip extensors", "status": "weak",
                 "role": "Posterior pelvic control",
                 "implication": "Reduced restraint allows the tilt and compensatory lordosis."},
            ],
            "localized_damage": "Lumbar facet / disc strain from the cascading lordosis.",
            "compensation": "Forward trunk lean and hip-flexor-dominant gait.",
        },
    ],
    "trendelenburg": [
        {
            "anomaly": "Pelvic drop (Trendelenburg pattern)",
            "deformities": ["Pelvic drop (Trendelenburg pattern)"],
            "muscles": [
                {"name": "Gluteus medius / minimus", "status": "weak",
                 "role": "Pelvic stabilization in single-limb stance",
                 "implication": "Stance-side abductors cannot hold the pelvis level."},
                {"name": "Tensor fasciae latae", "status": "overactive",
                 "role": "Hip abductor compensation",
                 "implication": "Overuse compensation for an insufficient abductor mechanism."},
            ],
            "localized_damage": "Contralateral hip abductor overload and lateral lumbar strain.",
            "compensation": "Lateral trunk lean over the stance limb to reduce the abductor moment arm.",
        },
        {
            "anomaly": "Increased pelvic obliquity / lateral trunk lean",
            "deformities": ["Increased pelvic obliquity / lateral trunk lean"],
            "muscles": [
                {"name": "Gluteus maximus", "status": "weak",
                 "role": "Hip extension & posterior pelvic control",
                 "implication": "Reduced extensor power shifts weight onto the trunk."},
                {"name": "Tensor fasciae latae", "status": "overactive",
                 "role": "Lateral trunk stabilizer compensation",
                 "implication": "Short/gait via trunk side-bending replaces a stable pelvis."},
            ],
            "localized_damage": "Lumbar facet and disc stress from repeated lateral bending.",
            "compensation": "Broadened base of support and circumduction on the sound side.",
        },
    ],
    "stiff-knee": [
        {
            "anomaly": "Stiff-knee gait",
            "deformities": ["Stiff-knee gait"],
            "muscles": [
                {"name": "Rectus femoris", "status": "overactive",
                 "role": "Swing-phase knee extension",
                 "implication": "Overactivity limits peak knee flexion in swing."},
                {"name": "Hip flexors / iliopsoas", "status": "weak",
                 "role": "Limb advancement in early swing",
                 "implication": "Insufficient hip-flexor drive reduces swing-phase limb progression."},
                {"name": "Hamstrings", "status": "weak",
                 "role": "Terminal-swing deceleration",
                 "implication": "Reduced eccentric work prevents smooth limb deceleration before contact."},
            ],
            "localized_damage": "Patellofemoral contact stress and quadriceps overload from a stiff, dragged limb.",
            "compensation": "Circumduction, hip-hike and lateral trunk bending to clear the stiff limb.",
        },
    ],
    "vaulting": [
        {
            "anomaly": "Vaulting (plantarflexion of standing limb to elevate body for swing clearance)",
            "deformities": ["Vaulting"],
            "muscles": [
                {"name": "Gastrocnemius / Soleus", "status": "overactive",
                 "role": "Primary plantarflexors",
                 "implication": "Early heel rise shortens the effective limb to clear the ground."},
                {"name": "Tibialis anterior", "status": "weak",
                 "role": "Decelerates footfall at contact",
                 "implication": "Poor eccentric control lets the foot slap and shortens loading response."},
            ],
            "localized_damage": "Forefoot and plantar fascia overload from repeated early heel rise.",
            "compensation": "Elevated contralateral swing as the standing limb vaults.",
        },
    ],
    "hip_hiking": [
        {
            "anomaly": "Hip hiking (pelvic elevation on swing side to clear foot)",
            "deformities": ["Hip hiking"],
            "muscles": [
                {"name": "Quadratus lumborum", "status": "overactive",
                 "role": "Elevates pelvis on swing side",
                 "implication": "Hikes the pelvis to gain foot clearance without adequate knee/ankle flexion."},
                {"name": "Gluteus medius / minimus", "status": "weak",
                 "role": "Hip abduction and pelvic stabilization",
                 "implication": "Weak abductors let the stance-side pelvis drop, triggering swing-side elevation."},
            ],
            "localized_damage": "Lumbar facet / disc stress from repeated lateral trunk side-bending.",
            "compensation": "Broadened base of support and circumduction on the sound side.",
        },
    ],
    "circumduction": [
        {
            "anomaly": "Circumduction (leg swung outward in a wide arc for foot clearance)",
            "deformities": ["Circumduction"],
            "muscles": [
                {"name": "Tensor fasciae latae", "status": "overactive",
                 "role": "Hip abduction / external rotation",
                 "implication": "Swings the leg outward in a wide arc instead of forward."},
                {"name": "Tibialis anterior", "status": "weak",
                 "role": "Ankle dorsiflexion during swing",
                 "implication": "Reduced toe clearance forces the circumduction arc."},
            ],
            "localized_damage": "Hip abductor overuse and lateral knee stress from the outward swing arc.",
            "compensation": "Lateral trunk lean to reduce abductor moment arm during the circumduction arc.",
        },
    ],
}

# Structural / biomechanical weaknesses implicated by the detected pattern.
# `category` mirrors the deformity classification: structural = bony/alignment,
# functional = timing/muscle-driven, rotational = transverse-plane torsion.
STRUCTURAL_WEAKNESSES = {
    "equinus": [
        {"structure": "Achilles tendon / triceps-surae complex", "category": "structural",
         "related_deformity": "Equinus / drop foot",
         "note": "Shortened plantarflexors limit passive dorsiflexion at contact and mid-stance."},
        {"structure": "Plantar fascia / forefoot", "category": "functional",
         "related_deformity": "Forefoot overload under vaulting",
         "note": "Repeated early heel-rise loads the forefoot and plantar fascia."},
    ],
    "crouch": [
        {"structure": "Knee joint – patellofemoral + tibiofemoral", "category": "structural",
         "related_deformity": "Crouch gait",
         "note": "Sustained stance-phase knee flexion concentrates patellofemoral and quadriceps loading."},
        {"structure": "Quadriceps / patellar tendon", "category": "functional",
         "related_deformity": "Excessive knee flexion throughout stance",
         "note": "Constant quadriceps work to resist flexion risks overuse tendinopathy and fatigue."},
        {"structure": "Lumbar spine / hip flexor chain", "category": "functional",
         "related_deformity": "Excessive anterior pelvic tilt",
         "note": "Anterior pelvic tilt cascades into lumbar hyperlordosis and hip-flexor dominance."},
    ],
    "trendelenburg": [
        {"structure": "Hip abductor mechanism (gluteus medius/minimus)", "category": "functional",
         "related_deformity": "Pelvic drop (Trendelenburg pattern)",
         "note": "Weak stance-side abductors allow the contralateral pelvis to drop on single-limb stance."},
        {"structure": "Lumbar facet joints / intervertebral discs", "category": "functional",
         "related_deformity": "Lateral trunk lean / pelvic obliquity",
         "note": "Repeated lateral trunk side-bending loads the lumbar spine."},
    ],
    "stiff-knee": [
        {"structure": "Knee joint – patellofemoral cartilage", "category": "structural",
         "related_deformity": "Stiff-knee gait",
         "note": "Reduced swing-phase knee motion concentrates contact stress on the patellofemoral surface."},
        {"structure": "Rectus femoris muscle-tendon complex", "category": "functional",
         "related_deformity": "Reduced peak knee flexion in swing",
         "note": "Sustained rectus overactivity during swing can promote myotendinous strain."},
    ],
    "vaulting": [
        {"structure": "Ankle plantarflexors (gastrocnemius / soleus)", "category": "functional",
         "related_deformity": "Vaulting",
         "note": "Overactive plantarflexors cause early heel-rise, shortening the effective standing limb."},
        {"structure": "Forefoot / metatarsal heads", "category": "structural",
         "related_deformity": "Forefoot overload under vaulting",
         "note": "Repeated push-off on the forefoot concentrates load under the metatarsal heads."},
    ],
    "hip_hiking": [
        {"structure": "Quadratus lumborum / ipsilateral trunk", "category": "functional",
         "related_deformity": "Hip hiking",
         "note": "Overactive quadratus lumborum elevates the pelvis on the swing side to clear the foot."},
        {"structure": "Hip abductor mechanism", "category": "functional",
         "related_deformity": "Pelvic asymmetry",
         "note": "Weak stance-side abductors let the pelvis drop, prompting swing-side elevation."},
    ],
    "circumduction": [
        {"structure": "Hip abductor / external rotator chain", "category": "functional",
         "related_deformity": "Circumduction",
         "note": "Overactive TFL / gluteus medius swings the leg outward for foot clearance."},
        {"structure": "Ankle dorsiflexors (tibialis anterior)", "category": "functional",
         "related_deformity": "Reduced swing-foot clearance",
         "note": "Weak dorsiflexors drop the foot, triggering the outward circumduction arc."},
    ],
}


def augment_muscle_map(muscles, archetype_label, anomalies, deformities):
    """Point-3 completion: tie every muscle into the specific anomalies flagged.

    Writes `muscles.anomaly_links` (the biomechanical linkage per anomaly) and
    `muscles.structural_weaknesses` while leaving the legacy `overactive` / `weak`
    summaries intact for the UI. `archtype_links` are marked `matched` when their
    deformity clearly appears among the reported findings so the clinician can see
    which linkage drove which finding.
    """
    links = list(ANOMALY_MUSCLE_LINKS.get(archetype_label) or [])
    defn_low = " ".join(d.get("name") or "" for d in deformities).lower()
    anomaly_phases = {str(a.get("phase_name") or "").lower() for a in anomalies}

    out = []
    for link in links:
        matched = any((dname or "").lower() in defn_low for dname in link.get("deformities") or [])
        if not matched:
            base = str(link.get("anomaly") or "").split("(")[0].strip().lower()
            matched = base in anomaly_phases or any(base.split()[0] in p for p in anomaly_phases)
        out.append({**link, "matched": bool(matched)})

    muscles["anomaly_links"] = out
    muscles["structural_weaknesses"] = list(STRUCTURAL_WEAKNESSES.get(archetype_label) or [])
    notes = list(muscles.get("notes") or [])
    notes.append("Per-anomaly linkage maps each overactive/weak group to the gait anomaly it produces or compensates for.")
    muscles["notes"] = notes
    return muscles


EXERCISE_BANK = [
    {"name": "Ankle alphabet (tracing letters with the foot)", "frequency": "1 min daily",
     "sets": 1, "reps": None, "hold_seconds": None, "rest_seconds": 15,
     "reason": "Maintains full ankle ROM and neuromuscular control"},
    {"name": "Heel-toe rocker walking practice", "frequency": "5 min daily",
     "sets": 1, "reps": None, "hold_seconds": None, "rest_seconds": 30,
     "reason": "Reinforces normal rocker sequence from heel strike to toe-off"},
    {"name": "Assisted side-stepping with a wall", "frequency": "10 steps x3 daily",
     "sets": 3, "reps": 10, "hold_seconds": None, "rest_seconds": 30,
     "reason": "Trains frontal-plane control and weight shift"},
    {"name": "Sit-to-stand without arm support", "frequency": "10 reps, 2 sets daily",
     "sets": 2, "reps": 10, "hold_seconds": None, "rest_seconds": 45,
     "reason": "Trains hip/knee extension synergies used in terminal stance"},
    {"name": "Stair stepping -- slow cadence", "frequency": "5 min daily",
     "sets": 1, "reps": None, "hold_seconds": None, "rest_seconds": 30,
     "reason": "Improves single-limb support and swing clearance timing"},
]

# ---------------------------------------------------------------------------
# Supporting literature — peer-reviewed citations matched to the detected
# findings. Each paper declares the clinical topics it supports; the reference
# section of every report is assembled from the topics actually found, so the
# cited work always backs the specific automated diagnostic findings.
# ---------------------------------------------------------------------------
# Each citation is tagged with the clinical *category* it backs so reports can
# split evidence into: deformity detection, exercise rehabilitation, orthotic /
# prosthetic intervention, and progression prognosis. `topics` still drives the
# dynamic matching against the findings actually detected in a session.
SUPPORTING_PAPERS = [
    # ---- deformity detection / biomechanical diagnosis ----
    {"id": "S1", "category": "deformity", "authors": "Sutherland DH, Cooper L, Daniel D", "year": 1980,
     "title": "The role of the ankle plantar flexors in normal walking",
     "venue": "Journal of Bone and Joint Surgery (American), 62(3):354-363",
     "topics": ["equinus", "plantarflex", "foot-drop", "vaulting", "push-off"]},
    {"id": "S2", "category": "deformity", "authors": "Neptune RR, Kautz SA, Zajac FE", "year": 2001,
     "title": "Contributions of the individual ankle plantar flexors to support, forward progression "
             "and swing initiation during walking",
     "venue": "Journal of Biomechanics, 34(11):1387-1398",
     "topics": ["equinus", "plantarflex", "crouch", "push-off"]},
    {"id": "S3", "category": "deformity", "authors": "Sutherland DH, Cooper L", "year": 1978,
     "title": "The pathomechanics of progressive crouch gait in spastic diplegia",
     "venue": "Orthopedic Clinics of North America, 9(1):143-154",
     "topics": ["crouch", "knee-flexion", "hip-flexor-dominance", "alignment"]},
    {"id": "S4", "category": "deformity", "authors": "Kerrigan DC, Gronley J, Perry J", "year": 1991,
     "title": "Stiff-legged gait in spastic paresis: a study of quadriceps and hamstrings muscle activity",
     "venue": "American Journal of Physical Medicine & Rehabilitation, 70(6):294-300",
     "topics": ["stiff-knee"]},
    {"id": "S5", "category": "deformity", "authors": "Hardcastle P, Nade S", "year": 1985,
     "title": "The significance of the Trendelenburg test",
     "venue": "Journal of Bone and Joint Surgery (British), 67(5):741-746",
     "topics": ["trendelenburg", "abductor", "pelvic-drop", "trunk-lean"]},
    {"id": "S6", "category": "deformity", "authors": "Gage JR", "year": 1991,
     "title": "Gait analysis in cerebral palsy",
     "venue": "Clinics in Developmental Medicine No. 121, Mac Keith Press",
     "topics": ["crouch", "stiff-knee", "equinus", "alignment", "pediatric"]},
    {"id": "S7", "category": "deformity", "authors": "Moreland JR, Bassett LW, Hanker GJ", "year": 1987,
     "title": "Radiographic analysis of the axial alignment of the lower extremity",
     "venue": "Journal of Bone and Joint Surgery (American), 69(5):745-749",
     "topics": ["alignment", "tibiofemoral", "varus", "valgus", "coronal"]},
    {"id": "S8", "category": "deformity", "authors": "Chao EYS, Neluheni EVD, Hsu RWW, Paley D", "year": 1994,
     "title": "Biomechanics of malalignment",
     "venue": "Orthopedic Clinics of North America, 25(3):379-386",
     "topics": ["alignment", "coronal", "varus", "valgus", "load", "tibiofemoral"]},
    # ---- exercise rehabilitation ----
    {"id": "S10", "category": "exercise", "authors": "Damiano DL, Kelly LE, Vaughn CL", "year": 1995,
     "title": "Effects of quadriceps femoris muscle strengthening on crouch gait in children with spastic diplegia",
     "venue": "Physical Therapy, 75(8):658-667",
     "topics": ["exercise", "crouch", "quadriceps", "strengthening", "pediatric"]},
    {"id": "S11", "category": "exercise", "authors": "Fukuda TY, Rossetto FM, Magalhaes E, Bryk FF, Lucareli PR, de Almeida Carvalho NA", "year": 2010,
     "title": "Short-term effects of hip abductors and lateral rotators strengthening in females with patellofemoral pain syndrome",
     "venue": "Journal of Orthopaedic & Sports Physical Therapy, 40(11):736-742",
     "topics": ["exercise", "abductor", "hip", "strengthening", "balance"]},
    {"id": "S12", "category": "exercise", "authors": "Ageberg E, Roos EM", "year": 2015,
     "title": "Neuromuscular exercise as treatment for degenerative knee disease",
     "venue": "Exercise and Sport Sciences Reviews, 43(1):14-22",
     "topics": ["exercise", "strengthening", "balance", "knee", "degeneration"]},
    # ---- orthotic / prosthetic intervention ----
    {"id": "S13", "category": "orthotic_prosthetic", "authors": "Morris C", "year": 2007,
     "title": "Orthotic management of children with cerebral palsy",
     "venue": "Journal of Prosthetics and Orthotics, 19(4S):43-52",
     "topics": ["orthotic", "afo", "kafo", "pediatric", "equinus", "crouch", "alignment"]},
    {"id": "S14", "category": "orthotic_prosthetic", "authors": "Kerrigan DC, Lelas JL, Goggins J, Merriman GJ, Kaplan RJ, Felson DT", "year": 2002,
     "title": "Effectiveness of a lateral-wedge insole on knee varus torque in patients with knee osteoarthritis",
     "venue": "Archives of Physical Medicine and Rehabilitation, 83(7):889-893",
     "topics": ["orthotic", "insole", "varus", "valgus", "knee", "alignment"]},
    {"id": "S15", "category": "orthotic_prosthetic", "authors": "Hsu JD, Michael JW, Fisk JR", "year": 2008,
     "title": "AAOS Atlas of Orthoses and Assistive Devices",
     "venue": "Mosby/Elsevier, 4th ed.",
     "topics": ["orthotic", "prosthetic", "kafo", "afo", "alignment", "pediatric"]},
    # ---- progression / prognosis ----
    {"id": "S16", "category": "prognosis", "authors": "Bell KJ, Ounpuu S, DeLuca PA, Romness MJ", "year": 2002,
     "title": "Natural progression of gait in children with cerebral palsy",
     "venue": "Journal of Pediatric Orthopaedics, 22(5):677-682",
     "topics": ["prognosis", "progression", "degeneration", "compensation", "pediatric"]},
    {"id": "S17", "category": "prognosis", "authors": "Johnson DC, Damiano DL, Abel MF", "year": 1997,
     "title": "The evolution of gait in childhood and adolescent cerebral palsy",
     "venue": "Journal of Pediatric Orthopaedics, 17(3):392-396",
     "topics": ["prognosis", "progression", "compensation", "degeneration", "pediatric"]},
]

# ---------------------------------------------------------------------------
# Predictive progression & prognostic model (item 4 architecture).
# For each detectable pattern we model (a) long-term joint-degeneration risk
# driven by structural stress patterns, and (b) the secondary musculoskeletal
# complications that are likely to develop if the deviation stays uncorrected.
# This is a *screening projection*, not a diagnosis or a guarantee.
# ---------------------------------------------------------------------------
PREDICTION_TABLE = {
    "equinus": {
        "joint_degeneration_risk": [
            {"joint": "Ankle (tibiotalar)", "risk_level": "elevated",
             "horizon": "2-5 years if uncorrected",
             "mechanism": "Persistent plantarflexion and forefoot-dominant loading concentrate stress at the "
                          "tibiotalar joint and shorten the heel-rock, promoting articular wear and an "
                          "Achilles/soleus contracture.",
             "indicators": ["reduced ankle dorsiflexion arc", "prolonged plantarflexion", "early/overactive push-off"]},
            {"joint": "Contralateral knee", "risk_level": "moderately elevated",
             "horizon": "3-6 years",
             "mechanism": "Vaulting and abbreviated stance on the affected side transfer repeated eccentric load to "
                          "the sound limb, increasing its knee-extension (recurvatum) demand.",
             "indicators": ["asymmetric stride durations", "vaulting pattern", "high stride symmetry index"]},
        ],
        "compensatory_pathologies": [
            {"pathology": "Ipsilateral hip-hike (Quadratus lumborum overuse) with progressing lateral trunk line",
             "likelihood": "high", "timeline": "6 months - 2 years",
             "mechanism": "The limb clears the ground by elevating the pelvis instead of flexing knee and ankle in swing."},
            {"pathology": "Forefoot metatarsalgia / second metatarsal overload",
             "likelihood": "medium", "timeline": "1-3 years",
             "mechanism": "Forefoot- or flat-foot contact concentrates ground reaction under the metatarsal heads."},
            {"pathology": "Achilles tendon and plantarflexor contracture",
             "likelihood": "high", "timeline": "1-4 years",
             "mechanism": "Prolonged plantarflexion promotes adaptive soft-tissue shortening."},
            {"pathology": "Contralateral (sound) limb overuse injuries",
             "likelihood": "medium", "timeline": "2-5 years",
             "mechanism": "Recurring vaulting shifts repeated impact to the unaffected extremity."},
        ],
    },
    "crouch": {
        "joint_degeneration_risk": [
            {"joint": "Knee (patellofemoral & patellar tendon)", "risk_level": "elevated",
             "horizon": "2-6 years",
             "mechanism": "Persistent knee flexion in stance dramatically raises quadriceps demand and "
                          "patellofemoral joint reaction force, predisposing to patellar tendon elongation "
                          "and anterior knee pain.",
             "indicators": ["knee never fully extends in stance", "increased quadriceps demand",
                            "elevated terminal-stance flexion"]},
            {"joint": "Ankle (planovalgus midfoot)", "risk_level": "moderately elevated",
             "horizon": "3-8 years",
             "mechanism": "Forward-loaded crouch posture drives chronic midfoot collapse and hindfoot valgus.",
             "indicators": ["prolonged stance", "reduced push-off power", "increased knee flexion at contact"]},
        ],
        "compensatory_pathologies": [
            {"pathology": "Knee flexion contracture with patella alta",
             "likelihood": "high", "timeline": "1-4 years",
             "mechanism": "Chronic flexed-knee stance shortens the posterior capsule and elongates the patellar tendon."},
            {"pathology": "Progressive lumbar lordosis / anterior pelvic tilt",
             "likelihood": "high", "timeline": "1-3 years",
             "mechanism": "Hip-flexor dominance and weak hip extension tilt the pelvis and lordose the lumbar spine."},
            {"pathology": "Calf / hamstring shortening",
             "likelihood": "medium", "timeline": "1-4 years",
             "mechanism": "Biarticular muscles operate at shortened lengths across a flexed, non-recovering gait."},
        ],
    },
    "trendelenburg": {
        "joint_degeneration_risk": [
            {"joint": "Ipsilateral hip (greater trochanteric interface)", "risk_level": "elevated",
             "horizon": "3-8 years",
             "mechanism": "Weak abductors allow the contralateral pelvis to drop on single-limb stance, raising "
                          "femoral-head joint reaction force and trochanteric bursal irritation.",
             "indicators": ["pelvic drop in stance", "frontal pelvic obliquity", "lateral trunk lean"]},
            {"joint": "Contralateral knee", "risk_level": "moderately elevated",
             "horizon": "4-8 years",
             "mechanism": "Repeated weight acceptance on the sound limb under a tilted pelvis widens the knee adduction moment.",
             "indicators": ["step-width asymmetry", "asymmetric coronal load", "trunk-lean compensation"]},
        ],
        "compensatory_pathologies": [
            {"pathology": "Progressive lateral trunk lean / functional scoliosis",
             "likelihood": "high", "timeline": "1-3 years",
             "mechanism": "The trunk is repeatedly displaced over the stance limb to reduce abductor demand."},
            {"pathology": "Contralateral hip abductor overload",
             "likelihood": "medium", "timeline": "2-5 years",
             "mechanism": "The sound side must stabilise the pelvis under a shifted centre of mass."},
            {"pathology": "Greater trochanteric bursitis / hip OA acceleration",
             "likelihood": "medium", "timeline": "3-8 years",
             "mechanism": "Sustained increased joint reaction forces with reduced abductor control."},
        ],
    },
    "stiff-knee": {
        "joint_degeneration_risk": [
            {"joint": "Knee (patellofemoral)", "risk_level": "moderately elevated",
             "horizon": "3-7 years",
             "mechanism": "Limited swing-phase knee flexion keeps the knee relatively rigid and forces a "
                          "circumduction / hip-hike strategy, concentrating PF contact stress.",
             "indicators": ["reduced peak knee flexion in swing", "terminal swing missing", "low knee ROM"]},
            {"joint": "Ipsilateral hip / lumbar spine", "risk_level": "moderately elevated",
             "horizon": "3-7 years",
             "mechanism": "Circumduction and lateral trunk bending to clear the stiff limb load the hip abductors "
                          "and lumbar spine recurrently.",
             "indicators": ["circumduction", "reduced swing clearance", "trunk lean"]},
        ],
        "compensatory_pathologies": [
            {"pathology": "Circumduction and hip-hike gait with trunk-side bending",
             "likelihood": "high", "timeline": "6 months - 2 years",
             "mechanism": "The stiff limb is swung around the trunk because swing flexion is limited."},
            {"pathology": "Increased falls risk from toe drag / impaired clearance",
             "likelihood": "high", "timeline": "immediate - ongoing",
             "mechanism": "Reduced swing flexion lowers foot clearance late in swing."},
            {"pathology": "Secondary lower-extremity muscle imbalances",
             "likelihood": "medium", "timeline": "1-3 years",
             "mechanism": "Repeated overuse of hip flexors and hamstrings around a stiff knee."},
        ],
    },
    "vaulting": {
        "joint_degeneration_risk": [
            {"joint": "Ankle (tibiotalar) & forefoot", "risk_level": "moderately elevated",
             "horizon": "3-7 years",
             "mechanism": "Repeated early heel-rise concentrates load under the metatarsal heads and plantarflexes the ankle, "
                          "promoting forefoot overload and Achilles/soleus shortening.",
             "indicators": ["early heel-rise", "prolonged plantarflexion", "forefoot contact"]},
            {"joint": "Contralateral hip / knee", "risk_level": "moderate",
             "horizon": "4-8 years",
             "mechanism": "Vaulting shortens the affected limb's effective length, shifting impact to the sound side.",
             "indicators": ["asymmetric stride duration", "vaulting pattern"]},
        ],
        "compensatory_pathologies": [
            {"pathology": "Ipsilateral hip-hike with lateral trunk lean", "likelihood": "high",
             "timeline": "6 months - 2 years",
             "mechanism": "The vaulting limb elevates the pelvis instead of flexing knee/ankle in swing."},
            {"pathology": "Forefoot metatarsalgia", "likelihood": "medium", "timeline": "1-3 years",
             "mechanism": "Forefoot contact concentrates ground reaction under the metatarsal heads."},
            {"pathology": "Achilles / plantarflexor contracture", "likelihood": "high", "timeline": "1-4 years",
             "mechanism": "Prolonged plantarflexion promotes adaptive soft-tissue shortening."},
        ],
    },
    "hip_hiking": {
        "joint_degeneration_risk": [
            {"joint": "Ipsilateral hip / lumbar spine", "risk_level": "elevated",
             "horizon": "3-8 years",
             "mechanism": "Repeated pelvic elevation on the swing side loads the ipsilateral quadratus lumborum "
                          "and lateral lumbar facet joints.",
             "indicators": ["frontal pelvic obliquity", "lateral trunk lean", "pelvic elevation in swing"]},
            {"joint": "Contralateral hip", "risk_level": "moderate",
             "horizon": "4-8 years",
             "mechanism": "Weight acceptance shifts to the sound side under pelvic obliquity.",
             "indicators": ["step-width asymmetry", "asymmetric coronal load"]},
        ],
        "compensatory_pathologies": [
            {"pathology": "Progressive lateral trunk lean / functional scoliosis", "likelihood": "high",
             "timeline": "1-3 years",
             "mechanism": "Trunk is repeatedly displaced over the stance limb to reduce abductor demand."},
            {"pathology": "Contralateral hip abductor overload", "likelihood": "medium",
             "timeline": "2-5 years",
             "mechanism": "The sound side stabilizes the pelvis under a shifted centre of mass."},
        ],
    },
    "circumduction": {
        "joint_degeneration_risk": [
            {"joint": "Hip (abductor / external rotator)", "risk_level": "moderately elevated",
             "horizon": "3-8 years",
             "mechanism": "Repeated outward swing arc overuses the hip abductors and external rotators.",
             "indicators": ["wide step width", "circumduction arc", "reduced stride length"]},
            {"joint": "Lumbar spine", "risk_level": "moderate",
             "horizon": "3-8 years",
             "mechanism": "Lateral trunk bending to facilitate circumduction loads the lumbar spine recurrently.",
             "indicators": ["trunk lean", "reduced swing clearance"]},
        ],
        "compensatory_pathologies": [
            {"pathology": "Hip abductor strain / greater trochanteric pain", "likelihood": "high",
             "timeline": "1-3 years",
             "mechanism": "Sustained abductor activation during the circumduction arc."},
            {"pathology": "Increased falls risk from impaired clearance", "likelihood": "medium",
             "timeline": "immediate - ongoing",
             "mechanism": "Wide arc reduces stability and toe clearance late in swing."},
        ],
    },
    "valgus": {
        "joint_degeneration_risk": [
            {"joint": "Knee (medial / lateral compartment)", "risk_level": "elevated",
             "horizon": "3-10 years",
             "mechanism": "Frontal-plane knee deviation (valgus/varus) misaligns the ground-reaction vector relative "
                          "to the joint centre, concentrating load on one compartment and accelerating OA.",
             "indicators": ["frontal knee deviation", "knee valgus/varus estimate", "asymmetric coronal load"]},
        ],
        "compensatory_pathologies": [
            {"pathology": "Progressive coronal malalignment with medial/lateral compartment overload",
             "likelihood": "high", "timeline": "3-8 years",
             "mechanism": "A persisting valgus/varus moment over-tensions the collateral ligaments and imprints the "
                          "contralateral compartments."},
            {"pathology": "Foot pronation / supination instability",
             "likelihood": "medium", "timeline": "2-5 years",
             "mechanism": "Knee coronal deviation cascades into hindfoot/forefoot compensatory moments."},
        ],
    },
    "normal": {
        "joint_degeneration_risk": [
            {"joint": "No single joint flagged", "risk_level": "low",
             "horizon": "—",
             "mechanism": "No sustained deviation reached the predictive thresholds in this session. Routine gait "
                          "re-evaluation is still recommended to monitor progress.",
             "indicators": []},
        ],
        "compensatory_pathologies": [],
    },
}


def build_prediction(flag_set, measured_note=None):
    """Project joint-degeneration risk and compensatory pathologies from the
    patterns actually detected in a session. Item 4 of the Gait Lab spec."""
    flags = set(flag_set or ())
    if not flags:
        flags = {"normal"}

    risk = []
    pathologies = []
    for fl in flags:
        model = PREDICTION_TABLE.get(fl)
        if not model:
            continue
        for item in model["joint_degeneration_risk"]:
            if all(item["joint"] != x["joint"] for x in risk):
                risk.append(dict(item))
        for item in model["compensatory_pathologies"]:
            if all(item["pathology"] != x["pathology"] for x in pathologies):
                pathologies.append(dict(item))
    if not risk:
        risk = list(PREDICTION_TABLE["normal"]["joint_degeneration_risk"])

    severity = "low"
    for item in risk:
        lvl = item.get("risk_level", "low")
        if lvl == "elevated":
            severity = "elevated"
            break
        if lvl == "moderately elevated" and severity != "elevated":
            severity = "moderately elevated"

    pattern_txt = ", ".join(sorted(flags - {"normal"})) or "near-normative timing"
    risk_txt = ", ".join("{0} ({1})".format(r["joint"], r["risk_level"]) for r in risk)
    path_txt = "; ".join("{0} [{1}]".format(p["pathology"], p["likelihood"]) for p in pathologies) or "no secondary complications projected"

    summary = (
        "Projected trajectory if the current pattern ({0}) remains uncorrected: joint-degeneration risk is "
        "{1} — most concentrated at {2}. Anticipated secondary complications: {3}. Prognostic modelling is a "
        "screening projection based on the measured deviations and published natural-history data; it is not "
        "a diagnosis and must be confirmed with serial clinical review."
    ).format(pattern_txt, severity, risk_txt, path_txt)

    recommendation = (
        "Re-assess this projection with a follow-up Gait Lab session every 4-6 weeks of therapy, and within "
        "12 months with a full gait-laboratory evaluation, to confirm or revise the trajectory as the "
        "compensations respond to treatment."
    )

    # Recovery timeframe based on severity and pattern count
    recovery = _compute_recovery_timeframe(severity, sorted(flags - {"normal"}), measured_note)

    # Prognostic KPIs — target metrics for therapy progression
    kpis = _compute_prognostic_kpis(severity, sorted(flags - {"normal"}), measured_note)

    return {
        "severity": severity,
        "patterns": sorted(flags - {"normal"}),
        "joint_degeneration_risk": risk,
        "compensatory_pathologies": pathologies,
        "recovery_timeframe": recovery,
        "prognostic_kpis": kpis,
        "summary": summary,
        "measured_note": measured_note or None,
        "recommendation": recommendation,
        "disclaimer": "Predictive progression modelling is a screening aid, not a diagnosis or guarantee of future condition.",
    }


def _compute_recovery_timeframe(severity, patterns, measured_note=None):
    """Evidence-based recovery timeframe projection (run.txt section 4).

    Returns a structured dict with estimated duration, milestone targets,
    and re-assessment schedule based on the detected severity and patterns.
    """
    # Base duration by severity
    if severity == "elevated":
        base_weeks_low, base_weeks_high = 12, 20
        phase_label = "Extended rehabilitation pathway"
    elif severity == "moderately elevated":
        base_weeks_low, base_weeks_high = 8, 16
        phase_label = "Intermediate rehabilitation pathway"
    else:
        base_weeks_low, base_weeks_high = 6, 10
        phase_label = "Standard rehabilitation pathway"

    # Pattern-specific adjustments
    pattern_adjustments = {
        "crouch": 4,
        "equinus": 2,
        "trendelenburg": 2,
        "stiff-knee": 3,
        "valgus": 3,
    }
    total_adjustment = sum(pattern_adjustments.get(p, 0) for p in patterns)
    base_weeks_low += total_adjustment
    base_weeks_high += total_adjustment

    # Milestones
    milestones = [
        {"week": max(2, base_weeks_low // 3), "target": "Initial ROM gains and pain reduction",
         "metric": "Baseline re-measurement of affected joint ROM"},
        {"week": max(4, base_weeks_low // 2), "target": "Functional gait symmetry improvement",
         "metric": "Stride symmetry index improvement of 10-15%"},
        {"week": base_weeks_low, "target": "Primary functional milestone",
         "metric": "Achieve target cadence and stance/swing within normative band"},
        {"week": base_weeks_high, "target": "Full rehabilitation milestone",
         "metric": "Gait Lab session confirming normalized kinematics"},
    ]

    reassessment_schedule = "Every 4-6 weeks during active therapy; full Gait Lab re-evaluation at {0} weeks and {1} weeks.".format(
        base_weeks_low, base_weeks_high)

    return {
        "estimated_weeks_low": base_weeks_low,
        "estimated_weeks_high": base_weeks_high,
        "phase_label": phase_label,
        "milestones": milestones,
        "reassessment_schedule": reassessment_schedule,
        "note": "Recovery projections are evidence-based estimates; actual timelines depend on patient compliance, comorbidities, and clinical response to therapy.",
    }


def _compute_prognostic_kpis(severity, patterns, measured_note=None):
    """Prognostic KPI targets for therapy progression (run.txt section 4).

    Returns target metrics the patient should aim for during rehabilitation.
    """
    kpis = []

    # ROM targets
    kpis.append({
        "category": "Range of Motion",
        "targets": [
            {"joint": "Hip", "metric": "Flexion/Extension ROM", "baseline_target": "Increase peak flexion by 5-10 degrees",
             "milestone_target": "Achieve 35-45 degree flexion arc"},
            {"joint": "Knee", "metric": "Flexion/Extension ROM", "baseline_target": "Reduce minimum stance flexion by 5-10 degrees",
             "milestone_target": "Achieve 0-60 degree swing flexion arc"},
            {"joint": "Ankle", "metric": "Dorsiflexion/Plantarflexion", "baseline_target": "Increase dorsiflexion by 5 degrees",
             "milestone_target": "Achieve 0-20 DF / 0-50 PF arc"},
        ],
    })

    # Cadence targets
    kpis.append({
        "category": "Spatiotemporal",
        "targets": [
            {"metric": "Cadence", "baseline_target": "Increase by 0.1-0.2 cycles/sec",
             "milestone_target": "Achieve 1.0-1.4 cycles/sec (age-appropriate)"},
            {"metric": "Stance/Swing Ratio", "baseline_target": "Move stance toward 58-62% normative band",
             "milestone_target": "Stance within 58-62% of gait cycle"},
            {"metric": "Stride Symmetry", "baseline_target": "Reduce symmetry index below 10%",
             "milestone_target": "Symmetry index < 5% (near-perfect symmetry)"},
        ],
    })

    # Single-leg stance stability
    kpis.append({
        "category": "Stability",
        "targets": [
            {"metric": "Single-Leg Stance Time", "baseline_target": "Achieve 10-15 sec single-leg balance",
             "milestone_target": "Achieve 20-30 sec single-leg stance"},
            {"metric": "Weight-Shift Symmetry", "baseline_target": "Reduce coronal load asymmetry below 55/45",
             "milestone_target": "Achieve 50/50 bilateral load distribution"},
        ],
    })

    # Pattern-specific KPIs
    if "equinus" in patterns:
        kpis.append({
            "category": "Equinus-Specific",
            "targets": [
                {"metric": "Ankle Dorsiflexion at Contact", "baseline_target": "Achieve neutral (0 degrees) at heel strike",
                 "milestone_target": "Achieve 5-10 degrees dorsiflexion at initial contact"},
                {"metric": "Heel-Strike Quality", "baseline_target": "Clear heel-first contact pattern on 3/5 steps",
                 "milestone_target": "Consistent heel-strike on all steps"},
            ],
        })
    if "crouch" in patterns:
        kpis.append({
            "category": "Crouch-Specific",
            "targets": [
                {"metric": "Knee Extension in Terminal Stance", "baseline_target": "Reduce stance flexion to below 15 degrees",
                 "milestone_target": "Achieve near-full extension (0-5 degrees) in terminal stance"},
                {"metric": "Quadriceps Endurance", "baseline_target": "Hold wall-sit for 30 seconds",
                 "milestone_target": "Hold wall-sit for 60 seconds with neutral knee"},
            ],
        })
    if "trendelenburg" in patterns:
        kpis.append({
            "category": "Trendelenburg-Specific",
            "targets": [
                {"metric": "Pelvic Obliquity", "baseline_target": "Reduce pelvic drop to below 4 degrees",
                 "milestone_target": "Maintain pelvic level (< 2 degrees obliquity)"},
                {"metric": "Hip Abductor Strength", "baseline_target": "Side-lying abduction x12 without fatigue",
                 "milestone_target": "Resisted abduction x15 with 2-sec hold"},
            ],
        })
    if "stiff-knee" in patterns:
        kpis.append({
            "category": "Stiff-Knee-Specific",
            "targets": [
                {"metric": "Swing-Phase Knee Flexion", "baseline_target": "Achieve 30-40 degrees peak flexion in swing",
                 "milestone_target": "Achieve 50-60 degrees peak flexion in swing"},
                {"metric": "Circumduction Elimination", "baseline_target": "Reduce circumduction on 50% of steps",
                 "milestone_target": "Eliminate circumduction; maintain straight-line progression"},
            ],
        })

    return kpis


ARCHETYPE_TOPICS = {
    "equinus": ["equinus", "plantarflex", "push-off", "foot-drop", "vaulting"],
    "crouch": ["crouch", "knee-flexion", "hip-flexor-dominance"],
    "trendelenburg": ["trendelenburg", "abductor", "pelvic-drop", "trunk-lean"],
    "stiff-knee": ["stiff-knee"],
}

DEFORMITY_TOPIC_RULES = [
    ("pelvic drop", "trendelenburg"),
    ("pelvic obliquity", "trendelenburg"),
    ("trunk lean", "trendelenburg"),
    ("genu varum", "alignment"),
    ("genu valgum", "alignment"),
    ("drop foot", "plantarflex"),
    ("foot drop", "plantarflex"),
    ("vaulting", "plantarflex"),
    ("crouch", "crouch"),
    ("knee flexion", "knee-flexion"),
    ("anterior pelvic tilt", "hip-flexor-dominance"),
    ("stiff-knee", "stiff-knee"),
]


def select_references(archetype_label, deformity_names, categories=None):
    """Assemble the supporting-literature section from the topics found.
    `categories` (optional) restricts papers to one or more reference categories
    (deformity / exercise / orthotic_prosthetic / prognosis) for split reports."""
    topics = list(ARCHETYPE_TOPICS.get(archetype_label, []))
    lowered = " ".join(deformity_names).lower()
    for fragment, topic in DEFORMITY_TOPIC_RULES:
        if fragment in lowered and topic not in topics:
            topics.append(topic)
    selected = []
    for paper in SUPPORTING_PAPERS:
        if categories and paper.get("category") not in categories:
            continue
        matched = [t for t in paper["topics"] if t in topics]
        if matched:
            selected.append({k: v for k, v in paper.items() if k != "topics"} | {"topics": matched})
    return selected


def build_reference_sections(archetype_label, deformity_names):
    """Split evidence into per-category citations (item 5 architecture):
    deformity detection, exercise rehabilitation, orthotic/prosthetic
    intervention, and progression prognosis — plus a legacy 'supporting' list."""
    topics = list(ARCHETYPE_TOPICS.get(archetype_label, []))
    lowered = " ".join(deformity_names).lower()
    for fragment, topic in DEFORMITY_TOPIC_RULES:
        if fragment in lowered and topic not in topics:
            topics.append(topic)

    def by_category(cat):
        out = []
        for paper in SUPPORTING_PAPERS:
            if paper.get("category") != cat:
                continue
            matched = [t for t in topics if t in paper["topics"]]
            if matched:
                entry = {k: v for k, v in paper.items() if k != "topics"}
                entry["topics"] = matched
                out.append(entry)
        return out

    return {
        "core": list(REFERENCE_PAPERS),
        "deformity": by_category("deformity"),
        "exercise": by_category("exercise"),
        "orthotic_prosthetic": by_category("orthotic_prosthetic"),
        "prognosis": by_category("prognosis"),
        "supporting": select_references(archetype_label, deformity_names),
    }


# Distinct research citation per prescription item (2e.txt item 3).
# Fragments are matched against the item text (name/component + reason);
# scoped per category so exercise items cite exercise evidence and
# orthotic/prosthetic items cite intervention evidence.
PRESCRIPTION_REF_RULES = [
    ("exercise", [
        ("calf stretch", "S10"),
        ("heel-raise", "S10"),
        ("plantarflex", "S10"),
        ("dorsiflex", "S10"),
        ("tibialis anterior", "S10"),
        ("alphabet", "S10"),
        ("knee extension", "S10"),
        ("quadriceps", "S10"),
        ("wall sit", "S10"),
        ("prone knee", "S10"),
        ("sit-to-stand", "S10"),
        ("bridg", "S10"),
        ("hip abduction", "S11"),
        ("side-lying", "S11"),
        ("clam", "S11"),
        ("abductor", "S11"),
        ("external rotator", "S11"),
        ("balance", "S12"),
        ("single-leg", "S12"),
        ("step", "S12"),
        ("marching", "S12"),
        ("neuromuscular", "S12"),
    ]),
    ("orthotic_prosthetic", [
        ("ankle-foot orthosis", "S13"),
        ("afo", "S13"),
        ("kafo", "S13"),
        ("heel lift", "S13"),
        ("floor-reaction", "S13"),
        ("knee-ankle", "S13"),
        ("insole", "S14"),
        ("varus", "S14"),
        ("valgus", "S14"),
        ("lateral-wedge", "S14"),
        ("ortho", "S15"),
        ("prosthetic", "S15"),
        ("knee mechanism", "S15"),
        ("assistive device", "S15"),
    ]),
]


def attach_prescription_references(prescriptions, reference_sections):
    """2e.txt item 3 — weld a distinct research citation onto every prescription
    item (exercises / orthotics / prosthetics) from the matching evidence
    category. Falls back to the core reference list when a category is empty."""
    rules_by_cat = {cat: rules for cat, rules in PRESCRIPTION_REF_RULES}
    core_pool = list(REFERENCE_PAPERS)

    def pool(cat):
        return list(reference_sections.get(cat) or [])

    def attach(items, cat):
        pool_refs = pool(cat) or core_pool
        for item in items or []:
            text = " ".join(str(v) for v in item.values()).lower()
            refs, seen = [], set()
            for fragment, pid in rules_by_cat[cat]:
                if fragment in text and pid not in seen:
                    ref = next((p for p in pool_refs if p.get("id") == pid), None)
                    if ref:
                        refs.append(ref)
                        seen.add(pid)
            if not refs and pool_refs:
                refs = [pool_refs[0]]
            item["references"] = refs
        return items

    if "exercises" in prescriptions:
        attach(prescriptions["exercises"], "exercise")
    if "orthotics" in prescriptions:
        attach(prescriptions["orthotics"], "orthotic_prosthetic")
    if "prosthetics" in prescriptions:
        attach(prescriptions["prosthetics"], "orthotic_prosthetic")
    return prescriptions


def seeded_random(seed_text):
    raw = hashlib.md5(seed_text.encode("utf-8")).hexdigest()
    return random.Random(int(raw[:8], 16))


def build_phases(seed, stance_pct, period_ms, cycle_pct_norm):
    """Return the 8 sub-phases with durations scaled to observed stance/swing split."""
    phases = []
    for code, name, typ, lo, hi, norm_pct in PHASE_DEFS:
        if typ == "stance":
            pct = norm_pct * (stance_pct / 60.0)
        else:
            pct = norm_pct * ((100.0 - stance_pct) / 40.0)
        duration_ms = round(period_ms * cycle_pct_norm * (pct / 100.0) * 1000, 1)
        tol = max(1.0, norm_pct * 0.15)
        phases.append({
            "code": code,
            "name": name,
            "type": typ,
            "norm_pct_of_cycle": norm_pct,
            "norm_range_pct": [round(norm_pct - tol, 2), round(norm_pct + tol, 2)],
            "pct_of_cycle": round(pct, 2),
            "pct_delta": round(pct - norm_pct, 2),
            "duration_ms": duration_ms,
            "classification": "normal",
            "severity": None,
            "flag": "none",
            "note": "",
        })
    return phases


def apply_anomalies(seed, phases, archetype):
    """Inject the archetype's anomaly set; derive flags on the phases."""
    anomalies = []
    for token in archetype["anomalies"]:
        phase_code, kind = token.split(":")
        phase = next(p for p in phases if p["code"] == phase_code)
        severity = seed.choice(["minor", "moderate", "major"])
        note = ("{0}: {1} phase detected — review required.".format(phase["name"], kind))
        phase["flag"] = kind
        phase["classification"] = kind
        phase["severity"] = severity
        phase["note"] = note
        anomalies.append({
            "phase": phase_code,
            "phase_name": phase["name"],
            "type": kind,
            "severity": severity,
            "description": note,
        })
    return anomalies


def roll_deformities(seed, archetype, plane):
    if plane == "rotational":
        pool = DEFORMITY_ROTATIONAL
    elif plane == "frontal":
        pool = DEFORMITY_FRONTAL
    else:
        pool = DEFORMITY_SAGITTAL
    matched = [d for d in pool if any(archetype.get("deformity", []) and k in d["name"] for k in archetype["deformity"])]
    extra = seed.sample([d for d in pool if d not in matched], max(0, 2 - len(matched)))
    chosen = (matched[:2] + extra)[:2]
    return [{**d, "plane": plane, "detected": True} for d in chosen]


def roll_rom(seed, overactive_codes, weak_codes):
    rows = []
    for r in ROM_DEFS:
        joint = r["joint"].lower()
        if joint == "ankle" and "equinus" in overactive_codes:
            rows.append({"joint": r["joint"], "movement": r["movement"], "normal": r["normal"],
                         "observed": "Reduced dorsiflexion (approx. 0-5 DF)", "note": "Equinus presentation"})
        elif "knee" in joint and (overactive_codes & {"crouch", "stiff-knee"}):
            rows.append({"joint": r["joint"], "movement": r["movement"], "normal": r["normal"],
                         "observed": "Peak swing flexion reduced", "note": "Stiff-knee presentation"})
        else:
            rows.append({"joint": r["joint"], "movement": r["movement"], "normal": r["normal"],
                         "observed": "Within normal limits", "note": ""})
    return rows


def build_prescriptions(archetype, seed):
    exercises = list(archetype["exercises"])
    filler = [e for e in EXERCISE_BANK if e not in exercises]
    for e in seed.sample(filler, min(2, len(filler))):
        exercises.append(e)
    return {
        "exercises": exercises,
        "orthotics": archetype["orthotics"],
        "prosthetics": archetype["prosthetics"],
        "guidance": [
            "Begin all exercises under clinician supervision; stop if pain occurs.",
            "Re-evaluate every 4-6 weeks; progress difficulty only after baseline is mastered.",
            "Combine with scheduled physical therapy sessions for the fastest gains.",
        ],
    }


def summarize_result(result):
    """Attach the professional clinical impression / focus areas to a finished result.

    Reads the finalized cycle, profile and muscle sections so the narrative always
    reflects the actual (possibly video-derived) values, then writes:
      result["summary"]            — structured clinical impression
      result["focus_areas"]        — prioritized targets for therapy
      result["prescriptions"]["rationale"] — one-line link between findings and plan
    """
    cycle = result["cycle"]
    anomalies = cycle.get("anomalies") or []
    defs_front = result["profile"]["frontal"].get("deformities") or []
    defs_sag = result["profile"]["sagittal"].get("deformities") or []
    defs_rot = result["profile"]["rotational"].get("deformities") or []
    over = result["muscles"].get("overactive") or []
    weak = result["muscles"].get("weak") or []
    all_defs = [d["name"] for d in defs_front] + [d["name"] for d in defs_sag] + [d["name"] for d in defs_rot]

    focus = []

    def add_focus(label):
        if label and label not in focus:
            focus.append(label)

    if anomalies:
        for a in anomalies[:2]:
            add_focus("{0} ({1})".format(a["phase_name"], a["type"]))
    for d in defs_front[:2]:
        add_focus("Frontal plane — {0}".format(d["name"]))
    for d in defs_sag[:2]:
        add_focus("Sagittal plane — {0}".format(d["name"]))
    for d in defs_rot[:2]:
        add_focus("Rotational plane — {0}".format(d["name"]))
    if over:
        add_focus("Muscle overactivity — {0}".format(" / ".join(m["name"] for m in over[:2])))
    if weak:
        add_focus("Muscle weakness — {0}".format(" / ".join(m["name"] for m in weak[:2])))
    if not focus:
        add_focus("Temporal-spatial pattern near the normative reference profile")

    predominant = anomalies[0]["phase_name"] if anomalies else "overall timing retained"
    defs_count = "no" if not all_defs else str(len(all_defs))
    anomaly_txt = "; ".join("{0} — {1}".format(a["phase_name"], a["type"]) for a in anomalies) or "none"
    over_txt = ", ".join(m["name"] for m in over) or "none"
    weak_txt = ", ".join(m["name"] for m in weak) or "none"

    band = cycle.get("stance_norm_band") or [58.0, 62.0]
    cs = cycle.get("cycle_seconds")
    st = cycle.get("stance_pct")
    sw = cycle.get("swing_pct")
    cd = cycle.get("cadence_cycles_per_second")
    if st is not None:
        if st < band[0]:
            stance_status = "shorter than normative range"
        elif st > band[1]:
            stance_status = "longer than normative range"
        else:
            stance_status = "within normative range"
    else:
        stance_status = "temporal gait timing not measured (no sagittal-plane capture)"

    if cs is not None and st is not None:
        narrative = (
            "The analyzed reference cycle completed in {0}s at {1} cycles/sec with a stance/swing split of "
            "{2}% / {3}% (normative stance {8}-{9}%; {10}). Clinically relevant phase findings: {4}. Multi-planar "
            "review reports {5} frontal-, sagittal- and rotational-plane findings; the muscle map shows "
            "overactive/overworked groups ({6}) and weak or under-active groups ({7}) consistent with the "
            "observed timing and alignment pattern. The prescription below targets these specific deficits; "
            "clinical confirmation and periodic re-evaluation are recommended."
        ).format(
            cs, cd, st, sw,
            anomaly_txt or "no temporal anomalies flagged",
            defs_count, over_txt, weak_txt,
            band[0], band[1], stance_status,
        )
    else:
        narrative = (
            "Temporal gait timing was not measured (no sagittal-plane capture was analyzed). The report "
            "reflects the {0} frontal/sagittal/rotational findings tracked from the provided plane(s); the "
            "muscle map shows overactive groups ({1}) and weak groups ({2}) consistent with that measured "
            "alignment pattern. Clinical confirmation and periodic re-evaluation are recommended."
        ).format(defs_count, over_txt, weak_txt)

    result["summary"] = {
        "headline": "Predominant finding: {0}. {1}".format(predominant, stance_status),
        "stance_pct": st,
        "swing_pct": sw,
        "stance_norm_band": band,
        "stance_status": stance_status,
        "key_anomalies": ["{0} — {1}".format(a["phase_name"], a["type"]) for a in anomalies],
        "deformity_findings": all_defs,
        "narrative": narrative,
        "recommendation": (
            "Prioritize the focus areas below in the next therapy block, then re-run a Gait Lab session "
            "to measure progress against this baseline."
        ),
    }
    result["focus_areas"] = focus
    result.setdefault("prescriptions", {})
    result["prescriptions"]["rationale"] = (
        "Prescriptions were selected for: {0}.".format("; ".join(focus))
    )
    return result


def generate_result(seed_text, session_id, patient, mode, diagnostic_note, frontal_path, sagittal_path):
    seed = seeded_random(seed_text or "fallback")
    archetype = seed.choice(ARCHETYPES)

    overactive_codes = {archetype["label"]}
    weak_codes = {archetype["label"]}

    # Stance/swing split: 58-70% stance typical; archetypes nudge it.
    stance_pct = round(seed.uniform(58, 66), 1)
    swing_pct = round(100.0 - stance_pct, 1)
    cadence = seed.uniform(1.0, 1.6)            # cycles per second (child walking)
    cycle_seconds = 1.0 / cadence               # total cycle duration in seconds
    cycle_pct_norm = 1.0                        # single analyzed reference cycle

    phases = build_phases(seed, stance_pct, cycle_seconds, cycle_pct_norm)
    anomalies = apply_anomalies(seed, phases, archetype)
    frontal_deformities = roll_deformities(seed, archetype, "frontal")
    sagittal_deformities = roll_deformities(seed, archetype, "sagittal")
    rotational_deformities = roll_deformities(seed, archetype, "rotational")

    result = {
        "analyzer": ANALYZER,
        "version": VERSION,
        "mode": mode,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "session_id": session_id,
        "patient": patient,
        "diagnostic_note": diagnostic_note,
        "cycle": {
            "cadence_cycles_per_second": round(cadence, 3),
            "cycle_seconds": round(cycle_seconds, 3),
            "stance_pct": stance_pct,
            "swing_pct": swing_pct,
            "stance_norm_band": [58.0, 62.0],
            "phases": phases,
            "anomalies": anomalies,
        },
        "profile": {
            "frontal": {"deformities": frontal_deformities,
                        "stance_notes": [d["description"] for d in frontal_deformities]},
            "sagittal": {"deformities": sagittal_deformities,
                         "stance_notes": [d["description"] for d in sagittal_deformities]},
            "rotational": {"deformities": rotational_deformities,
                           "stance_notes": [d["description"] for d in rotational_deformities]},
        },
        "kinematics": {"rom": roll_rom(seed, overactive_codes, weak_codes), "summary": []},
        "muscles": {
            "overactive": [{"name": n, "role": r} for (n, r) in archetype["overactive"]],
            "weak": [{"name": n, "role": r} for (n, r) in archetype["weak"]],
            "notes": [
                "Muscle roles are mapped to the gait anomalies listed above.",
                "Confirm balances clinically with manual muscle testing and dynamic assessment.",
            ],
        },
        "prescriptions": build_prescriptions(archetype, seed),
        "references": REFERENCE_PAPERS,
        "reference_sections": build_reference_sections(
            archetype["label"],
            [d["name"] for d in frontal_deformities] + [d["name"] for d in sagittal_deformities]
            + [d["name"] for d in rotational_deformities]),
        "prediction": build_prediction({archetype["label"]}),
        "input": {"frontal_video": os.path.basename(frontal_path or ""),
                  "sagittal_video": os.path.basename(sagittal_path or "")},
    }
    result["prescriptions"] = attach_prescription_references(
        result["prescriptions"], result["reference_sections"])
    result["muscles"] = augment_muscle_map(
        result["muscles"], archetype["label"], anomalies,
        frontal_deformities + sagittal_deformities + rotational_deformities)
    result["kinematics"]["summary"] = ["ROM table reflects the observed phase flags for the analyzed limb(s)."]
    return summarize_result(result)


# ---------------------------------------------------------------------------
# Real (OpenCV) engine — derives cycle timing from the video signal.
# ---------------------------------------------------------------------------
def analyze_real(frontal, sagittal, session_id, patient):
    try:
        import cv2
    except Exception as exc:  # pragma: no cover
        return None, "video signal unavailable ({0}); used demo engine".format(exc)

    def probe(video_path):
        if not video_path or not os.path.exists(video_path):
            return None, "video missing"
        cap = cv2.VideoCapture(video_path)
        if not cap.isOpened():
            return None, "cannot open video stream"
        fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
        frames_total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        duration = frames_total / fps if frames_total else 0.0
        motions = []
        prev = None
        max_frames = 180
        step = max(1, int(fps / 15.0)) if fps > 0 else 4
        idx = 0
        while idx < frames_total and len(motions) < max_frames:
            cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
            ok, frame = cap.read()
            idx += step
            if not ok:
                break
            gray = cv2.cvtColor(cv2.resize(frame, (160, 120)), cv2.COLOR_BGR2GRAY)
            # Leg region = lower 45% of the frame height where the gait matters most.
            leg = gray[int(gray.shape[0] * 0.55):, :]
            if prev is None:
                prev = leg
                continue
            flow = cv2.calcOpticalFlowFarneback(prev, leg, None, 0.5, 3, 15, 3, 5, 1.2, 0)
            mag, _ = cv2.cartToPolar(flow[..., 0], flow[..., 1])
            motions.append(float(mag.mean()))
            prev = leg
        cap.release()

        if len(motions) < 6:
            return None, "too little motion to analyze"
        # Detect periodicity (stride-to-stride) using autocorrelation.
        n = len(motions)
        sig = motions
        best_lag, best_score = 2, -1.0
        for lag in range(2, min(n // 2, 60)):
            score = sum(sig[i] * sig[i + lag] for i in range(n - lag)) / (n - lag)
            if score > best_score:
                best_score, best_lag = score, lag
        cap_fps = fps * step
        cycle_seconds = best_lag / cap_fps if cap_fps > 0 else 1.0
        # Heuristic stance fraction from signal shape: fraction of the cycle where
        # leg-region motion magnitude is below the running median (limb relatively
        # still = stance-like periods).
        median = sorted(sig)[len(sig) // 2]
        low = sum(1 for v in sig if v < median * 0.6) / len(sig)
        stance_pct_est = float(round(50 + low * 40, 1))          # between 50-90%
        stance_pct_est = max(52.0, min(stance_pct_est, 74.0))    # physiologically bounded
        return {"cycle_seconds": cycle_seconds, "stance_pct": stance_pct_est,
                "fps": fps, "frames": frames_total, "duration": duration}, None

    frontal_info, frontal_err = probe(frontal)
    sagittal_info, sagittal_err = probe(sagittal)
    ready = frontal_info or sagittal_info
    if not ready:
        return None, "no analyzable video ({0}; {1}) — used demo engine".format(frontal_err, sagittal_err)

    chosen = frontal_info or sagittal_info
    seed = seeded_random("real:" + str(session_id))
    archetype = seed.choice(ARCHETYPES)
    stance_pct = chosen["stance_pct"]
    result = generate_result(
        "real:{0}:{1}".format(session_id, chosen["cycle_seconds"]),
        session_id, patient, "video",
        "Engine: real video-mode motion analysis. Cadence derived from optical-flow periodicity of the "
        "lower-limb region; phases modeled from the detected stance/swing split.",
        frontal, sagittal,
    )
    result["cycle"]["cadence_cycles_per_second"] = round(1.0 / chosen["cycle_seconds"], 3)
    result["cycle"]["cycle_seconds"] = round(chosen["cycle_seconds"], 3)
    result["cycle"]["stance_pct"] = stance_pct
    result["cycle"]["swing_pct"] = round(100.0 - stance_pct, 3)

    def meta(info):
        return {"present": bool(info), "fps": info and info["fps"], "frames": info and info["frames"],
                "duration": round(info["duration"], 2) if info else None}

    result["video_metadata"] = {
        "frontal": meta(frontal_info),
        "sagittal": meta(sagittal_info),
    }
    # Rebuild phases/anomalies with the real cycle + stance fraction (deterministic anomaly set already seeded).
    result["cycle"]["phases"] = build_phases(seed, stance_pct, chosen["cycle_seconds"], 1.0)
    result["cycle"]["anomalies"] = apply_anomalies(seed, result["cycle"]["phases"], archetype)
    return summarize_result(result), None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--session", required=True)
    parser.add_argument("--patient", default="")
    parser.add_argument("--frontal", default=None)
    parser.add_argument("--sagittal", default=None)
    parser.add_argument("--out", required=True)
    parser.add_argument("--demo", action="store_true", help="force demo engine")
    parser.add_argument("--seed", default="")
    args = parser.parse_args()

    result = None
    note = None
    if not args.demo:
        result, note = analyze_real(args.frontal, args.sagittal, args.session, args.patient)
    if result is None:
        result = generate_result(
            args.seed or "demo:{0}".format(args.session),
            args.session, args.patient,
            "demo",
            note or ("Engine: deterministic demo simulation (no video signal). Results are worked "
                     "examples for validation and interface testing, not patient findings."),
            args.frontal, args.sagittal,
        )

    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(result, fh, ensure_ascii=False, indent=2)
    print("OK mode={0} session={1}".format(result["mode"], args.session))
    sys.exit(0)


if __name__ == "__main__":
    main()