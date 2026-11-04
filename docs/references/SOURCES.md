# BRC Gait Lab — Knowledge & Data Sources

Every normative value, cutoff, and classification rule used by the Gait Lab traces to one of these sources. Updated 2026-11-02.

## 1. Lecture decks (clinician-supplied)

Author: **Farhan Shah, M.Phil. (Public Health), BS P&O, Demonstrator P&O, Khyber Medical University (KMU), Peshawar**

| File | Content used by the engine |
|---|---|
| `lectures/motion analysis.pptx` | Framework of the 5 gait measurement systems (motion analysis, dynamic EMG, force plates, stride characteristics, energy cost) — adopted as the project scope boundary in spec §13. List of qualitative gait tests (Rancho Los Amigos Rating List, 6MWT, 2MWT, 10m walk, Dynamic Gait Index, Emory FAP, TUG, FAC, Tinetti) — used to define `scales_registry` stub set. |
| `lectures/Mobility Assessment Tools.pptx` | TUG protocol, observation checklist, population cutoffs (community 13.5 s, stroke 14 s, LE amputee 19 s, hip OA 10 s, vestibular 11.1 s, ≥12 s general). BBS 14-item method + interpretation (56 functional, <45 risk, ≤49 stroke). GMFCS-E&R five levels + five age bands + "classification, not diagnosis / cannot detect change over time" caveats + Family Report variant. |
| `lectures/GAIT.pptx` (113 slides) | Purposes of gait analysis; gait cycle formalism (60/40, double support); Rancho Los Amigos OGA (48 descriptors, GHORT); 6 determinants of gait incl. pelvic list norm <5°; pediatric development of gait (supported walking ≈39 cm/s, 44 cm stride, 65% stance; toddler hallmarks; Sutherland 5 determinants of mature gait); pathological gait catalog (TF amputation, foot drop, weak calf, gluteus medius, spastic hemiplegic, diplegic CP jump/crouch/stiff/recurvatum, aging, equinus/equinovalgus, toe deformities, joint instabilities). |

## 2. Peer-reviewed research (verified during integration)

| # | Citation | Used for |
|---|---|---|
| R1 | Shumway-Cook A, Brauer S, Woollacott M. *Predicting the probability for falls in community-dwelling older adults using the Timed Up & Go Test.* Phys Ther. 2000;80(9):896-903. | TUG ≥13.5 s rule-in cutoff (origin) |
| R2 | Barry E, Galvin R, Keogh C, Horgan F, Fahey T. *Is the Timed Up and Go test a useful predictor of risk of falls in community dwelling older adults: a systematic review and meta-analysis.* BMC Geriatr. 2014;14:14. (PMC3924230) | TUG limitations: Sn 0.31 / Sp 0.74 at 13.5 s; not standalone |
| R3 | Schoene D, et al. *Discriminative Ability and Predictive Validity of the Timed Up and Go Test in Identifying Older People Who Fall: Systematic Review and Meta-Analysis.* JAGS. 2013;61(2):202-208. | TUG of more value in lower-functioning cohorts |
| R4 | Bischoff HA, et al. *Identifying a cut-off point for normal mobility: a comparison of the timed 'up and go' test in community-dwelling and institutionalised elderly women.* Age Ageing. 2003;32(3):315-320. | 12 s community-dwelling normal cutoff |
| R5 | Berg K, Wood-Dauphinee S, Williams JI, Maki B. *Measuring balance in the elderly: validation of an instrument.* Can J Public Health. 1992;83(Suppl 2):S7-11. (also Berg et al. 1989) | BBS original; <45 cutoff; 56 = functional balance |
| R6 | Berg K, et al. *Use of the Berg Balance Test to predict falls in elderly persons.* PTJ. 1995 (PubMed 8650273) | 45/56 general cutoff validation |
| R7 | Blum L, Korner-Bitensky N. *Usefulness of the Berg Balance Scale in stroke rehabilitation.* Stroke/Cochrane review (referenced via R8) | BBS <49 stroke falls cutoff |
| R8 | Mackintosh SF, et al. (cutoff <49, Sn 92%), Ashburn A (48.5), Belgen B (52) — via JNPT 2009;33(3) article | Population BBS cutoffs; four-item (B11–B14) short-form accuracy note |
| R9 | Palisano RJ, Rosenbaum P, Walter S, Russell D, Wood E, Galuppi B. *Development and reliability of a system to classify gross motor function in children with cerebral palsy.* Dev Med Child Neurol. 1997;39(3):214-223. (GMFCS © CanChild, McMaster University) | GMFCS original |
| R10 | Palisano RJ, Rosenbaum P, Bartlett D, Livingston MH. *Content validity of the expanded and revised Gross Motor Function Classification System.* Dev Med Child Neurol. 2008;50(10):744-750. (GMFCS-E&R © 2007 CanChild) | GMFCS-E&R 5 age bands (<2, 2-4, 4-6, 6-12, 12-18); ICF framing; content validity |
| R11 | Sutherland DH, Davids JR. *Common Gait Abnormalities of the Knee in Cerebral Palsy.* Clin Orthop Relat Res. 1993;(288):25-31. | Four CP knee gait types: jump, crouch, stiff, recurvatum |
| R12 | Gastaldi MS, et al. *Most frequent gait patterns in diplegic spastic cerebral palsy.* Gait Posture/PMC4167043 (n=1805) | Operational kinematic thresholds for the 4 types + asymmetric/mixed handling; SLS %, GMFCS coupling |
| R13 | Sutherland DH, Olshen RA, Biden EN, Wyatt MP. *The Development of Mature Walking.* JBIS/Lippincott 1988; *The development of mature gait.* Gait Posture. 1997;6(3):163-170; JBJS 1980;62-A:336-353. | 5 determinants of mature gait; SLS 32%→38-40% by age 4; cadence/step/velocity age trends |
| R14 | Hof A. *Scaling gait data to body size.* (normative table by age 1 → adult) | Pediatric cadence 176→111 st/min, velocity 0.63→1.45 m/s, step length 0.32→1.00 m |
| R15 | Alderson L, et al. *Age-related gait standards for healthy children and young people: the GOS-ICH Gait Percentile Charts.* (n=624, ages 1-19) | Age- & gender-specific standards for velocity, cadence, step length, base of support, stance/single/double support % |
| R16 | Nieuwenhuys A, et al. *Identification of joint patterns during gait in children with cerebral palsy: a Delphi consensus study.* Dev Med Child Neurol. 2015. | Modern CP joint-pattern consensus; informs our classifier limitations footnote |
| R17 | Davids JR, Bagley AM. *Identification of Common Gait Disruption Patterns in Children With Cerebral Palsy.* JAAOS. 2014;22(12):782-790. | Primary vs compensatory deviations; sagittal jump/crouch/stiff confirmation |
| R18 | Perry J, Burnfield JM. *Gait Analysis: Normal and Pathological Function*, 2nd ed. | Determinants/pathological gait foundations (via lecture decks) |

