// config/view-matrix.js
// Shared role-to-view configuration for the Gait Laboratory multi-view system
// (g.txt §2 — Clinical Role System & View Architecture). One source of truth used
// by the server (serialize/export filtering), the /api/gait/view-matrix endpoint
// and the gait page renderer. Roles: patient, clinician, admin, super_admin.

const VIEWS = [
  { id: 'v1', label: 'Family / Easy Read', audience: 'Patient & family', voice: 'plain language', accent: '#2E8540', description: 'Simplified walk report, plain-language findings and what to do next.' },
  { id: 'v2', label: 'Ordering Clinician', audience: 'Referring clinician', voice: 'clinical', accent: '#1E3C82', description: 'Clinical impression, diagnoses, prescriptions and evidence references.' },
  { id: 'v3', label: 'Gait Analyst / Physio', audience: 'Gait analyst · physiotherapist', voice: 'technical', accent: '#258DC1', description: 'Kinematics workspace, phase/anomaly detail, symmetry and progression over sessions.' },
  { id: 'v4', label: 'Orthotist / Surgical 3D', audience: 'Orthotist · surgeon', voice: 'fabrication', accent: '#C99436', description: '3D triangulation, anthropometry, segment lengths and device-fabrication data.' },
  { id: 'v5', label: 'QA / Audit', audience: 'Super admin · QA auditor', voice: 'audit', accent: '#B3452F', description: 'Zero-assumption integrity ledger, confidence, OCR provenance and raw-result diff.' },
];

const ROLE_VIEWS = {
  patient: ['v1'],
  clinician: ['v2', 'v3'],
  admin: ['v1', 'v2', 'v3', 'v4', 'v5'],
  super_admin: ['v1', 'v2', 'v3', 'v4', 'v5'],
};

const ROLE_DEFAULT_VIEW = {
  patient: 'v1',
  clinician: 'v2',
  admin: 'v4',
  super_admin: 'v5',
};

const ROLE_LABEL = {
  patient: 'Patient',
  clinician: 'Clinician / Staff',
  admin: 'Administrator',
  super_admin: 'Super Administrator',
};

const STAFF_ROLES = ['clinician', 'admin', 'super_admin'];

function viewForRole(role) {
  return ROLE_DEFAULT_VIEW[role] || 'v1';
}

function allowedViews(role) {
  return ROLE_VIEWS[role] || ['v1'];
}

function canAccessView(role, viewId) {
  return allowedViews(role).indexOf(viewId) !== -1;
}

function canPreview(role) {
  return STAFF_ROLES.indexOf(role) !== -1;
}

function isStaffRole(role) {
  return STAFF_ROLES.indexOf(role) !== -1;
}

// Section visibility per view. Section keys match the section builders used by
// the gait page renderer (public/js/gait.js). A section listed here is shown for
// the given views; sections not listed are treated as visible to every view.
const SECTION_VIEWS = {
  summary_easy: ['v1', 'v2', 'v3', 'v4'],
  clinical_impression: ['v2', 'v3', 'v4', 'v5'],
  kpis: ['v1', 'v2', 'v3', 'v4', 'v5'],
  mv_charts: ['v1', 'v2', 'v3', 'v4', 'v5'],
  plane_cv: ['v2', 'v3', 'v4', 'v5'],
  cv3d: ['v3', 'v4', 'v5'],
  name_verify: ['v1', 'v2', 'v3', 'v4', 'v5'],
  anthropometry: ['v3', 'v4', 'v5'],
  integrity: ['v5'],
  muscles: ['v2', 'v3', 'v5'],
  prescriptions: ['v2', 'v3', 'v4'],
  prediction: ['v2', 'v3', 'v4', 'v5'],
  cycle_summary: ['v1', 'v2', 'v3', 'v4', 'v5'],
  phase_table: ['v2', 'v3', 'v4', 'v5'],
  anomalies: ['v2', 'v3', 'v5'],
  deformities: ['v2', 'v3', 'v4', 'v5'],
  rom: ['v2', 'v3', 'v4'],
  symmetry: ['v2', 'v3', 'v4', 'v5'],
  references: ['v1', 'v2', 'v3', 'v4', 'v5'],
  progression: ['v2', 'v3'],
  ocr_panel: ['v5'],
  raw_json: ['v5'],
  warnings: ['v5'],
  downloads: ['v1', 'v2', 'v3', 'v4', 'v5'],
};

function sectionVisibleForView(sectionId, viewId) {
  const views = SECTION_VIEWS[sectionId];
  if (!views) return true;
  return views.indexOf(viewId) !== -1;
}

module.exports = {
  VIEWS,
  ROLE_VIEWS,
  ROLE_DEFAULT_VIEW,
  ROLE_LABEL,
  STAFF_ROLES,
  SECTION_VIEWS,
  viewForRole,
  allowedViews,
  canAccessView,
  canPreview,
  isStaffRole,
  sectionVisibleForView,
};