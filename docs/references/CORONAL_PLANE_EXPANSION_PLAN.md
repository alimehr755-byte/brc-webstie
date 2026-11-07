# Coronal Plane Pattern Expansion Plan

Based on: `11.docx` (Gait Lab Conditions: Anatomy, Pathophysiology and Pathology) and `22.docx` (Coronal Plane Abnormal Gait Predictions)

## Current State (Already Implemented in Coronal/Frontal Plane)
- Trendelenburg gait (pelvic obliquity > 4°)
- Compensatory trunk lean (> 8°)
- Varus/valgus knee alignment (knee valgus mean > 0.05 or tibiofemoral dev > 5°)
- Asymmetric loading (weight shift max > 0.25)
- Shoulder compensation (shoulder asymmetry > 0.12)
- Vaulting (ankle PF < -35°)
- Hip hiking (pelvic obliquity > 6°)
- Circumduction (step width mean > 0.35)

## New Patterns to Implement (from 11.docx + 22.docx)

### Phase 1: New Deformity/Pattern Detection in derive_clinical() (gait_lab.py)

1. **Scissoring gait** — step width mean < -0.15 (feet crossing midline) → adductor spasticity (CP)
   - Archetype: scissoring
   - Muscles: adductor longus/brevis/magnus (overactive), abductors (weak)
   - Prescriptions: adductor stretching, hip abductor strengthening, AFO

2. **Waddling gait** — bilateral pelvic obliquity > 4° AND step width > 0.25 → bilateral hip weakness (muscular dystrophy)
   - Archetype: waddling
   - Muscles: gluteus medius/minimus (weak bilaterally)
   - Prescriptions: bilateral hip abductor strengthening, weight management

3. **Steppage gait** — excessive hip hiking (> 6°) + knee flexion in swing → foot drop compensation (peroneal nerve)
   - Archetype: steppage
   - Muscles: tibialis anterior (weak), hip flexors (overactive)
   - Prescriptions: AFO, tibialis anterior strengthening, peroneal nerve assessment

4. **Antalgic gait** — asymmetric weight shift (> 0.3) + coronal load asymmetry (< 40%) → pain avoidance
   - Archetype: antalgic
   - Muscles: stance-side muscles (guarding), contralateral (overuse)
   - Prescriptions: pain management, offloading, weight-bearing assessment

5. **Ataxic gait** — high step width variability (step_width CV > 0.4) + wide base (> 0.3) → balance disorder
   - Archetype: ataxic
   - Muscles: trunk stabilizers (weak), cerebellar/vestibular dysfunction
   - Prescriptions: balance training, gait aid, wide-base footwear

6. **Rearfoot/calcaneal alignment** — ankle-foot angle deviation from vertical > 10°
   - Archetype: rearfoot (existing valgus/varus extended)
   - Detects: calcaneal eversion (pronation) or inversion (supination)
   - Prescriptions: orthotic correction, tibialis posterior/peroneal strengthening

7. **Knee adduction moment (KAM) estimation** — from knee valgus mean + weight shift
   - Surrogate KAM = knee_valgus_mean * weight_shift * body_mass
   - Risk stratification: low (< 0.5), moderate (0.5-1.0), high (> 1.0) N·m/kg
   - Feeds prediction model for medial knee OA risk

### Phase 2: New Archetypes in gait_analyzer.py
- Add: scissoring, waddling, steppage, antalgic, ataxic, rearfoot
- Each with: deformities, overactive/weak muscles, exercises, orthotics, structural weaknesses, prediction table entries

### Phase 3: New Deformity Screens in DEFORMITY_FRONTAL
- Scissoring, waddling, steppage, antalgic, ataxic, rearfoot alignment

### Phase 4: P&O Alignment Checks
- Prosthetic foot position (too far in/out)
- Socket adduction/abduction
- Lateral trunk lean over prosthesis
- Orthotic (AFO/KAFO) frontal plane alignment

### Phase 5: Tests
- Unit tests for new pattern detection thresholds
- Synthetic frontal metric tests

## Implementation Priority
1. Scissoring + Waddling (high clinical prevalence in CP)
2. Antalgic + Ataxic (common in clinic)
3. Steppage + Rearfoot (neuromuscular + foot)
4. KAM estimation (OA prediction)
5. P&O alignment (niche but valuable for P&O students)
