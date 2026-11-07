# Coronal Plane Research Portal — Plan

## Overview
A professional, ICRC/CMAS-standard research portal embedded in the BRC Gait Lab for analyzing gait patterns across populations using coronal plane metrics.

## Data Sources (from 11.docx + 22.docx + AutoGaitA README)

### Populations (from user diagnosis field)
- Cerebral palsy (diplegic, hemiplegic, quadriplegic)
- Autism spectrum disorder
- Epilepsy
- Amputee (transtibial, transfemoral)
- Stroke
- Parkinson's disease
- Muscular dystrophy
- Other neurological conditions

### Coronal Plane Metrics (15 per frame, from analyze_frontal())
- pelvic_obliquity_max, pelvic_obliquity_mean
- lateral_trunk_lean_max
- knee_valgus_off_max, knee_valgus_mean
- step_width_mean, weight_shift_max
- head_lateral_tilt_max, shoulder_drop_max
- shoulder_abduction_max_L/R, hip_abduction_lean_max_L/R
- shoulder_asymmetry_index, tibiofemoral (L/R angle/deviation/direction)
- coronal_load (symmetry_pct, heavier/lighter_side_load_pct, weight_shift_mean)
- ankle_foot_align (L/R)
- custom_angles (pelvic_obliquity, trunk_lean, knee_valgus, step_width, hip_abduction, shoulder_abduction, ankle_foot_align, head_lateral_tilt)

### Detected Patterns (from derive_clinical)
- Trendelenburg, trunk lean, varus/valgus, asymmetric loading, shoulder compensation
- Vaulting, hip hiking, circumduction
- Scissoring, waddling, steppage, antalgic, ataxic, rearfoot

### Reference Values (from 22.docx + cited sources)
- Pelvic obliquity: 0-4° normal (Perry & Burnfield 2010)
- Trunk lean: 0-3° normal (Whittle 2007)
- Knee valgus: 0-5° normal (Moreland 1987)
- Step width: 5-10 cm normal (Whittle 2007)

## Architecture

### Backend API Endpoints (to be created)
1. `GET /api/gait/research/populations` — population counts by diagnosis
2. `GET /api/gait/research/coronal` — aggregate coronal metrics by population
3. `GET /api/gait/research/compare` — compare coronal metrics between groups
4. `GET /api/gait/research/export` — export research data to CSV

### Frontend Research Portal Modal
- Tabbed interface: Joint | Population | Comparison | Results
- Joint selector dropdown
- Population checkboxes with counts
- Comparison controls (group 1 vs group 2)
- Results table with deltas and effect sizes
- Export to CSV

### Data Flow
1. User selects joint + population + metric
2. Backend queries gait_sessions WHERE status = 'analyzed'
3. Backend aggregates coronal metrics by population
4. Frontend displays population counts, comparison table, charts
5. User exports to CSV for research

## Implementation Phases

### Phase 1: Research Button + Modal (Frontend)
- Add "Research" button to gait.html
- Create modal with tabbed interface
- Joint selector, population selector, comparison controls, results panel

### Phase 2: Backend Research Endpoints
- GET /api/gait/research/populations
- GET /api/gait/research/coronal
- GET /api/gait/research/compare
- GET /api/gait/research/export

### Phase 3: Coronal Normal Bands
- Add cited reference values to frontal plots
- Label with source citations

### Phase 4: P&O Alignment Checks
- Prosthetic foot position check
- Socket alignment check
- Lateral trunk lean over prosthesis
- Orthotic (AFO/KAFO) frontal alignment

### Phase 5: Group Comparison UI
- Overlay charts for group comparison
- Delta table with effect sizes
- Export to CSV

### Phase 6: Command-Line Mode
- gaitlab research coronal --joint knee --population cp --metric pelvic_obliquity
- gaitlab research compare --group1 cp --group2 control --metric step_width
- gaitlab research export --format csv --joint knee --population cp

## Design Principles (from ICRC/CMAS/JMIR)
- ICRC: Standardized prosthetic gait analysis, quality of care
- CMAS: Clinical gait analysis standards, audit checklists, written protocols
- JMIR: Human-centered design (DIN EN ISO 9241-210), domain-based grouping, color-coded thresholds, longitudinal visualizations, configurable reference values, visual alerts for deviations, export options
- AutoGaitA: Cycle detection, normalisation, custom joints/angles, group comparison, condition comparison, universal 3D input

## Build Order
1. Research button + modal skeleton (frontend)
2. Group comparison endpoint (backend)
3. Research portal UI with joint/population selectors (frontend)
4. Coronal normal bands with cited references (backend + frontend)
5. P&O alignment checks (backend)
6. Command-line mode
7. Research export to CSV/Excel
8. Polish and test

## Open Decisions
1. Should the research portal be a separate page or a modal within gait.html?
2. Should group comparison be real-time (query DB on demand) or pre-computed?
3. Should normal bands use published normative data or clinic-specific reference data?
4. Should P&O alignment checks be automatic (from video) or manual (clinician input)?