## 3. Course references (copied to `docs/references/course/`)

Full set lives at `E:\biomechanics book` (35 PDFs, University BME series ~BIOEN 520/ME 527 incl. UW Robotic Gait Simulator material). Files copied into the repo and used:

| File | Used for |
|---|---|
| `15 - Gait_Analysis_Theory.pdf` | 3D analysis pipeline theory (marker sets, GRF/COP, inverse dynamics) — background for spec §13 kinetics contract |
| `23 - Kinematic & Kinetics.pdf` | Markerless capture accuracy trade-offs (1-2 cm positional error) — cited in limitations & spec |
| `19 - Interpretation_Limitations_Test Conditions.pdf` | Test-considerations framework → capture SOP "Limitations & validity" section |
| `435-Range-of-Motion-ROM-Booklet.docx` | Goniometry technique + normative ROM values (AAOS 1965; Magee 2006; Norkin & White) — cross-check of engine ROM_REF |
| `05 - Biomechanics of the Foot_Ankle.pdf` | Foot/ankle patho-anatomy context for sagittal CV analysis |
| `06 - Biomechanics of the Hip & Knee.pdf` | Hip/knee patho-anatomy context (CP knee classification background) |
| `32 - Structure-Function-Properties of Muscle.pdf` | Muscle structure context for overactivity/weakness tables |

## 4. Project documents

- `y.txt` (user brief): offline pure-Python assessment suite spec — BBS module API, 14-item biomechanics mapping, safety/ethics protocol (gait belt items 5/8/9/11/12/13/14), offline privacy requirement. Implemented as `python/bbs_engine.py` + integrated web module.
- `BRC_Gait_Lab_MultiView_Spec.md`: five-view clinical specification (v1.0).
- `j.txt`: SMPL-X fitting idea (Phase 5 of project plan, parked pending decision gate).

## Interpretation policy note

Where lecture-deck cutoffs and published research differ (e.g., BBS bands), the engine reports **both** interpretations with their citations: the three-tier mobility band (41–56 / 21–40 / 0–20) as the headline, and population-conditional fall-risk cutoffs as a secondary line. Nothing is reported when its supporting data is missing (zero-assumption protocol, spec P1).
