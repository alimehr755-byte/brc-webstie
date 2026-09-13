// public/js/admin.js
// Guards the admin dashboard (must be logged in with role 'admin' or 'super_admin'),
// loads overview stats + charts, and powers the Patients/Appointments/Assessments/Reports/Messages tables,
// plus the classified User Management (users + audit logs) sections.

const THERAPY_COLORS = ['#6C5CE7', '#4FC1E9', '#EE5586', '#FFC845', '#322766', '#1F9AD6', '#F4739E', '#9C8FE0', '#5A5D55'];
const DIAGNOSIS_COLORS = ['#6C5CE7', '#4FC1E9', '#EE5586', '#FFC845', '#4C8F35', '#322766', '#1F9AD6', '#F4739E', '#9C8FE0'];

const THERAPY_LABELS = {
  occupational_therapy: 'Occupational Therapy', speech_therapy: 'Speech Therapy',
  physical_therapy: 'Physical Therapy', behavior_therapy: 'Behavior Therapy',
  audio_verbal_therapy: 'Audio-Verbal Therapy', prosthetic_orthotic: 'Prosthetic / Orthotic',
  montessori: 'Montessori Program', school_readiness: 'School Readiness Program', other: 'Other'
};

let chartInstances = {};
let patientsCache = [];
let activeCategory = 'all';

document.addEventListener('DOMContentLoaded', async () => {
  const ok = await guardAdmin();
  if (!ok) return;

  setupNav();
  setupMobileSidebar();
  setupLogout();
  setupTableSearch();
  setupOverviewFilterBar();
  setupPngButtons();
  setupModal();
  setupReportsSection();
  loadOverview();
  setupAppointmentFilters();
  setupAssessmentFilters();
  setupContentSections();
  setupUserSection();
  setupAuditSection();
  setupBell();
  setupSettingsSection();
  pollBellCount();
});

// ---- Simple client-side search: filters rows of whichever table body is currently visible ----
// For the users table this triggers a server-side search instead (pagination-aware).
function setupTableSearch() {
  const input = document.getElementById('admin-search-input');
  input.addEventListener('input', () => {
    const term = input.value.trim().toLowerCase();
    const visibleSection = ['overview', 'patients', 'appointments', 'assessments', 'messages', 'blog', 'research', 'gait', 'users', 'audit']
      .find(s => document.getElementById(`section-${s}`).style.display !== 'none');
    if (visibleSection === 'users') {
      usersMgr.search = term;
      usersMgr.page = 1;
      loadUsers();
      return;
    }
    const bodyIdMap = {
      overview: 'recent-patients-body',
      patients: 'patients-body',
      appointments: 'appointments-body',
      assessments: 'assessments-body',
      messages: 'messages-body',
      blog: 'blog-body',
      research: 'research-body',
      gait: 'gait-body',
      audit: 'audit-body'
    };
    const body = document.getElementById(bodyIdMap[visibleSection]);
    if (!body) return;
    Array.from(body.querySelectorAll('tr')).forEach(row => {
      row.style.display = row.textContent.toLowerCase().includes(term) ? '' : 'none';
    });
  });
}

const ROLE_LABELS = { patient: 'Patient', clinician: 'Clinician', admin: 'Administrator', super_admin: 'Super Admin' };
const STATUS_LABELS = { pending: 'Pending Approval', active: 'Active', suspended: 'Suspended', deactivated: 'Deactivated', deleted: 'Deleted' };
const STATUS_CLASS = { pending: 'pending', active: 'confirmed', suspended: 'cancelled', deactivated: 'pending', deleted: 'cancelled' };

// ---- Role-based dashboard access ----
// super_admin  → every section + every action
// admin        → every section except Settings (staff management is server-guarded too)
// clinician    → READ-ONLY: overview, appointments, messages only (no edit controls)
const SECTION_ACCESS = {
  super_admin: ['overview', 'patients', 'appointments', 'assessments', 'reports', 'users', 'audit', 'messages', 'blog', 'research', 'gait', 'settings'],
  admin: ['overview', 'patients', 'appointments', 'assessments', 'reports', 'users', 'audit', 'messages', 'blog', 'research', 'gait'],
  clinician: ['overview', 'appointments', 'messages']
};
function applyRoleAccess(role) {
  const allowed = SECTION_ACCESS[role] || SECTION_ACCESS.clinician;
  const canAct = role === 'admin' || role === 'super_admin';
  const canManageStaff = role === 'super_admin';
  document.querySelectorAll('.admin-nav-link').forEach(a => {
    const target = a.dataset.target;
    a.style.display = allowed.includes(target) ? '' : 'none';
  });
  const contentLabel = document.getElementById('nav-label-content');
  if (contentLabel) contentLabel.style.display = role === 'clinician' ? 'none' : '';
  return { canAct, canManageStaff, allowed };
}
const ACTION_LABELS = {
  create_user: 'Account created', edit_user: 'Account updated', reset_password: 'Password override',
  set_status: 'Status changed', delete_user: 'Account deleted', purge_user: 'Account hard-deleted',
  export_xlsx: 'XLSX export', export_overview_pdf: 'Overview PDF', export_docx: 'DOCX export',
  update_settings: 'Settings updated', backup_database: 'Database backup',
  blog_create: 'Blog post created', blog_update: 'Blog post updated', blog_delete: 'Blog post deleted',
  research_create: 'Paper created', research_update: 'Paper updated', research_delete: 'Paper deleted',
  research_attach_pdf: 'Paper PDF attached', research_remove_pdf: 'Paper PDF removed',
  gait_review: 'Gait session reviewed', gait_edit_results: 'Gait results edited', gait_edit_details: 'Gait details edited',
  self_password_change: 'Password changed', self_username_change: 'Phone changed'
};

async function guardAdmin() {
  try {
    const res = await fetch('/api/auth/me');
    if (!res.ok) { window.location.href = '/login.html'; return false; }
    const { user } = await res.json();
    if (user.role !== 'clinician' && user.role !== 'admin' && user.role !== 'super_admin') { window.location.href = '/dashboard.html'; return false; }
    if (user.must_change_password) { window.location.href = '/change-password.html'; return false; }
    window.currentAdmin = user;
    document.getElementById('admin-welcome').textContent = `Welcome, ${user.guardian_name}`;
    document.getElementById('admin-welcome').title = `Signed in as ${ROLE_LABELS[user.role] || user.role}`;
    window.dashboardAccess = applyRoleAccess(user.role);
    if (user.role !== 'super_admin') {
      const createBtn = document.getElementById('users-create-btn');
      if (createBtn) { createBtn.style.display = 'none'; }
      const hint = document.getElementById('users-toolbar-hint');
      if (hint) hint.textContent = 'Suspended / deactivated accounts cannot log in. Administrator accounts are managed by a Super Admin.';
    }
    return true;
  } catch (err) {
    window.location.href = '/login.html';
    return false;
  }
}

function setupLogout() {
  document.getElementById('admin-logout-btn').addEventListener('click', async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    document.dispatchEvent(new CustomEvent('brc-logout'));
    window.location.href = '/index.html';
  });
}

// ---- Sidebar section switching ----
function setupNav() {
  const links = document.querySelectorAll('.admin-nav-link');
  links.forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      links.forEach(l => l.classList.remove('active'));
      // highlight all links pointing at this target (e.g. the "Go to Patients" shortcut in Reports)
      document.querySelectorAll(`.admin-nav-link[data-target="${link.dataset.target}"]`).forEach(l => l.classList.add('active'));
      const target = link.dataset.target;
      ['overview', 'patients', 'appointments', 'assessments', 'reports', 'users', 'audit', 'messages', 'blog', 'research', 'gait', 'settings'].forEach(section => {
        document.getElementById(`section-${section}`).style.display = section === target ? 'block' : 'none';
      });
      if (target === 'patients') loadPatients();
      if (target === 'appointments') loadAppointments('all');
      if (target === 'assessments') loadAssessments('all');
      if (target === 'messages') loadMessages();
      if (target === 'users') loadUsers();
      if (target === 'audit') loadAudit();
      if (target === 'blog') loadBlog();
      if (target === 'research') loadResearch();
      if (target === 'gait') loadGait();
      if (target === 'settings') loadSettings();
      closeSidebar(); // collapse the drawer on phones after picking a section
    });
  });
}

// ---- Mobile drawer (off-canvas sidebar) ----
function setupMobileSidebar() {
  const toggle = document.getElementById('admin-menu-toggle');
  const sidebar = document.querySelector('.admin-sidebar');
  const backdrop = document.getElementById('sidebar-backdrop');
  if (!toggle || !sidebar || !backdrop) return;

  toggle.addEventListener('click', () => {
    const isOpen = sidebar.classList.toggle('open');
    backdrop.classList.toggle('show', isOpen);
    toggle.setAttribute('aria-expanded', String(isOpen));
  });
  backdrop.addEventListener('click', closeSidebar);
  window.addEventListener('resize', () => { if (window.innerWidth > 768) closeSidebar(); });
}

function closeSidebar() {
  const sidebar = document.querySelector('.admin-sidebar');
  const backdrop = document.getElementById('sidebar-backdrop');
  const toggle = document.getElementById('admin-menu-toggle');
  if (sidebar) sidebar.classList.remove('open');
  if (backdrop) backdrop.classList.remove('show');
  if (toggle) toggle.setAttribute('aria-expanded', 'false');
}

// ================= OVERVIEW =================

function setupOverviewFilterBar() {
  document.getElementById('overview-filter-apply').addEventListener('click', () => {
    const from = document.getElementById('overview-from').value;
    const to = document.getElementById('overview-to').value;
    loadOverview(from, to);
  });
  document.getElementById('overview-filter-clear').addEventListener('click', () => {
    document.getElementById('overview-from').value = '';
    document.getElementById('overview-to').value = '';
    loadOverview();
  });
}

async function loadOverview(from, to) {
  try {
    const params = new URLSearchParams();
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    const qs = params.toString() ? `?${params.toString()}` : '';

    const res = await fetch(`/api/admin/stats${qs}`);
    const data = await res.json();

    document.getElementById('kpi-patients').textContent = data.totalPatients;
    document.getElementById('kpi-pending').textContent = data.statusCounts.pending;
    document.getElementById('kpi-confirmed').textContent = data.statusCounts.confirmed;
    document.getElementById('kpi-messages').textContent = data.newMessages;
    document.getElementById('kpi-assess-pending').textContent = data.pendingAssessments;
    document.getElementById('kpi-assess-total').textContent = `${data.totalAssessments} total submitted`;

    renderTrendChart(data.monthlyTrend);
    renderTherapyChart(data.therapyBreakdown);
    renderStatusChart(data.statusCounts);
    renderModeChart(data.modeCounts);
    renderDiagnosisChart(data.diagnosisBreakdown);
    renderRecentPatients(data.recentPatients);

    // keep export buttons in sync with whatever range is currently applied
    updateOverviewExportLinks(from, to);
  } catch (err) {
    console.error('Failed to load stats', err);
  }
}

function destroyChart(id) {
  if (chartInstances[id]) { chartInstances[id].destroy(); delete chartInstances[id]; }
}

function renderTrendChart(monthly) {
  destroyChart('trendChart');
  const ctx = document.getElementById('trendChart');
  const labels = monthly.map(m => m.month);
  chartInstances.trendChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Appointments',
        data: monthly.map(m => m.count),
        borderColor: '#6C5CE7',
        backgroundColor: 'rgba(108,92,231,0.12)',
        tension: 0.35,
        fill: true,
        pointBackgroundColor: '#6C5CE7'
      }]
    },
    options: { plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } } }
  });
}

function renderTherapyChart(breakdown) {
  destroyChart('therapyChart');
  const ctx = document.getElementById('therapyChart');
  chartInstances.therapyChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: breakdown.map(b => b.label),
      datasets: [{ data: breakdown.map(b => b.count), backgroundColor: THERAPY_COLORS, borderRadius: 6 }]
    },
    options: {
      indexAxis: 'y',
      plugins: { legend: { display: false } },
      scales: { x: { beginAtZero: true, ticks: { stepSize: 1 } } }
    }
  });
}

function renderStatusChart(statusCounts) {
  destroyChart('statusChart');
  const ctx = document.getElementById('statusChart');
  chartInstances.statusChart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['Pending', 'Confirmed', 'Completed', 'Cancelled'],
      datasets: [{
        data: [statusCounts.pending, statusCounts.confirmed, statusCounts.completed, statusCounts.cancelled],
        backgroundColor: ['#EE5586', '#6C5CE7', '#4FC1E9', '#D8D4EE']
      }]
    },
    options: { plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } } } }
  });
}

function renderModeChart(modeCounts) {
  destroyChart('modeChart');
  const ctx = document.getElementById('modeChart');
  chartInstances.modeChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: ['In-Clinic', 'Online'],
      datasets: [{ data: [modeCounts.in_clinic, modeCounts.online], backgroundColor: ['#6C5CE7', '#EE5586'], borderRadius: 8, barThickness: 40 }]
    },
    options: {
      indexAxis: 'y',
      plugins: { legend: { display: false } },
      scales: { x: { beginAtZero: true, ticks: { stepSize: 1 } } }
    }
  });
}

function renderDiagnosisChart(breakdown) {
  destroyChart('diagnosisChart');
  const ctx = document.getElementById('diagnosisChart');
  chartInstances.diagnosisChart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: breakdown.map(d => d.label),
      datasets: [{ data: breakdown.map(d => d.count), backgroundColor: DIAGNOSIS_COLORS }]
    },
    options: { plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 10 } } } } }
  });
}

function renderRecentPatients(patients) {
  const body = document.getElementById('recent-patients-body');
  if (patients.length === 0) {
    body.innerHTML = '<tr><td colspan="4">No patients yet.</td></tr>';
    return;
  }
  body.innerHTML = patients.map(p => `
    <tr>
      <td>${escapeHtml(p.guardian_name)}</td>
      <td>${escapeHtml(p.child_name)}</td>
      <td>${escapeHtml(p.username)}</td>
      <td>${formatDate(p.created_at)}</td>
    </tr>
  `).join('');
}

function updateOverviewExportLinks(from, to) {
  const params = new URLSearchParams();
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  const qs = params.toString() ? `?${params.toString()}` : '';
  document.getElementById('download-overview-pdf').href = `/api/admin/export/overview.pdf${qs}`;
  document.getElementById('download-xlsx').href = `/api/admin/export/xlsx${qs}`;
}

// ---- PNG export for any Chart.js canvas on the page ----
function setupPngButtons() {
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.png-btn');
    if (!btn) return;
    const canvasId = btn.dataset.chart;
    const chart = chartInstances[canvasId];
    if (!chart) return;
    const url = chart.toBase64Image();
    const a = document.createElement('a');
    a.href = url;
    a.download = `brc-${btn.dataset.name || canvasId}.png`;
    a.click();
  });
}

// ================= PATIENTS =================

async function loadPatients() {
  const body = document.getElementById('patients-body');
  body.innerHTML = '<tr><td colspan="7">Loading...</td></tr>';
  try {
    const res = await fetch('/api/admin/patients');
    const { patients } = await res.json();
    patientsCache = patients;
    renderCategoryPills(patients);
    renderPatientsTable(patients);
  } catch (err) {
    body.innerHTML = '<tr><td colspan="7">Could not load patients.</td></tr>';
  }
}

function renderCategoryPills(patients) {
  const container = document.getElementById('patient-category-pills');
  const categories = ['all', ...new Set(patients.map(p => p.diagnosis_category))];
  container.innerHTML = categories.map(cat => `
    <button class="filter-pill ${cat === activeCategory ? 'active' : ''}" data-category="${escapeHtml(cat)}">
      ${cat === 'all' ? 'All Patients' : escapeHtml(cat)}
    </button>
  `).join('');
  container.querySelectorAll('.filter-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      activeCategory = pill.dataset.category;
      container.querySelectorAll('.filter-pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      renderPatientsTable(patientsCache);
    });
  });
}

function renderPatientsTable(patients) {
  const body = document.getElementById('patients-body');
  const filtered = activeCategory === 'all' ? patients : patients.filter(p => p.diagnosis_category === activeCategory);
  if (filtered.length === 0) {
    body.innerHTML = '<tr><td colspan="7">No patients in this category.</td></tr>';
    return;
  }
  body.innerHTML = filtered.map(p => `
    <tr>
      <td>${escapeHtml(p.guardian_name)}</td>
      <td>${escapeHtml(p.child_name)}</td>
      <td>${escapeHtml(p.diagnosis || 'â€”')}</td>
      <td>${escapeHtml(p.diagnosis_category)}</td>
      <td>${escapeHtml(p.username)}</td>
      <td>${p.appointment_count}</td>
      <td><button class="row-link" data-patient-id="${p.id}">View â†’</button></td>
    </tr>
  `).join('');
  body.querySelectorAll('[data-patient-id]').forEach(btn => {
    btn.addEventListener('click', () => openPatientModal(btn.dataset.patientId));
  });
}

async function openPatientModal(id) {
  const modalContent = document.getElementById('modal-content');
  modalContent.innerHTML = '<p class="empty-state">Loading patient record...</p>';
  showModal();
  try {
    const res = await fetch(`/api/admin/patients/${id}`);
    const { patient, appointments, assessments } = await res.json();

    modalContent.innerHTML = `
      <h2>${escapeHtml(patient.child_name)}</h2>
      <p style="color:var(--ink-600); margin-bottom:20px;">Guardian: ${escapeHtml(patient.guardian_name)} Â· ${escapeHtml(patient.username)}</p>

      <div class="modal-section">
        <h4>Profile</h4>
        <div class="modal-domain-row"><span>Diagnosis</span><strong>${escapeHtml(patient.diagnosis || 'Not specified')}</strong></div>
        <div class="modal-domain-row"><span>Category</span><strong>${escapeHtml(patient.diagnosis_category)}</strong></div>
        <div class="modal-domain-row"><span>Address</span><strong>${escapeHtml(patient.address || 'Not specified')}</strong></div>
        <div class="modal-domain-row"><span>Registered</span><strong>${formatDate(patient.created_at)}</strong></div>
      </div>

      <div class="modal-section">
        <h4>Appointments (${appointments.length})</h4>
        ${appointments.length === 0 ? '<p style="color:var(--ink-600);">None yet.</p>' : appointments.map(a => `
          <div class="modal-domain-row" style="flex-direction:column; align-items:flex-start; gap:4px;">
            <div style="display:flex; justify-content:space-between; width:100%;">
              <span>${escapeHtml(a.therapy_types.join(', '))} â€” ${a.mode === 'online' ? 'Online' : 'In-Clinic'}</span>
              <span class="status-badge status-${a.status}">${a.status}</span>
            </div>
            <span style="font-size:0.8rem; color:var(--ink-600);">
              Preferred date: ${a.preferred_date ? formatDate(a.preferred_date) : 'Not specified'} Â· Booked ${formatDate(a.created_at)}
            </span>
            ${a.notes ? `<span style="font-size:0.8rem; color:var(--ink-600);">Notes: ${escapeHtml(a.notes)}</span>` : ''}
          </div>
        `).join('')}
      </div>

      <div class="modal-section">
        <h4>Online Assessments (${assessments.length})</h4>
        ${assessments.length === 0 ? '<p style="color:var(--ink-600);">None submitted yet.</p>' : assessments.map(a => `
          <div style="margin-bottom:12px; padding:12px; background:var(--sand-50); border-radius:8px;">
            <div class="modal-domain-row" style="border:none; padding:0 0 6px;">
              <span>${formatDate(a.createdAt)}</span>
              <span class="status-badge status-${a.status === 'reviewed' ? 'completed' : 'pending'}">${a.status.replace('_', ' ')}</span>
            </div>
            <p style="font-size:0.85rem; color:var(--ink-600);">Flagged: ${a.flaggedDomains.length ? escapeHtml(a.flaggedDomains.join(', ')) : 'None'}</p>
            ${a.adminConclusion ? `<p style="font-size:0.85rem; margin-top:6px;"><strong>Conclusion:</strong> ${escapeHtml(a.adminConclusion)}</p>` : ''}
          </div>
        `).join('')}
      </div>

      <div class="modal-section">
        <h4>Export This Patient's Report</h4>
        <div class="modal-export-row">
          <a class="btn btn-outline" href="/api/admin/export/patient/${patient.id}/report.pdf" style="font-size:0.85rem;">â¬‡ PDF Report</a>
          <a class="btn btn-outline" href="/api/admin/export/patient/${patient.id}/report.docx" style="font-size:0.85rem;">â¬‡ Word Report</a>
        </div>
      </div>

      <div class="modal-section">
        <h4>Login Credentials</h4>
        <p style="font-size:0.82rem; color:var(--ink-600); margin-bottom:12px;">Current username (phone): <strong>${escapeHtml(patient.username)}</strong>. Leave a field blank to leave it unchanged.</p>
        <div id="credentials-msg" class="form-msg"></div>
        <div class="field">
          <label for="cred-username">New Phone Number</label>
          <input type="text" id="cred-username" placeholder="e.g. 03001234567">
        </div>
        <div class="field">
          <label for="cred-password">New Password</label>
          <input type="password" id="cred-password" placeholder="At least 6 characters" minlength="6">
        </div>
        <button class="btn btn-primary" id="save-credentials-btn" data-id="${patient.id}">Save Credentials</button>
      </div>
    `;

    const credBtn = document.getElementById('save-credentials-btn');
    credBtn.addEventListener('click', async () => {
      const newUsername = document.getElementById('cred-username').value.trim();
      const newPassword = document.getElementById('cred-password').value;
      const msgBox = document.getElementById('credentials-msg');

      if (!newUsername && !newPassword) {
        showFormMsg(msgBox, 'Enter a new phone number and/or a new password.', 'error');
        return;
      }
      if (newPassword && newPassword.length < 6) {
        showFormMsg(msgBox, 'New password must be at least 6 characters.', 'error');
        return;
      }

      credBtn.disabled = true;
      credBtn.textContent = 'Saving...';
      try {
        const res2 = await fetch(`/api/admin/patients/${id}/credentials`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ newUsername, newPassword })
        });
        const data = await res2.json();
        if (!res2.ok) throw new Error(data.error || 'Could not save.');
        showFormMsg(msgBox, data.message, 'success');
        document.getElementById('cred-username').value = '';
        document.getElementById('cred-password').value = '';
        loadPatients();
      } catch (err) {
        showFormMsg(msgBox, err.message, 'error');
      } finally {
        credBtn.disabled = false;
        credBtn.textContent = 'Save Credentials';
      }
    });
  } catch (err) {
    modalContent.innerHTML = '<p class="empty-state">Could not load patient record.</p>';
  }
}

// ================= APPOINTMENTS =================

function setupAppointmentFilters() {
  const pills = document.querySelectorAll('#appt-filter-pills .filter-pill');
  pills.forEach(pill => {
    pill.addEventListener('click', () => {
      pills.forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      loadAppointments(pill.dataset.status);
    });
  });
}

async function loadAppointments(status) {
  const body = document.getElementById('appointments-body');
  body.innerHTML = '<tr><td colspan="6">Loading...</td></tr>';
  try {
    const url = status === 'all' ? '/api/admin/appointments' : `/api/admin/appointments?status=${status}`;
    const res = await fetch(url);
    const { appointments } = await res.json();
    if (appointments.length === 0) {
      body.innerHTML = '<tr><td colspan="6">No appointments found.</td></tr>';
      return;
    }
    body.innerHTML = appointments.map(a => {
      const labels = a.therapy_types.map(t => THERAPY_LABELS[t] || t).join(', ');
      const statusCell = window.dashboardAccess && window.dashboardAccess.canAct
        ? `<select class="status-select" data-id="${a.id}">
             ${['pending','confirmed','completed','cancelled'].map(s => `<option value="${s}" ${a.status === s ? 'selected' : ''}>${s.charAt(0).toUpperCase() + s.slice(1)}</option>`).join('')}
           </select>`
        : `<span class="status-badge status-${a.status || 'pending'}">${(a.status || 'pending').charAt(0).toUpperCase() + (a.status || 'pending').slice(1)}</span>`;
      return `
        <tr>
          <td><strong>${escapeHtml(a.guardian_name)}</strong><br><span style="color:var(--ink-600); font-size:0.82rem;">${escapeHtml(a.child_name)} · ${escapeHtml(a.username)}</span></td>
          <td>${escapeHtml(labels)}${a.other_description ? `<br><span style="color:var(--ink-600); font-size:0.82rem;">${escapeHtml(a.other_description)}</span>` : ''}</td>
          <td>${a.mode === 'online' ? 'Online' : 'In-Clinic'}</td>
          <td>${a.preferred_date ? formatDate(a.preferred_date) : '—'}</td>
          <td>${formatDate(a.created_at)}</td>
          <td>${statusCell}</td>
        </tr>
      `;
    }).join('');

    body.querySelectorAll('.status-select').forEach(sel => {
      sel.addEventListener('change', async (e) => {
        const id = e.target.dataset.id;
        const newStatus = e.target.value;
        try {
          await fetch(`/api/admin/appointments/${id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: newStatus })
          });
        } catch (err) {
          alert('Could not update status. Please try again.');
        }
      });
    });
  } catch (err) {
    body.innerHTML = '<tr><td colspan="6">Could not load appointments.</td></tr>';
  }
}

// ================= ASSESSMENTS =================

function setupAssessmentFilters() {
  const pills = document.querySelectorAll('#assess-filter-pills .filter-pill');
  pills.forEach(pill => {
    pill.addEventListener('click', () => {
      pills.forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      loadAssessments(pill.dataset.status);
    });
  });
}

async function loadAssessments(status) {
  const body = document.getElementById('assessments-body');
  body.innerHTML = '<tr><td colspan="6">Loading...</td></tr>';
  try {
    const url = status === 'all' ? '/api/admin/assessments' : `/api/admin/assessments?status=${status}`;
    const res = await fetch(url);
    const { assessments } = await res.json();
    if (assessments.length === 0) {
      body.innerHTML = '<tr><td colspan="6">No assessments found.</td></tr>';
      return;
    }
    body.innerHTML = assessments.map(a => `
      <tr>
        <td>${escapeHtml(a.guardianName)}</td>
        <td>${escapeHtml(a.childName)}</td>
        <td>${a.flaggedDomains.length ? escapeHtml(a.flaggedDomains.join(', ')) : '<span style="color:var(--ink-600);">None</span>'}</td>
        <td>${formatDate(a.createdAt)}</td>
        <td><span class="status-badge status-${a.status === 'reviewed' ? 'completed' : 'pending'}">${a.status.replace('_', ' ')}</span></td>
        <td><button class="row-link" data-assessment-id="${a.id}">${a.status === 'reviewed' ? 'View â†’' : 'Review â†’'}</button></td>
      </tr>
    `).join('');
    body.querySelectorAll('[data-assessment-id]').forEach(btn => {
      btn.addEventListener('click', () => openAssessmentModal(btn.dataset.assessmentId));
    });
  } catch (err) {
    body.innerHTML = '<tr><td colspan="6">Could not load assessments.</td></tr>';
  }
}

async function openAssessmentModal(id) {
  const modalContent = document.getElementById('modal-content');
  modalContent.innerHTML = '<p class="empty-state">Loading assessment...</p>';
  showModal();
  try {
    const res = await fetch(`/api/admin/assessments/${id}`);
    const a = await res.json();

    const domainsHtml = a.domainDetail.map(domain => `
      <div style="margin-bottom:14px;">
        <strong style="font-size:0.88rem;">${escapeHtml(domain.label)}</strong>
        ${domain.questions.map(q => `
          <div class="modal-domain-row">
            <span style="font-size:0.85rem;">${escapeHtml(q.text)}</span>
            <span class="status-badge ${q.answer === 2 ? 'status-pending' : q.answer === 1 ? 'status-confirmed' : 'status-completed'}">
              ${['No concern', 'Some concern', 'Significant concern'][q.answer]}
            </span>
          </div>
        `).join('')}
      </div>
    `).join('');

    modalContent.innerHTML = `
      <h2>${escapeHtml(a.childName)}</h2>
      <p style="color:var(--ink-600); margin-bottom:20px;">Guardian: ${escapeHtml(a.guardianName)} Â· ${escapeHtml(a.username)} Â· Submitted ${formatDate(a.createdAt)}</p>

      <div class="modal-section">
        <h4>Preliminary Summary (shown to patient)</h4>
        <p style="font-size:0.9rem;">${escapeHtml(a.preliminarySummary)}</p>
      </div>

      ${a.additionalNotes ? `
      <div class="modal-section">
        <h4>Parent's Additional Notes</h4>
        <p style="font-size:0.9rem;">${escapeHtml(a.additionalNotes)}</p>
      </div>` : ''}

      <div class="modal-section">
        <h4>Full Responses</h4>
        ${domainsHtml}
      </div>

      <div class="modal-section">
        <h4>Staff Conclusion</h4>
        ${a.adminConclusion ? `
          <p style="font-size:0.9rem; padding:12px; background:var(--sky-100); border-radius:8px;">${escapeHtml(a.adminConclusion)}</p>
          <p style="font-size:0.78rem; color:var(--ink-600); margin-top:6px;">â€” ${escapeHtml(a.adminReviewer || 'Staff')}, ${formatDate(a.reviewedAt)}</p>
        ` : `
          <div id="conclusion-msg" class="form-msg"></div>
          <div class="field">
            <label for="conclusion-reviewer">Your Name</label>
            <input type="text" id="conclusion-reviewer" placeholder="e.g. Mariya Hassam">
          </div>
          <div class="field">
            <label for="conclusion-text">Conclusion &amp; Recommended Plan</label>
            <textarea id="conclusion-text" placeholder="Your professional conclusion and recommended next steps..."></textarea>
          </div>
          <button class="btn btn-primary" id="save-conclusion-btn" data-id="${a.id}">Save Conclusion</button>
        `}
      </div>
    `;

    const saveBtn = document.getElementById('save-conclusion-btn');
    if (saveBtn) {
      saveBtn.addEventListener('click', async () => {
        const conclusion = document.getElementById('conclusion-text').value.trim();
        const reviewerName = document.getElementById('conclusion-reviewer').value.trim();
        const msgBox = document.getElementById('conclusion-msg');
        if (!conclusion) { showFormMsg(msgBox, 'Please enter a conclusion.', 'error'); return; }
        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving...';
        try {
          const res2 = await fetch(`/api/admin/assessments/${id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ conclusion, reviewerName })
          });
          const data = await res2.json();
          if (!res2.ok) throw new Error(data.error || 'Could not save.');
          hideModal();
          loadAssessments(document.querySelector('#assess-filter-pills .filter-pill.active')?.dataset.status || 'all');
        } catch (err) {
          showFormMsg(msgBox, err.message, 'error');
          saveBtn.disabled = false;
          saveBtn.textContent = 'Save Conclusion';
        }
      });
    }
  } catch (err) {
    modalContent.innerHTML = '<p class="empty-state">Could not load assessment.</p>';
  }
}

// ================= REPORTS =================

function setupReportsSection() {
  document.getElementById('reports-download-xlsx').addEventListener('click', (e) => {
    e.preventDefault();
    const qs = buildReportsQuery();
    window.location.href = `/api/admin/export/xlsx${qs}`;
  });
  document.getElementById('reports-download-pdf').addEventListener('click', (e) => {
    e.preventDefault();
    const qs = buildReportsQuery();
    window.location.href = `/api/admin/export/overview.pdf${qs}`;
  });
  document.getElementById('reports-download-docx').addEventListener('click', (e) => {
    e.preventDefault();
    const qs = buildReportsQuery();
    window.location.href = `/api/admin/export/docx${qs}`;
  });
}

function buildReportsQuery() {
  const from = document.getElementById('reports-from').value;
  const to = document.getElementById('reports-to').value;
  const params = new URLSearchParams();
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  return params.toString() ? `?${params.toString()}` : '';
}

// ================= MODAL =================

function setupModal() {
  document.getElementById('modal-close-btn').addEventListener('click', hideModal);
  document.getElementById('detail-modal').addEventListener('click', (e) => {
    if (e.target.id === 'detail-modal') hideModal();
  });
}
function showModal() { document.getElementById('detail-modal').style.display = 'flex'; }
function hideModal() {
  document.getElementById('detail-modal').style.display = 'none';
  const box = document.getElementById('modal-content').parentElement;
  if (box) box.classList.remove('wide');
}

// ================= MESSAGES =================

let contactMessagesCache = [];
let currentReplyMessage = null;
let currentSmtpConfigured = false;

async function loadMessages() {
  const body = document.getElementById('messages-body');
  if (!body) return;
  try {
    const res = await fetch('/api/admin/messages');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not load messages.');
    const { messages, smtpConfigured } = data;
    contactMessagesCache = messages;
    currentSmtpConfigured = smtpConfigured;
    if (messages.length === 0) {
      body.innerHTML = '<tr><td colspan="6">No messages yet.</td></tr>';
      return;
    }
    body.innerHTML = messages.map(m => `
      <tr>
        <td>
          ${escapeHtml(m.name)}
          ${m.replied ? '<span style="display:inline-block;margin-left:6px;padding:2px 8px;border-radius:999px;background:#E6F4EA;color:#2F7A4D;font-size:.72rem;font-weight:600;">✓ Replied</span>' : ''}
        </td>
        <td>${escapeHtml(m.email || '—')} ${m.phone ? '<br>' + escapeHtml(m.phone) : ''}</td>
        <td>${escapeHtml(m.message)}</td>
        <td>${formatDate(m.created_at)}</td>
        <td>${m.replied
          ? '<span style="color:#2F7A4D;font-size:.82rem;">' + (m.replied_by ? escapeHtml(m.replied_by) + ' · ' : '') + formatDate(m.replied_at) + '</span>'
          : '<span style="color:#B3452F;font-size:.82rem;">Not answered yet</span>'}</td>
        ${(window.dashboardAccess && window.dashboardAccess.canAct)
          ? `<td><button class="btn btn-outline btn-sm" onclick="openReplyModal(${m.id})">${m.replied ? 'View / Reply' : 'Reply'}</button></td>`
          : '<td><span style="color:var(--ink-400);font-size:.82rem;">—</span></td>'}
      </tr>
    `).join('');
  } catch (err) {
    body.innerHTML = '<tr><td colspan="6">Could not load messages.</td></tr>';
  }
}

function openReplyModal(id) {
  const m = contactMessagesCache.find(x => String(x.id) === String(id));
  if (!m) return;
  currentReplyMessage = m;
  const getEl = (id2) => document.getElementById(id2);
  getEl('reply-name').textContent = m.name || '';
  getEl('reply-message').textContent = m.message || '';
  const email = m.email || '';
  const phoneRaw = m.phone || '';
  const phoneDigits = phoneRaw.replace(/\D/g, '');
  getEl('reply-email').textContent = email || 'Not provided';
  getEl('reply-phone').textContent = phoneRaw || 'Not provided';
  getEl('reply-reply-to').textContent = (m.replied_by || '—') + (m.replied_at ? ' on ' + formatDate(m.replied_at) : '');

  const copyBtn = getEl('copy-email-btn');
  copyBtn.disabled = !email;
  copyBtn.dataset.copy = email;
  const copyPhoneBtn = getEl('copy-phone-btn');
  copyPhoneBtn.disabled = !phoneRaw;
  copyPhoneBtn.dataset.copy = phoneRaw;
  if (copyPhoneBtn.disabled) copyPhoneBtn.textContent = '📋 Copy phone';
  if (copyBtn.disabled) copyBtn.textContent = '📋 Copy email';

  const mailLink = getEl('reply-mail-link');
  const waLinkEl = getEl('reply-wa-link');
  if (email) {
    mailLink.href = 'mailto:' + email + '?subject=' + encodeURIComponent('Re: your message to ' + getClinicName()) +
      '&body=' + encodeURIComponent('Hello ' + m.name + ',\n\n');
    mailLink.style.display = '';
  } else { mailLink.style.display = 'none'; }
  if (phoneDigits) {
    waLinkEl.href = 'https://wa.me/' + phoneDigits + '?text=' + encodeURIComponent(
      'Hello ' + m.name + ', thank you for contacting ' + getClinicName() + ' — replying to your message.');
    waLinkEl.style.display = '';
  } else { waLinkEl.style.display = 'none'; }

  getEl('reply-textarea').value = m.reply_text || '';
  const sendBtn = getEl('reply-send-btn');
  sendBtn.disabled = !currentSmtpConfigured;
  getEl('reply-smtp-hint').style.display = currentSmtpConfigured ? 'none' : '';
  getEl('reply-status').textContent = '';
  getEl('reply-modal').style.display = 'flex';
}

function closeReplyModal() {
  const m = document.getElementById('reply-modal');
  if (m) m.style.display = 'none';
  currentReplyMessage = null;
}

function getClinicName() {
  return 'Bonsai Rehabilitation Center';
}

function copyToClipboardBtn(btn) {
  const text = String(btn.dataset.copy || '');
  if (!text) return;
  const done = () => {
    const original = btn.textContent;
    btn.textContent = '✓ Copied';
    setTimeout(() => { btn.textContent = original; }, 1500);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  } else {
    fallbackCopy(text, done);
  }
}

function fallbackCopy(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); done(); } catch (e) { /* noop */ }
  document.body.removeChild(ta);
}

async function submitMessageReply(send) {
  const status = document.getElementById('reply-status');
  const m = currentReplyMessage;
  if (!m) return;
  const replyText = document.getElementById('reply-textarea').value.trim();
  if (!replyText) { status.textContent = 'Please type a reply first.'; return; }
  status.textContent = send ? 'Sending email…' : 'Saving…';
  try {
    const res = await fetch('/api/admin/messages/' + m.id + '/reply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ replyText, send })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Reply failed.');
    status.style.color = '#2F7A4D';
    status.textContent = data.message + (data.messageId ? ' (id ' + data.messageId + ')' : '');
    closeReplyModal();
    loadMessages();
  } catch (err) {
    status.style.color = '#B3452F';
    status.textContent = err.message;
  }
}

// ================= BLOG & RESEARCH (CONTENT) =================

const blogMgr = { page: 1, pageSize: 10, status: 'all', category: 'all', totalPages: 1 };
const researchMgr = { page: 1, pageSize: 10, status: 'all', category: 'all', totalPages: 1 };

function setupContentSections() {
  document.getElementById('blog-new-btn').addEventListener('click', () => openBlogEditor());
  bindStatusPills('blog-status-pills', (status) => { blogMgr.status = status; blogMgr.page = 1; loadBlog(); });
  document.getElementById('blog-category-filter').addEventListener('change', (e) => { blogMgr.category = e.target.value; blogMgr.page = 1; loadBlog(); });
  document.getElementById('blog-body').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (btn) handleBlogRowAction(btn.dataset.action, btn.dataset.id, btn);
  });

  document.getElementById('research-new-btn').addEventListener('click', () => openResearchEditor());
  bindStatusPills('research-status-pills', (status) => { researchMgr.status = status; researchMgr.page = 1; loadResearch(); });
  document.getElementById('research-category-filter').addEventListener('change', (e) => { researchMgr.category = e.target.value; researchMgr.page = 1; loadResearch(); });
  document.getElementById('research-body').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (btn) handleResearchRowAction(btn.dataset.action, btn.dataset.id, btn);
  });

  bindStatusPills('gait-status-pills', (status) => { gaitStatus = status; loadGait(); });
  document.getElementById('gait-status-filter').addEventListener('change', (e) => { gaitStatus = e.target.value; loadGait(); });
  document.getElementById('gait-body').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (btn) handleGaitRowAction(btn.dataset.action, btn.dataset.id, btn);
  });
}

// ================= GAIT LAB (ADMIN) =================

let gaitStatus = 'all';

async function loadGait() {
  const body = document.getElementById('gait-body');
  try {
    const params = gaitStatus && gaitStatus !== 'all' ? `?status=${encodeURIComponent(gaitStatus)}` : '';
    const res = await fetch(`/api/gait/admin/sessions${params}`);
    if (!res.ok) throw new Error();
    const { sessions } = await res.json();
    if (sessions.length === 0) {
      body.innerHTML = '<tr><td colspan="7" class="empty-state">No gait sessions found.</td></tr>';
      return;
    }
    body.innerHTML = sessions.map(gaitRowHtml).join('');
  } catch (err) {
    body.innerHTML = '<tr><td colspan="7" class="empty-state">Could not load gait sessions.</td></tr>';
  }
}

function gaitRowHtml(s) {
  const analyzer = s.analyzerMeta || {};
  const engine = analyzer.engine ? (analyzer.engine === 'python-cv' ? 'BRC Biomechanical Engine' : (analyzer.engine.includes('python') ? 'Python' : 'Node demo')) : '—';
  return `
    <tr>
      <td><strong>#${s.id}</strong><br><span style="color:var(--ink-600);font-size:0.82rem;">${formatDate(s.created_at)}</span></td>
      <td><strong>${escapeHtml(s.child_name || '')}</strong><br><span style="color:var(--ink-600);font-size:0.82rem;">${escapeHtml(s.diagnosis || '')}</span></td>
      <td>${escapeHtml(s.guardian_name || '')}<br><span style="color:var(--ink-600);font-size:0.82rem;">${escapeHtml(s.username || '')}</span></td>
      <td><span class="status-badge status-${s.status === 'reviewed' ? 'confirmed' : (s.status === 'analyzed' ? '' : 'pending')}">${s.status}</span></td>
      <td>${formatDate(s.created_at)}</td>
      <td>${escapeHtml(engine)}${analyzer.mode ? ` · <span style="color:var(--ink-600);font-size:0.82rem;">${escapeHtml(analyzer.mode)}</span>` : ''}</td>
      <td style="white-space:nowrap;">
        <button class="btn btn-ghost btn-sm" data-action="details" data-id="${s.id}">Details</button>
        ${s.status === 'analyzed' || s.status === 'reviewed'
          ? `<button class="btn btn-outline btn-sm" data-action="report" data-id="${s.id}">Report</button>` +
            `<a class="btn btn-ghost btn-sm" href="/api/gait/sessions/${s.id}/report.pdf" target="_blank">PDF</a>` +
            `<a class="btn btn-ghost btn-sm" href="/api/gait/sessions/${s.id}/report.docx" target="_blank">DOCX</a>` +
            `<a class="btn btn-ghost btn-sm" href="/api/gait/sessions/${s.id}/results.json" target="_blank">JSON</a>`
          : ''}
        <button class="btn btn-ghost btn-sm" data-action="edit" data-id="${s.id}">Edit</button>
        ${s.status === 'analyzed' ? `<button class="btn btn-primary btn-sm" data-action="review" data-id="${s.id}">Review</button>` : ''}
        <button class="btn btn-ghost btn-sm" style="color:#B3452F;" data-action="delete" data-id="${s.id}">Delete</button>
      </td>
    </tr>
  `;
}

function handleGaitRowAction(action, id, btn) {
  if (action === 'report') { openGaitReport(id); return; }
  if (action === 'review') { openGaitReviewModal(id); return; }
  if (action === 'edit') { openGaitEditModal(id); return; }
  if (action === 'details') { openGaitDetailsModal(id); return; }
  if (action === 'delete') {
    if (!window.confirm(`Delete gait session #${id} and its videos/artifacts? This cannot be undone.`)) return;
    fetch(`/api/gait/sessions/${id}`, { method: 'DELETE' }).then(() => loadGait());
  }
}

async function openGaitReport(id) {
  const res = await fetch(`/api/gait/sessions/${id}`);
  if (!res.ok) return;
  const { session } = await res.json();
  if (!session.results) return;
  const body = document.getElementById('modal-content');
  const r = session.results;
  showModal();
  body.innerHTML = `
    <h2>Gait Session #${id}</h2>
    <p style="color:var(--ink-600); font-size:.9rem;">${escapeHtml(r.diagnostic_note)}</p>
    <div class="tags mt-8">
      <span class="status-badge status-confirmed">Stance ${r.cycle.stance_pct}%</span>
      <span class="status-badge">Swing ${r.cycle.swing_pct}%</span>
      <span style="font-size:.85rem; color:var(--ink-600);">Cycle ${r.cycle.cycle_seconds}s · ${r.cycle.phases.length} sub-phases · ${r.cycle.anomalies.length} anomalies</span>
    </div>
    <div class="mt-16">
      ${(r.profile.frontal.deformities || []).concat(r.profile.sagittal.deformities || [])
        .map(d => `<div class="mt-8" style="font-size:.9rem; color:var(--ink-600);">• <strong>${escapeHtml(d.name)}</strong> (${escapeHtml(d.magnitude)}) — ${escapeHtml(d.description)}</div>`).join('')}
    </div>
    <div class="mt-16 tags">
      <a class="btn btn-primary" href="/api/gait/sessions/${id}/report.pdf" target="_blank">⬇ PDF Report</a>
      <a class="btn btn-outline" href="/api/gait/sessions/${id}/report.docx" target="_blank">⬇ Word Report</a>
    </div>
  `;
}

// Admin: edit / correct a session's stored results + patient/session details.
async function openGaitEditModal(id) {
  const res = await fetch(`/api/gait/admin/sessions/${id}`);
  if (!res.ok) return;
  const { session } = await res.json();
  const st = session.results || {};
  const u = session.user || {};
  const body = document.getElementById('modal-content');
  showModal();
  body.innerHTML = `
    <h2>Edit Gait Session #${id}</h2>
    <p style="color:var(--ink-600); font-size:.9rem;">Update the patient profile, session details, and clinician-facing results. Changes are saved and reflected in the admin list and PDF / DOCX reports.</p>

    <h4 class="mt-16" style="font-size:.85rem; letter-spacing:.5px; color:var(--ink-600); text-transform:uppercase;">Patient profile</h4>
    <div class="grid-2 mt-8">
      <div class="field">
        <label for="gait-edit-child">Child name</label>
        <input id="gait-edit-child" value="${escapeHtml(u.child_name || '')}">
      </div>
      <div class="field">
        <label for="gait-edit-guardian">Guardian name</label>
        <input id="gait-edit-guardian" value="${escapeHtml(u.guardian_name || '')}">
      </div>
    </div>
    <div class="field mt-8">
      <label for="gait-edit-diagnosis">Diagnosis</label>
      <input id="gait-edit-diagnosis" value="${escapeHtml(u.diagnosis || '')}">
    </div>
    <div class="grid-2 mt-8">
      <div class="field">
        <label for="gait-edit-phone">Phone</label>
        <input id="gait-edit-phone" value="${escapeHtml(u.phone || '')}">
      </div>
      <div class="field">
        <label for="gait-edit-country">Country code</label>
        <input id="gait-edit-country" value="${escapeHtml(u.country_code || '')}" placeholder="+92">
      </div>
    </div>
    <div class="field mt-8">
      <label for="gait-edit-address">Address</label>
      <input id="gait-edit-address" value="${escapeHtml(u.address || '')}">
    </div>

    <h4 class="mt-16" style="font-size:.85rem; letter-spacing:.5px; color:var(--ink-600); text-transform:uppercase;">Session details</h4>
    <div class="field mt-8">
      <label for="gait-edit-notes">Session notes</label>
      <textarea id="gait-edit-notes" rows="2">${escapeHtml(session.notes || '')}</textarea>
    </div>
    <div class="field mt-8">
      <label for="gait-edit-date">Date uploaded / recorded</label>
      <input id="gait-edit-date" type="date" value="${String(session.created_at || '').slice(0, 10)}">
    </div>
    <div class="grid-2 mt-8">
      <div class="field">
        <label for="gait-edit-age">Patient age (years)</label>
        <input id="gait-edit-age" type="number" min="0" max="120" step="0.5" value="${session.age_years != null ? session.age_years : ''}" placeholder="e.g. 8">
      </div>
      <div class="field">
        <label for="gait-edit-gender">Gender</label>
        <select id="gait-edit-gender">
          <option value="">Not specified</option>
          <option value="male" ${session.gender === 'male' ? 'selected' : ''}>Male</option>
          <option value="female" ${session.gender === 'female' ? 'selected' : ''}>Female</option>
          <option value="other" ${session.gender === 'other' ? 'selected' : ''}>Other</option>
        </select>
      </div>
    </div>
    <div class="grid-2 mt-8">
      <div class="field">
        <label for="gait-edit-body-mass">Body mass (kg)</label>
        <input id="gait-edit-body-mass" type="number" min="1" max="500" step="0.1" value="${session.body_mass_kg != null ? session.body_mass_kg : ''}" placeholder="e.g. 25">
      </div>
      <div class="field">
        <label for="gait-edit-clinician">Assessing clinician</label>
        <input id="gait-edit-clinician" value="${escapeHtml(session.clinician_name || '')}" placeholder="e.g. Dr. A. Khan">
      </div>
    </div>

    <h4 class="mt-16" style="font-size:.85rem; letter-spacing:.5px; color:var(--ink-600); text-transform:uppercase;">Clinician results</h4>
    <div class="field mt-8">
      <label for="gait-edit-summary">Clinical summary</label>
      <textarea id="gait-edit-summary" rows="4">${escapeHtml((st.summary && st.summary.narrative) || '')}</textarea>
    </div>
    <div class="field mt-8">
      <label for="gait-edit-note">Diagnostic note</label>
      <textarea id="gait-edit-note" rows="3">${escapeHtml(st.diagnostic_note || '')}</textarea>
    </div>
    <div class="field mt-8">
      <label for="gait-edit-review">Review note (shown to family)</label>
      <textarea id="gait-edit-review" rows="3">${escapeHtml(session.review_note || '')}</textarea>
    </div>
    <div id="gait-edit-msg" class="form-msg" style="display:none;"></div>
    <div class="tags mt-16">
      <button class="btn btn-primary" id="gait-edit-save-btn">Save Changes</button>
    </div>
  `;
  document.getElementById('gait-edit-save-btn').addEventListener('click', async () => {
    const msg = document.getElementById('gait-edit-msg');
    const narrative = document.getElementById('gait-edit-summary').value;
    const diag = document.getElementById('gait-edit-note').value;
    const rev = document.getElementById('gait-edit-review').value;
    const edited = {
      diagnostic_note: diag,
      summary: { ...(st.summary || {}), narrative },
    };
    try {
      // 1) save patient + session details
      const det = await fetch(`/api/gait/admin/sessions/${id}/details`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          guardian_name: document.getElementById('gait-edit-guardian').value,
          child_name: document.getElementById('gait-edit-child').value,
          diagnosis: document.getElementById('gait-edit-diagnosis').value,
          address: document.getElementById('gait-edit-address').value,
          phone: document.getElementById('gait-edit-phone').value,
          country_code: document.getElementById('gait-edit-country').value,
          notes: document.getElementById('gait-edit-notes').value,
          created_at: document.getElementById('gait-edit-date').value,
          ageYears: document.getElementById('gait-edit-age')?.value || '',
          gender: document.getElementById('gait-edit-gender')?.value || '',
          bodyMassKg: document.getElementById('gait-edit-body-mass')?.value || '',
          clinicianName: document.getElementById('gait-edit-clinician')?.value || '',
        })
      });
      let detData = null;
      if (!det.ok) { detData = await det.json().catch(() => ({})); throw new Error(detData.error || 'Could not save details'); }

      // 2) save clinician results (only if the session has results)
      if (session.results) {
        const res = await fetch(`/api/gait/admin/sessions/${id}/results`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ result: edited })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        // persist review note separately
        await fetch(`/api/gait/admin/sessions/${id}/review`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reviewNote: rev })
        }).catch(() => {});
      } else {
        // no results yet: still persist the review note only if status is reviewed
        if (session.status === 'reviewed' && rev) {
          await fetch(`/api/gait/admin/sessions/${id}/review`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reviewNote: rev })
          }).catch(() => {});
        }
      }
      msg.className = 'form-msg success'; msg.style.display = 'block'; msg.textContent = 'Saved. Patient details & report updated.';
      setTimeout(() => { hideModal(); loadGait(); }, 1000);
    } catch (err) {
      msg.className = 'form-msg error'; msg.style.display = 'block'; msg.textContent = err.message;
    }
  });
}

// Admin: read-only detail view of a session's patient info, metadata, and results.
async function openGaitDetailsModal(id) {
  const res = await fetch(`/api/gait/admin/sessions/${id}`);
  if (!res.ok) return;
  const { session } = await res.json();
  const u = session.user || {};
  const st = session.results || {};
  const analyzer = session.analyzerMeta || {};
  const engine = analyzer.engine ? (analyzer.engine === 'python-cv' ? 'BRC Biomechanical Engine' : (analyzer.engine.includes('python') ? 'Python' : 'Node demo')) : '—';
  const body = document.getElementById('modal-content');
  showModal();
  const kv = (label, val) => `<tr><td>${label}</td><td>${val || '—'}</td></tr>`;
  body.innerHTML = `
    <h2>Gait Session #${id}</h2>
    <div class="tags mt-8">
      <span class="status-badge status-${session.status === 'reviewed' ? 'confirmed' : (session.status === 'analyzed' ? '' : 'pending')}">${session.status}</span>
      <span style="font-size:.85rem; color:var(--ink-600);">Uploaded ${escapeHtml(String(session.created_at || ''))} · Updated ${escapeHtml(String(session.updated_at || ''))}</span>
    </div>
    <h4 class="mt-16" style="font-size:.85rem; letter-spacing:.5px; color:var(--ink-600); text-transform:uppercase;">Patient</h4>
    <div class="mt-8" style="overflow-x:auto;">
      <table class="admin-table">
        <tbody>
          ${kv('Child name', u.child_name)}
          ${kv('Guardian name', u.guardian_name)}
          ${kv('Username', u.username)}
          ${kv('Diagnosis', u.diagnosis)}
          ${kv('Phone', `${u.country_code || ''} ${u.phone || ''}`)}
          ${kv('Address', u.address)}
        </tbody>
      </table>
    </div>
    <h4 class="mt-16" style="font-size:.85rem; letter-spacing:.5px; color:var(--ink-600); text-transform:uppercase;">Session</h4>
    <div class="mt-8" style="overflow-x:auto;">
      <table class="admin-table">
        <tbody>
          ${kv('Engine', engine + (analyzer.mode ? ` · ${analyzer.mode}` : ''))}
          ${kv('Notes', session.notes)}
          ${kv('Videos', [session.sagittal_name, session.frontal_name, session.combined_name].filter(Boolean).join(', ') || '—')}
          ${kv('Reviewed by', session.reviewed_by + (session.reviewed_at ? ` (${String(session.reviewed_at).slice(0,16)})` : ''))}
          ${kv('Review note', session.review_note)}
        </tbody>
      </table>
    </div>
    <h4 class="mt-16" style="font-size:.85rem; letter-spacing:.5px; color:var(--ink-600); text-transform:uppercase;">Diagnostic Summary</h4>
    <p class="mt-8" style="font-size:.9rem; color:var(--ink-600);">${escapeHtml(st.diagnostic_note || 'No results yet — run analysis.')}</p>
    ${st.cycle ? `<p style="font-size:.85rem; color:var(--ink-600);">Cycle ${st.cycle.cycle_seconds}s · Stance ${st.cycle.stance_pct}% · Swing ${st.cycle.swing_pct}%</p>` : ''}
    <div class="tags mt-16">
      <button class="btn btn-ghost" onclick="openGaitEditModal(${id})">Edit</button>
      ${session.status === 'analyzed' || session.status === 'reviewed'
        ? `<a class="btn btn-primary" href="/api/gait/sessions/${id}/report.pdf" target="_blank">⬇ PDF</a>
           <a class="btn btn-outline" href="/api/gait/sessions/${id}/report.docx" target="_blank">⬇ Word</a>`
        : ''}
    </div>
  `;
}

function openGaitReviewModal(id) {
  const body = document.getElementById('modal-content');
  showModal();
  body.innerHTML = `
    <h2>Review Gait Session #${id}</h2>
    <p style="color:var(--ink-600); font-size:.9rem;">Confirm the automated findings and add the clinical note shown to the family.</p>
    <div class="field mt-16">
      <label for="gait-review-note">Clinical review note</label>
      <textarea id="gait-review-note" rows="4" placeholder="e.g. Equinus pattern confirmed; DAFO prescribed; reassess in 6 weeks."></textarea>
    </div>
    <div id="gait-review-msg" class="form-msg" style="display:none;"></div>
    <div class="tags mt-16">
      <button class="btn btn-primary" id="gait-review-confirm-btn">Approve &amp; Mark Reviewed</button>
    </div>
  `;
  document.getElementById('gait-review-confirm-btn').addEventListener('click', async () => {
    const note = document.getElementById('gait-review-note').value.trim();
    const msg = document.getElementById('gait-review-msg');
    try {
      const res = await fetch(`/api/gait/admin/sessions/${id}/review`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reviewNote: note })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      msg.className = 'form-msg success'; msg.style.display = 'block'; msg.textContent = data.message;
      setTimeout(() => { hideModal(); loadGait(); }, 900);
    } catch (err) {
      msg.className = 'form-msg error'; msg.style.display = 'block'; msg.textContent = err.message;
    }
  });
}

function bindStatusPills(id, onPick) {
  document.querySelectorAll(`#${id} .filter-pill`).forEach(pill => {
    pill.addEventListener('click', () => {
      document.querySelectorAll(`#${id} .filter-pill`).forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      onPick(pill.dataset.status);
    });
  });
}

function fillCategoryFilter(selectId, categories) {
  const sel = document.getElementById(selectId);
  const prev = sel.value;
  sel.innerHTML = `<option value="all">All categories</option>`
    + categories.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
  sel.value = categories.includes(prev) ? prev : 'all';
  return sel.value;
}

function renderManagerPagination(elId, mgr, reload) {
  const el = document.getElementById(elId);
  if (!el) return;
  if (mgr.totalPages <= 1) { el.innerHTML = ''; return; }
  el.innerHTML = `
    <button class="btn btn-outline btn-sm" data-dir="-1" ${mgr.page <= 1 ? 'disabled' : ''}>â† Prev</button>
    <span class="page-info">Page ${mgr.page} of ${mgr.totalPages}</span>
    <button class="btn btn-outline btn-sm" data-dir="1" ${mgr.page >= mgr.totalPages ? 'disabled' : ''}>Next â†’</button>
  `;
  el.querySelectorAll('button[data-dir]').forEach(b => {
    if (b.disabled) return;
    b.addEventListener('click', () => {
      const np = mgr.page + parseInt(b.dataset.dir, 10);
      if (np >= 1 && np <= mgr.totalPages) { mgr.page = np; reload(); }
    });
  });
}

function blogRowHtml(p) {
  return `
    <tr>
      <td><strong>${escapeHtml(p.title)}</strong><br><span style="color:var(--ink-600);font-size:0.82rem;">${escapeHtml(p.slug)}</span></td>
      <td>${escapeHtml(p.category)}</td>
      <td>${escapeHtml(p.author)}</td>
      <td><span class="status-badge status-${p.status === 'published' ? 'confirmed' : 'pending'}">${p.status}</span></td>
      <td>${p.publishedAt ? formatDate(p.publishedAt) : 'â€”'}</td>
      <td style="white-space:nowrap;">
        <button class="row-link" data-action="view" data-id="${p.id}" data-slug="${escapeHtml(p.slug)}">View â†’</button>
        <button class="row-link" data-action="edit" data-id="${p.id}" style="margin-left:10px;">Edit</button>
        <button class="row-link" data-action="delete" data-id="${p.id}" style="margin-left:10px; color:var(--danger);">Delete</button>
      </td>
    </tr>`;
}

function researchRowHtml(p) {
  return `
    <tr>
      <td><strong>${escapeHtml(p.title)}</strong><br><span style="color:var(--ink-600);font-size:0.82rem;">${escapeHtml(p.slug)}</span></td>
      <td>${escapeHtml(p.category)}</td>
      <td>${escapeHtml(p.author)}</td>
      <td><span class="status-badge status-${p.status === 'published' ? 'confirmed' : 'pending'}">${p.status}</span></td>
      <td>${p.publishedAt ? formatDate(p.publishedAt) : 'â€”'}</td>
      <td>${p.hasFile ? 'Attached' : 'â€”'}</td>
      <td style="white-space:nowrap;">
        <button class="row-link" data-action="view" data-id="${p.id}" data-slug="${escapeHtml(p.slug)}">View â†’</button>
        <button class="row-link" data-action="edit" data-id="${p.id}" style="margin-left:10px;">Edit</button>
        <button class="row-link" data-action="delete" data-id="${p.id}" style="margin-left:10px; color:var(--danger);">Delete</button>
      </td>
    </tr>`;
}

async function loadBlog() {
  const body = document.getElementById('blog-body');
  body.innerHTML = '<tr><td colspan="6">Loading...</td></tr>';
  const params = new URLSearchParams({ page: String(blogMgr.page), pageSize: String(blogMgr.pageSize) });
  if (blogMgr.status !== 'all') params.set('status', blogMgr.status);
  if (blogMgr.category !== 'all') params.set('category', blogMgr.category);
  try {
    const res = await fetch(`/api/blog/manage?${params}`);
    if (!res.ok) throw new Error();
    const data = await res.json();
    blogMgr.totalPages = data.totalPages;
    const selCat = fillCategoryFilter('blog-category-filter', data.categories);
    if (selCat !== blogMgr.category) { blogMgr.category = selCat; return loadBlog(); }
    body.innerHTML = data.items.length
      ? data.items.map(blogRowHtml).join('')
      : '<tr><td colspan="6">No posts found.</td></tr>';
    renderManagerPagination('blog-pagination', blogMgr, loadBlog);
  } catch (err) {
    body.innerHTML = '<tr><td colspan="6">Could not load posts.</td></tr>';
  }
}

async function loadResearch() {
  const body = document.getElementById('research-body');
  body.innerHTML = '<tr><td colspan="7">Loading...</td></tr>';
  const params = new URLSearchParams({ page: String(researchMgr.page), pageSize: String(researchMgr.pageSize) });
  if (researchMgr.status !== 'all') params.set('status', researchMgr.status);
  if (researchMgr.category !== 'all') params.set('category', researchMgr.category);
  try {
    const res = await fetch(`/api/research/manage?${params}`);
    if (!res.ok) throw new Error();
    const data = await res.json();
    researchMgr.totalPages = data.totalPages;
    const selCat = fillCategoryFilter('research-category-filter', data.categories);
    if (selCat !== researchMgr.category) { researchMgr.category = selCat; return loadResearch(); }
    body.innerHTML = data.items.length
      ? data.items.map(researchRowHtml).join('')
      : '<tr><td colspan="7">No publications found.</td></tr>';
    renderManagerPagination('research-pagination', researchMgr, loadResearch);
  } catch (err) {
    body.innerHTML = '<tr><td colspan="7">Could not load publications.</td></tr>';
  }
}

function handleBlogRowAction(action, id, btn) {
  if (action === 'view') { window.open(`/blog-post.html?slug=${encodeURIComponent(btn.dataset.slug)}`, '_blank'); return; }
  if (action === 'edit') { openBlogEditor(id); return; }
  if (action === 'delete') { deleteBlogPost(id); }
}

function handleResearchRowAction(action, id, btn) {
  if (action === 'view') { window.open(`/research-paper.html?slug=${encodeURIComponent(btn.dataset.slug)}`, '_blank'); return; }
  if (action === 'edit') { openResearchEditor(id); return; }
  if (action === 'delete') { deleteResearchPaper(id); }
}

async function deleteBlogPost(id) {
  if (!window.confirm('Delete this blog post? This cannot be undone.')) return;
  try {
    const res = await fetch(`/api/blog/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not delete.');
    loadBlog();
  } catch (err) { alert(err.message); }
}

async function deleteResearchPaper(id) {
  if (!window.confirm('Delete this research paper and its attached PDF? This cannot be undone.')) return;
  try {
    const res = await fetch(`/api/research/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not delete.');
    loadResearch();
  } catch (err) { alert(err.message); }
}

// ---- Content editor (modal) ----

async function fetchCategoryOptions(datalistEl, kind) {
  try {
    const url = kind === 'research' ? '/api/research/manage?pageSize=1' : '/api/blog/manage?pageSize=1';
    const res = await fetch(url);
    if (!res.ok) return;
    const data = await res.json();
    datalistEl.innerHTML = data.categories.map(c => `<option value="${escapeHtml(c)}"></option>`).join('');
  } catch (err) { /* datalist is optional; user can still type any category */ }
}

async function openBlogEditor(id) {
  const modalContent = document.getElementById('modal-content');
  const modalBox = modalContent.parentElement;
  modalBox.classList.add('wide');
  modalContent.innerHTML = '<p class="empty-state">Loading editor...</p>';
  showModal();

  let post = { title: '', author: 'Bonsai Rehabilitation Center', category: 'General', abstract: '', content: '', status: 'draft' };
  if (id) {
    try {
      const res = await fetch(`/api/blog/item/${id}`);
      if (!res.ok) throw new Error();
      post = (await res.json()).post;
    } catch (err) {
      modalContent.innerHTML = '<p class="empty-state">Could not load the post.</p>';
      return;
    }
  }
  renderBlogEditor(post, id);
}

function renderBlogEditor(post, id) {
  const modalContent = document.getElementById('modal-content');
  const isNew = !id;
  modalContent.innerHTML = `
    <h2>${isNew ? 'New Blog Post' : 'Edit Blog Post'}</h2>

    <div class="modal-section">
      <div class="field"><label for="be-title">Title *</label><input type="text" id="be-title" maxlength="200" value="${escapeHtml(post.title)}" placeholder="Post title"></div>
      <div class="field-row">
        <div class="field"><label for="be-author">Author *</label><input type="text" id="be-author" maxlength="100" value="${escapeHtml(post.author)}"></div>
        <div class="field"><label for="be-category">Category *</label><input type="text" id="be-category" list="be-categories" maxlength="60" value="${escapeHtml(post.category)}"><datalist id="be-categories"></datalist></div>
      </div>
      <div class="field"><label for="be-abstract">Summary (shown on the blog listing) *</label><textarea id="be-abstract" maxlength="1000" rows="3" placeholder="One or two sentences...">${escapeHtml(post.abstract)}</textarea></div>
    </div>

    <div class="modal-section">
      <h4>Content (Markdown supported)</h4>
      <div class="editor-grid">
        <div class="field editor-pane" style="margin-bottom:0;"><label for="be-content">Write</label><textarea id="be-content" rows="14" placeholder="Write your post in Markdown...">${escapeHtml(post.content)}</textarea></div>
        <div class="field editor-pane" style="margin-bottom:0;"><label for="be-preview">Preview</label><div class="editor-preview content-body" id="be-preview"><span class="preview-empty">Preview will appear here as you type.</span></div></div>
      </div>
    </div>

    <div id="be-msg" class="form-msg"></div>
    <div class="editor-actions">
      <button class="btn btn-primary" id="be-save">${post.status === 'published' ? 'Save Changes' : 'Save Draft'}</button>
      <button class="btn btn-outline" id="be-publish">${post.status === 'published' ? 'Unpublish' : (isNew ? 'Publish Now' : 'Publish')}</button>
      <button class="btn btn-ghost" id="be-cancel">Cancel</button>
    </div>
  `;

  const titleEl = modalContent.querySelector('#be-title');
  const authorEl = modalContent.querySelector('#be-author');
  const categoryEl = modalContent.querySelector('#be-category');
  const abstractEl = modalContent.querySelector('#be-abstract');
  const contentEl = modalContent.querySelector('#be-content');
  const msgEl = modalContent.querySelector('#be-msg');
  const previewEl = modalContent.querySelector('#be-preview');

  fetchCategoryOptions(modalContent.querySelector('#be-categories'), 'blog');

  const refreshPreview = () => {
    const v = contentEl.value.trim();
    previewEl.innerHTML = v ? renderMarkdown(v) : '<span class="preview-empty">Preview will appear here as you type.</span>';
  };
  contentEl.addEventListener('input', refreshPreview);
  refreshPreview();

  modalContent.querySelector('#be-cancel').addEventListener('click', hideModal);

  const doSave = async (targetStatus, btn) => {
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = 'Saving...';
    try {
      const payload = {
        title: titleEl.value.trim(),
        author: authorEl.value.trim(),
        category: categoryEl.value.trim(),
        abstract: abstractEl.value.trim(),
        content: contentEl.value.trim(),
        status: targetStatus
      };
      const url = id ? `/api/blog/${id}` : '/api/blog';
      const res = await fetch(url, {
        method: id ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not save.');
      hideModal();
      loadBlog();
    } catch (err) {
      showFormMsg(msgEl, err.message, 'error');
      btn.disabled = false;
      btn.textContent = original;
    }
  };

  modalContent.querySelector('#be-save').addEventListener('click', (e) => {
    doSave(post.status === 'published' ? 'published' : 'draft', e.currentTarget);
  });
  modalContent.querySelector('#be-publish').addEventListener('click', (e) => {
    doSave(post.status === 'published' ? 'draft' : 'published', e.currentTarget);
  });
}

async function openResearchEditor(id) {
  const modalContent = document.getElementById('modal-content');
  const modalBox = modalContent.parentElement;
  modalBox.classList.add('wide');
  modalContent.innerHTML = '<p class="empty-state">Loading editor...</p>';
  showModal();

  let paper = {
    title: '', author: 'Bonsai Rehabilitation Center', category: 'General',
    publicationDate: '', abstract: '', content: '', status: 'draft', hasFile: false, fileName: null, id: null
  };
  if (id) {
    try {
      const res = await fetch(`/api/research/item/${id}`);
      if (!res.ok) throw new Error();
      const row = (await res.json()).paper;
      paper = {
        title: row.title, author: row.author, category: row.category,
        publicationDate: row.publication_date || '',
        abstract: row.abstract || '', content: row.content || '',
        status: row.status, hasFile: !!row.pdf_path,
        fileName: row.pdf_name, id: row.id
      };
    } catch (err) {
      modalContent.innerHTML = '<p class="empty-state">Could not load the paper.</p>';
      return;
    }
  }
  renderResearchEditor(paper, id);
}

function renderResearchEditor(paper, id) {
  const modalContent = document.getElementById('modal-content');
  const isNew = !id;
  modalContent.innerHTML = `
    <h2>${isNew ? 'New Research Paper' : 'Edit Research Paper'}</h2>

    <div class="modal-section">
      <div class="field"><label for="re-title">Title *</label><input type="text" id="re-title" maxlength="200" value="${escapeHtml(paper.title)}" placeholder="Paper title"></div>
      <div class="field-row">
        <div class="field"><label for="re-author">Author *</label><input type="text" id="re-author" maxlength="100" value="${escapeHtml(paper.author)}"></div>
        <div class="field"><label for="re-category">Category *</label><input type="text" id="re-category" list="re-categories" maxlength="60" value="${escapeHtml(paper.category)}"><datalist id="re-categories"></datalist></div>
      </div>
      <div class="field"><label for="re-date">Publication Date</label><input type="date" id="re-date" value="${escapeHtml(paper.publicationDate || '')}"></div>
      <div class="field"><label for="re-abstract">Summary (shown on the research listing) *</label><textarea id="re-abstract" maxlength="1000" rows="3" placeholder="One or two sentences...">${escapeHtml(paper.abstract)}</textarea></div>
    </div>

    <div class="modal-section">
      <h4>Detail (optional, Markdown supported)</h4>
      <div class="editor-grid">
        <div class="field editor-pane" style="margin-bottom:0;"><label for="re-content">Write</label><textarea id="re-content" rows="12" placeholder="An optional longer summary of the paper...">${escapeHtml(paper.content)}</textarea></div>
        <div class="field editor-pane" style="margin-bottom:0;"><label for="re-preview">Preview</label><div class="editor-preview content-body" id="re-preview"><span class="preview-empty">Preview will appear here as you type.</span></div></div>
      </div>
    </div>

    <div class="modal-section">
      <h4>PDF Attachment</h4>
      ${paper.hasFile && paper.fileName ? `
        <div class="file-attachment" id="re-file-box">
          <span><strong>${escapeHtml(paper.fileName)}</strong> â€” attached</span>
          ${id ? `<button class="btn btn-outline btn-sm" id="re-remove-file">Remove PDF</button>` : ''}
        </div>
      ` : ''}
      <div class="field" style="margin-top:12px; margin-bottom:0;">
        <label for="re-file">${paper.hasFile ? 'Replace PDF' : 'Upload PDF'} (optional, .pdf up to 8 MB)</label>
        <input type="file" id="re-file" accept="application/pdf,.pdf">
      </div>
    </div>

    <div id="re-msg" class="form-msg"></div>
    <div class="editor-actions">
      <button class="btn btn-primary" id="re-save">${paper.status === 'published' ? 'Save Changes' : 'Save Draft'}</button>
      <button class="btn btn-outline" id="re-publish">${paper.status === 'published' ? 'Unpublish' : (isNew ? 'Publish Now' : 'Publish')}</button>
      <button class="btn btn-ghost" id="re-cancel">Cancel</button>
    </div>
  `;

  const titleEl = modalContent.querySelector('#re-title');
  const authorEl = modalContent.querySelector('#re-author');
  const categoryEl = modalContent.querySelector('#re-category');
  const dateEl = modalContent.querySelector('#re-date');
  const abstractEl = modalContent.querySelector('#re-abstract');
  const contentEl = modalContent.querySelector('#re-content');
  const fileEl = modalContent.querySelector('#re-file');
  const msgEl = modalContent.querySelector('#re-msg');
  const previewEl = modalContent.querySelector('#re-preview');

  fetchCategoryOptions(modalContent.querySelector('#re-categories'), 'research');

  const refreshPreview = () => {
    const v = contentEl.value.trim();
    previewEl.innerHTML = v ? renderMarkdown(v) : '<span class="preview-empty">Preview will appear here as you type.</span>';
  };
  contentEl.addEventListener('input', refreshPreview);
  refreshPreview();

  modalContent.querySelector('#re-cancel').addEventListener('click', hideModal);

  const removeBtn = modalContent.querySelector('#re-remove-file');
  if (removeBtn) {
    removeBtn.addEventListener('click', async () => {
      if (!id) return;
      if (!window.confirm('Remove the attached PDF?')) return;
      try {
        const res = await fetch(`/api/research/${id}/attachment`, { method: 'DELETE' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not remove the PDF.');
        openResearchEditor(id);
      } catch (err) { alert(err.message); }
    });
  }

  const doSave = async (targetStatus, btn) => {
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = 'Saving...';
    try {
      const payload = {
        title: titleEl.value.trim(),
        author: authorEl.value.trim(),
        category: categoryEl.value.trim(),
        publicationDate: dateEl.value,
        abstract: abstractEl.value.trim(),
        content: contentEl.value.trim(),
        status: targetStatus
      };
      const url = id ? `/api/research/${id}` : '/api/research';
      const res = await fetch(url, {
        method: id ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not save.');

      const savedId = id || data.id;
      if (fileEl.files && fileEl.files[0]) {
        try {
          const fd = new FormData();
          fd.append('pdf', fileEl.files[0]);
          const upRes = await fetch(`/api/research/${savedId}/attachment`, { method: 'POST', body: fd });
          if (!upRes.ok) {
            const upData = await upRes.json();
            alert(`Paper saved, but the PDF could not be uploaded: ${upData.error || 'unknown error'}`);
          }
        } catch (err) {
          alert('Paper saved, but the PDF upload failed. Please attach it again from Edit.');
        }
      }

      hideModal();
      loadResearch();
    } catch (err) {
      showFormMsg(msgEl, err.message, 'error');
      btn.disabled = false;
      btn.textContent = original;
    }
  };

  modalContent.querySelector('#re-save').addEventListener('click', (e) => {
    doSave(paper.status === 'published' ? 'published' : 'draft', e.currentTarget);
  });
  modalContent.querySelector('#re-publish').addEventListener('click', (e) => {
    doSave(paper.status === 'published' ? 'draft' : 'published', e.currentTarget);
  });
}

// ================= USERS (classified account management) + AUDIT LOG =================

const usersMgr = { page: 1, pageSize: 15, tab: 'all', search: '', totalPages: 1, total: 0 };
const auditMgr = { page: 1, pageSize: 25, action: 'all', totalPages: 1, total: 0 };

function currentIsSuper() { return !!(window.currentAdmin && window.currentAdmin.role === 'super_admin'); }
function canManageTarget(u) { return currentIsSuper() || (u.role !== 'admin' && u.role !== 'super_admin'); }
function userFullName(u) { return [u.guardian_name, u.child_name].filter(Boolean).join(' - ') || 'User'; }
function formatDateTime(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d)) return dateStr;
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function setupUserSection() {
  const pills = document.querySelectorAll('#users-role-pills .filter-pill');
  pills.forEach(pill => pill.addEventListener('click', () => {
    pills.forEach(p => p.classList.remove('active'));
    pill.classList.add('active');
    usersMgr.tab = pill.dataset.tab;
    usersMgr.page = 1;
    loadUsers();
  }));
  document.getElementById('users-filter-apply').addEventListener('click', () => { usersMgr.page = 1; loadUsers(); });
  document.getElementById('users-filter-clear').addEventListener('click', () => {
    document.getElementById('users-role-filter').value = 'all';
    document.getElementById('users-status-filter').value = 'all';
    document.getElementById('users-from').value = '';
    document.getElementById('users-to').value = '';
    usersMgr.tab = 'all';
    usersMgr.page = 1;
    document.querySelectorAll('#users-role-pills .filter-pill').forEach(p => p.classList.toggle('active', p.dataset.tab === 'all'));
    loadUsers();
  });
  document.getElementById('users-create-btn').addEventListener('click', openUserCreate);
  document.getElementById('users-body').addEventListener('click', (e) => {
    const btn = e.target.closest('button.row-link[data-action]');
    if (!btn) return;
    const id = Number(btn.dataset.id);
    if (btn.dataset.action === 'view') openUserDetail(id);
    else if (btn.dataset.action === 'edit') openUserEdit(id);
  });
}

function userRowHtml(u) {
  const name = [u.guardian_name, u.child_name].filter(Boolean).join(' - ') || '-';
  const contact = u.email
    ? `${escapeHtml(u.email)}<br><span style="color:var(--ink-600);font-size:0.82rem;">${escapeHtml(u.username)}</span>`
    : `<span style="color:var(--ink-600);font-size:0.82rem;">@${escapeHtml(u.username)}</span>`;
  return `
    <tr>
      <td>${u.id}</td>
      <td><strong>${escapeHtml(name)}</strong></td>
      <td>${contact}</td>
      <td><span class="status-badge status-confirmed" style="opacity:.85;">${escapeHtml(ROLE_LABELS[u.role] || u.role)}</span></td>
      <td><span class="status-badge status-${STATUS_CLASS[u.status] || 'pending'}">${escapeHtml(STATUS_LABELS[u.status] || u.status)}</span></td>
      <td>${formatDate(u.created_at)}</td>
      <td style="white-space:nowrap;">
        <button class="row-link" data-action="view" data-id="${u.id}">View</button>
        <button class="row-link" data-action="edit" data-id="${u.id}" style="margin-left:10px;">Edit</button>
      </td>
    </tr>`;
}

async function loadUsers() {
  const body = document.getElementById('users-body');
  body.innerHTML = '<tr><td colspan="7">Loading...</td></tr>';
  const params = new URLSearchParams({ page: String(usersMgr.page), perPage: String(usersMgr.pageSize) });
  if (usersMgr.tab !== 'all') params.set('tab', usersMgr.tab);
  const role = document.getElementById('users-role-filter').value;
  if (role !== 'all') params.set('role', role);
  const status = document.getElementById('users-status-filter').value;
  if (status !== 'all') params.set('status', status);
  const from = document.getElementById('users-from').value;
  const to = document.getElementById('users-to').value;
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  if (usersMgr.search) params.set('search', usersMgr.search);
  try {
    const res = await fetch(`/api/admin/users?${params}`);
    if (!res.ok) throw new Error();
    const data = await res.json();
    usersMgr.totalPages = data.pages;
    usersMgr.total = data.total;
    body.innerHTML = data.users.length
      ? data.users.map(userRowHtml).join('')
      : '<tr><td colspan="7">No accounts found.</td></tr>';
    renderManagerPagination('users-pagination', usersMgr, loadUsers);
  } catch (err) {
    body.innerHTML = '<tr><td colspan="7">Could not load accounts.</td></tr>';
  }
}

async function openUserDetail(id) {
  const modalContent = document.getElementById('modal-content');
  const modalBox = modalContent.parentElement;
  modalBox.classList.add('wide');
  modalContent.innerHTML = '<p class="empty-state">Loading profile...</p>';
  showModal();
  let data;
  try {
    const res = await fetch(`/api/admin/users/${id}`);
    if (!res.ok) throw new Error();
    data = await res.json();
  } catch (err) {
    modalContent.innerHTML = '<p class="empty-state">Could not load this profile.</p>';
    return;
  }
  const u = data.user;
  const manage = canManageTarget(u);
  const patientExports = u.role === 'patient'
    ? `<a class="btn btn-outline btn-sm" target="_blank" href="/api/admin/export/patient/${u.id}/report.pdf">Patient PDF</a>
       <a class="btn btn-outline btn-sm" target="_blank" href="/api/admin/export/patient/${u.id}/report.docx">Patient DOCX</a>`
    : '';
  modalContent.innerHTML = `
    <h2>${escapeHtml(userFullName(u))}</h2>
    <p class="field-hint">
      <span class="status-badge status-${STATUS_CLASS[u.status] || 'pending'}">${escapeHtml(STATUS_LABELS[u.status] || u.status)}</span>
      <span class="status-badge status-confirmed" style="opacity:.85;">${escapeHtml(ROLE_LABELS[u.role] || u.role)}</span>
      <span style="opacity:.7;">account #${u.id}</span>
    </p>
    ${u.must_change_password ? '<p class="field-hint" style="color:var(--danger);">Forced password change is pending — this user must set a new password on their next login.</p>' : ''}
    <div class="grid grid-2" style="margin-top:14px;">
      <div class="card">
        <h4>Contact</h4>
        <p class="detail-item"><strong>Phone:</strong> ${escapeHtml(String(u.country_code || ''))} ${escapeHtml(String(u.phone || ''))}</p>
        <p class="detail-item"><strong>Login username:</strong> @${escapeHtml(String(u.username || ''))}</p>
        <p class="detail-item"><strong>Email:</strong> ${escapeHtml(String(u.email || 'Not set'))}</p>
        <p class="detail-item"><strong>Registered:</strong> ${formatDate(u.created_at)}</p>
      </div>
      <div class="card">
        <h4>Clinical</h4>
        <p class="detail-item"><strong>Child:</strong> ${escapeHtml(String(u.child_name || 'Not set'))}</p>
        <p class="detail-item"><strong>Diagnosis:</strong> ${escapeHtml(String(u.diagnosis || 'Not specified'))}</p>
        <p class="detail-item"><strong>Address:</strong> ${escapeHtml(String(u.address || 'Not set'))}</p>
        <p class="detail-item"><strong>Activity:</strong> ${Number(data.stats.appointments)} appointments · ${Number(data.stats.assessments)} assessments · ${Number(data.stats.gaitSessions)} gait sessions</p>
      </div>
    </div>
    <div class="modal-section">
      <div class="tags" style="flex-wrap:wrap;">
        <a class="btn btn-outline btn-sm" target="_blank" href="/api/admin/export/user/${u.id}/report.docx">Profile DOCX</a>
        ${patientExports}
        ${manage ? `
          <button class="btn btn-primary btn-sm" id="um-edit">Edit</button>
          <button class="btn btn-outline btn-sm" id="um-reset">Reset Password</button>
          <button class="btn btn-outline btn-sm" id="um-status">Set Status</button>
          <button class="btn btn-outline btn-sm" id="um-delete" style="color:var(--danger);">Delete</button>
        ` : ''}
        ${currentIsSuper() ? `
          <button class="btn btn-outline btn-sm" id="um-purge" style="color:var(--danger); border-color:var(--danger);">Purge Permanently</button>
        ` : ''}
        <button class="btn btn-ghost btn-sm" id="um-close">Close</button>
      </div>
    </div>
    <div class="modal-section">
      <h4>Recent admin activity for this account</h4>
      ${data.activity.length
        ? `<table class="admin-table"><thead><tr><th>When</th><th>Admin</th><th>Action</th><th>Details</th></tr></thead><tbody>`
          + data.activity.map(a => `<tr><td>${formatDateTime(a.created_at)}</td><td>${escapeHtml(a.admin_name || 'System')}</td><td>${escapeHtml(ACTION_LABELS[a.action] || a.action)}</td><td>${escapeHtml(a.detail || '')}</td></tr>`).join('')
          + `</tbody></table>`
        : '<p class="empty-state">No recorded admin activity for this account yet.</p>'}
    </div>
  `;
  document.getElementById('um-close').addEventListener('click', hideModal);
  const eb = document.getElementById('um-edit');
  if (eb) eb.addEventListener('click', () => openUserEdit(u.id));
  const rb = document.getElementById('um-reset');
  if (rb) rb.addEventListener('click', () => openUserReset(u.id));
  const sb = document.getElementById('um-status');
  if (sb) sb.addEventListener('click', () => openUserStatus(u.id));
  const db = document.getElementById('um-delete');
  if (db) db.addEventListener('click', () => openUserDelete(u.id));
  const pb = document.getElementById('um-purge');
  if (pb) pb.addEventListener('click', () => openUserPurge(u.id));
}

function openUserCreate() {
  const modalContent = document.getElementById('modal-content');
  const modalBox = modalContent.parentElement;
  modalBox.classList.add('wide');
  modalContent.innerHTML = `
    <h2>Create Staff Account</h2>
    <p class="field-hint">New staff accounts start as 'Pending Approval' and cannot log in until an administrator activates them.</p>
    <div class="modal-section">
      <div class="field"><label for="uc-name">Full name *</label><input type="text" id="uc-name" maxlength="120" placeholder="e.g. Dr. Ayesha Khan"></div>
      <div class="field"><label for="uc-role">Role *</label>
        <select class="status-select" id="uc-role">
          <option value="clinician">Clinician</option>
          <option value="admin">Administrator</option>
          <option value="super_admin">Super Administrator</option>
        </select>
      </div>
      <div class="field-row">
        <div class="field"><label for="uc-country">Country code *</label>
          <select class="status-select" id="uc-country">
            <option value="+92">+92 (Pakistan)</option>
            <option value="+1">+1 (US/Canada)</option>
            <option value="+44">+44 (UK)</option>
            <option value="+971">+971 (UAE)</option>
            <option value="+966">+966 (Saudi Arabia)</option>
          </select>
        </div>
        <div class="field"><label for="uc-phone">Phone *</label><input type="tel" id="uc-phone" maxlength="15" placeholder="3XXXXXXXXX"></div>
      </div>
      <div class="field"><label for="uc-email">Email (optional)</label><input type="email" id="uc-email" maxlength="120" placeholder="name@example.com"></div>
      <div class="field-row">
        <div class="field"><label for="uc-password">Password</label><input type="text" id="uc-password" maxlength="100" placeholder="Leave blank to auto-generate"></div>
        <div class="field"><label style="display:flex; align-items:center; gap:8px; padding-top:16px;"><input type="checkbox" id="uc-generate"> Generate a temporary password</label></div>
      </div>
    </div>
    <div id="uc-msg" class="form-msg"></div>
    <div class="editor-actions">
      <button class="btn btn-primary" id="uc-save">Create Account</button>
      <button class="btn btn-ghost" id="uc-cancel">Cancel</button>
    </div>
  `;
  showModal();
  document.getElementById('uc-cancel').addEventListener('click', hideModal);
  document.getElementById('uc-generate').addEventListener('change', (e) => {
    document.getElementById('uc-password').disabled = e.target.checked;
    if (e.target.checked) document.getElementById('uc-password').value = '';
  });
  document.getElementById('uc-save').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = 'Creating...';
    const msgEl = document.getElementById('uc-msg');
    try {
      const payload = {
        guardianName: document.getElementById('uc-name').value.trim(),
        role: document.getElementById('uc-role').value,
        countryCode: document.getElementById('uc-country').value,
        phone: document.getElementById('uc-phone').value.trim(),
        email: document.getElementById('uc-email').value.trim(),
        password: document.getElementById('uc-password').value,
        generate: document.getElementById('uc-generate').checked
      };
      const res = await fetch('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not create the account.');
      showFormMsg(msgEl, data.tempPassword ? `${data.message} Temporary password (share once): ${data.tempPassword}` : data.message, 'success');
      loadUsers();
      setTimeout(hideModal, 8000);
    } catch (err) {
      showFormMsg(msgEl, err.message, 'error');
      btn.disabled = false;
      btn.textContent = 'Create Account';
    }
  });
}

async function openUserEdit(id) {
  const modalContent = document.getElementById('modal-content');
  const modalBox = modalContent.parentElement;
  modalBox.classList.add('wide');
  modalContent.innerHTML = '<p class="empty-state">Loading...</p>';
  showModal();
  let u;
  try {
    const res = await fetch(`/api/admin/users/${id}`);
    if (!res.ok) throw new Error();
    u = (await res.json()).user;
  } catch (err) {
    modalContent.innerHTML = '<p class="empty-state">Could not load this profile.</p>';
    return;
  }
  const isSuper = currentIsSuper();
  const allowRole = isSuper && window.currentAdmin.id !== u.id;
  const roleOptions = ['patient', 'clinician', 'admin', 'super_admin']
    .map(r => `<option value="${r}" ${u.role === r ? 'selected' : ''}>${ROLE_LABELS[r]}</option>`).join('');
  modalContent.innerHTML = `
    <h2>Edit Account — ${escapeHtml(userFullName(u))}</h2>
    <div class="modal-section">
      <div class="field"><label for="ue-name">Full name *</label><input type="text" id="ue-name" maxlength="120" value="${escapeHtml(u.guardian_name || '')}"></div>
      <div class="field"><label for="ue-child">Child name</label><input type="text" id="ue-child" maxlength="120" value="${escapeHtml(u.child_name || '')}"></div>
      <div class="field"><label for="ue-diagnosis">Diagnosis / notes</label><input type="text" id="ue-diagnosis" maxlength="255" value="${escapeHtml(u.diagnosis || '')}"></div>
      <div class="field-row">
        <div class="field"><label for="ue-country">Country code</label>
          <select class="status-select" id="ue-country">
            <option value="+92" ${u.country_code === '+92' ? 'selected' : ''}>+92 (Pakistan)</option>
            <option value="+1" ${u.country_code === '+1' ? 'selected' : ''}>+1 (US/Canada)</option>
            <option value="+44" ${u.country_code === '+44' ? 'selected' : ''}>+44 (UK)</option>
            <option value="+971" ${u.country_code === '+971' ? 'selected' : ''}>+971 (UAE)</option>
            <option value="+966" ${u.country_code === '+966' ? 'selected' : ''}>+966 (Saudi Arabia)</option>
          </select>
        </div>
        <div class="field"><label for="ue-phone">Phone *</label><input type="tel" id="ue-phone" maxlength="15" value="${escapeHtml(u.phone || '')}"></div>
      </div>
      <div class="field"><label for="ue-email">Email</label><input type="email" id="ue-email" maxlength="120" value="${escapeHtml(u.email || '')}"></div>
      <div class="field"><label for="ue-address">Address</label><input type="text" id="ue-address" maxlength="255" value="${escapeHtml(u.address || '')}"></div>
      ${isSuper ? `
      <div class="field"><label for="ue-username">Login username @${escapeHtml(u.username || '')}</label>
        <input type="text" id="ue-username" maxlength="15" value="${escapeHtml(String(u.username || '').replace(/^\+/, ''))}" placeholder="Digits only, 7–15">
        <p class="field-hint">Super admin only — changing this changes the username the account signs in with.</p>
      </div>
      ` : ''}
      <div class="field">
        <label for="ue-role">Role</label>
        <select class="status-select" id="ue-role" ${allowRole ? '' : 'disabled'}>
          ${roleOptions}
        </select>
        ${allowRole ? '' : '<p class="field-hint">Only a Super Administrator can change roles (and never their own).</p>'}
      </div>
      <p class="field-hint">Changing the phone number creates a new login username. Username is currently @${escapeHtml(u.username || '')}.</p>
    </div>
    <div id="ue-msg" class="form-msg"></div>
    <div class="editor-actions">
      <button class="btn btn-primary" id="ue-save">Save Changes</button>
      <button class="btn btn-ghost" id="ue-cancel">Cancel</button>
    </div>
  `;
  document.getElementById('ue-cancel').addEventListener('click', hideModal);
  document.getElementById('ue-save').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = 'Saving...';
    const msgEl = document.getElementById('ue-msg');
    const roleEl = document.getElementById('ue-role');
    try {
      const payload = {
        guardian_name: document.getElementById('ue-name').value.trim(),
        child_name: document.getElementById('ue-child').value.trim(),
        diagnosis: document.getElementById('ue-diagnosis').value.trim(),
        country_code: document.getElementById('ue-country').value,
        phone: document.getElementById('ue-phone').value.trim(),
        email: document.getElementById('ue-email').value.trim(),
        address: document.getElementById('ue-address').value.trim(),
        role: roleEl.disabled ? undefined : roleEl.value
      };
      const usernameEl = document.getElementById('ue-username');
      if (usernameEl) payload.username = usernameEl.value.trim();
      const res = await fetch(`/api/admin/users/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not save changes.');
      showFormMsg(msgEl, data.username !== u.username ? `${data.message} New login username: ${data.username}` : data.message, 'success');
      loadUsers();
      setTimeout(hideModal, 7000);
    } catch (err) {
      showFormMsg(msgEl, err.message, 'error');
      btn.disabled = false;
      btn.textContent = 'Save Changes';
    }
  });
}

async function openUserReset(id) {
  const modalContent = document.getElementById('modal-content');
  modalContent.innerHTML = '<p class="empty-state">Loading...</p>';
  showModal();
  let u;
  try {
    const res = await fetch(`/api/admin/users/${id}`);
    if (!res.ok) throw new Error();
    u = (await res.json()).user;
  } catch (err) {
    modalContent.innerHTML = '<p class="empty-state">Could not load this profile.</p>';
    return;
  }
  modalContent.innerHTML = `
    <h2>Reset Password</h2>
    <p class="field-hint">For ${escapeHtml(userFullName(u))} (@${escapeHtml(u.username || '')}). This overrides their current password immediately — they will need the new one to log in.</p>
    <div class="modal-section">
      <div class="field"><label for="ur-password">New password (min 6 characters)</label><input type="text" id="ur-password" maxlength="100" placeholder="Enter a new password"></div>
      <div class="field"><label style="display:flex; align-items:center; gap:8px;"><input type="checkbox" id="ur-generate"> Generate a temporary password</label></div>
      <div class="field"><label style="display:flex; align-items:center; gap:8px;"><input type="checkbox" id="ur-force"> Force password change on next login</label></div>
    </div>
    <div id="ur-msg" class="form-msg"></div>
    <div class="editor-actions">
      <button class="btn btn-primary" id="ur-save">Set New Password</button>
      <button class="btn btn-ghost" id="ur-cancel">Cancel</button>
    </div>
  `;
  document.getElementById('ur-cancel').addEventListener('click', hideModal);
  const genEl = document.getElementById('ur-generate');
  if (genEl) genEl.addEventListener('change', () => {
    document.getElementById('ur-password').disabled = genEl.checked;
    if (genEl.checked) {
      document.getElementById('ur-password').value = '';
      document.getElementById('ur-force').checked = true;
    }
  });
  document.getElementById('ur-save').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = 'Saving...';
    const msgEl = document.getElementById('ur-msg');
    try {
      const payload = {
        newPassword: document.getElementById('ur-password').value,
        generate: genEl ? genEl.checked : false,
        forceChange: document.getElementById('ur-force').checked
      };
      const res = await fetch(`/api/admin/users/${id}/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not reset the password.');
      showFormMsg(msgEl, data.tempPassword ? `${data.message} Temporary password (share once): ${data.tempPassword}` : data.message, 'success');
      setTimeout(hideModal, 8000);
    } catch (err) {
      showFormMsg(msgEl, err.message, 'error');
      btn.disabled = false;
      btn.textContent = 'Set New Password';
    }
  });
}

async function openUserStatus(id) {
  const modalContent = document.getElementById('modal-content');
  modalContent.innerHTML = '<p class="empty-state">Loading...</p>';
  showModal();
  let u;
  try {
    const res = await fetch(`/api/admin/users/${id}`);
    if (!res.ok) throw new Error();
    u = (await res.json()).user;
  } catch (err) {
    modalContent.innerHTML = '<p class="empty-state">Could not load this profile.</p>';
    return;
  }
  modalContent.innerHTML = `
    <h2>Change Account Status — ${escapeHtml(userFullName(u))}</h2>
    <p class="field-hint">Non-active accounts are blocked from logging in. Pending staff accounts become able to log in once set to Active.</p>
    <div class="modal-section">
      <div class="field"><label for="us-status">Status</label>
        <select class="status-select" id="us-status">
          <option value="pending" ${u.status === 'pending' ? 'selected' : ''}>Pending Approval</option>
          <option value="active" ${u.status === 'active' ? 'selected' : ''}>Active</option>
          <option value="suspended" ${u.status === 'suspended' ? 'selected' : ''}>Suspended</option>
          <option value="deactivated" ${u.status === 'deactivated' ? 'selected' : ''}>Deactivated</option>
        </select>
      </div>
    </div>
    <div id="us-msg" class="form-msg"></div>
    <div class="editor-actions">
      <button class="btn btn-primary" id="us-save">Update Status</button>
      <button class="btn btn-ghost" id="us-cancel">Cancel</button>
    </div>
  `;
  document.getElementById('us-cancel').addEventListener('click', hideModal);
  document.getElementById('us-save').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = 'Updating...';
    const msgEl = document.getElementById('us-msg');
    try {
      const payload = { status: document.getElementById('us-status').value };
      const res = await fetch(`/api/admin/users/${id}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not update the status.');
      showFormMsg(msgEl, data.message, 'success');
      loadUsers();
      setTimeout(hideModal, 6000);
    } catch (err) {
      showFormMsg(msgEl, err.message, 'error');
      btn.disabled = false;
      btn.textContent = 'Update Status';
    }
  });
}

async function openUserDelete(id) {
  const modalContent = document.getElementById('modal-content');
  modalContent.innerHTML = '<p class="empty-state">Loading...</p>';
  showModal();
  let u;
  try {
    const res = await fetch(`/api/admin/users/${id}`);
    if (!res.ok) throw new Error();
    u = (await res.json()).user;
  } catch (err) {
    modalContent.innerHTML = '<p class="empty-state">Could not load this profile.</p>';
    return;
  }
  modalContent.innerHTML = `
    <h2 style="color:var(--danger);">Delete Account — ${escapeHtml(userFullName(u))}</h2>
    <p class="field-hint">This is a <strong>soft delete</strong>: the account is hidden, cannot log in, and is excluded from the user list, but its records are retained for the audit trail.</p>
    <div class="modal-section">
      <div class="field"><label for="ud-confirm">Type <strong>DELETE</strong> to confirm</label><input type="text" id="ud-confirm" maxlength="10" autocomplete="off"></div>
    </div>
    <div id="ud-msg" class="form-msg"></div>
    <div class="editor-actions">
      <button class="btn btn-primary" id="ud-save" disabled style="background:var(--danger);">Confirm Delete</button>
      <button class="btn btn-ghost" id="ud-cancel">Cancel</button>
    </div>
  `;
  document.getElementById('ud-cancel').addEventListener('click', hideModal);
  const confirmEl = document.getElementById('ud-confirm');
  const saveBtn = document.getElementById('ud-save');
  confirmEl.addEventListener('input', () => {
    saveBtn.disabled = confirmEl.value.trim().toUpperCase() !== 'DELETE';
  });
  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    saveBtn.textContent = 'Deleting...';
    const msgEl = document.getElementById('ud-msg');
    try {
      const res = await fetch(`/api/admin/users/${id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: 'DELETE' })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not delete the account.');
      showFormMsg(msgEl, data.message, 'success');
      loadUsers();
      setTimeout(hideModal, 6000);
    } catch (err) {
      showFormMsg(msgEl, err.message, 'error');
      saveBtn.disabled = false;
      saveBtn.textContent = 'Confirm Delete';
    }
  });
}

async function openUserPurge(id) {
  const modalContent = document.getElementById('modal-content');
  modalContent.innerHTML = '<p class="empty-state">Loading...</p>';
  showModal();
  let u;
  try {
    const res = await fetch(`/api/admin/users/${id}`);
    if (!res.ok) throw new Error();
    u = (await res.json()).user;
  } catch (err) {
    modalContent.innerHTML = '<p class="empty-state">Could not load this profile.</p>';
    return;
  }
  modalContent.innerHTML = `
    <h2 style="color:var(--danger);">Permanently Purge — ${escapeHtml(userFullName(u))}</h2>
    <p class="field-hint">This <strong>permanently erases</strong> the account, its appointments, assessments, gait sessions, uploads, and audit entries. It cannot be undone.</p>
    <div class="modal-section">
      <div class="field"><label for="up-confirm">Type <strong>PURGE</strong> to confirm</label><input type="text" id="up-confirm" maxlength="10" autocomplete="off"></div>
    </div>
    <div id="up-msg" class="form-msg"></div>
    <div class="editor-actions">
      <button class="btn btn-primary" id="up-save" disabled style="background:var(--danger);">Purge Permanently</button>
      <button class="btn btn-ghost" id="up-cancel">Cancel</button>
    </div>
  `;
  document.getElementById('up-cancel').addEventListener('click', hideModal);
  const confirmEl = document.getElementById('up-confirm');
  const saveBtn = document.getElementById('up-save');
  confirmEl.addEventListener('input', () => {
    saveBtn.disabled = confirmEl.value.trim().toUpperCase() !== 'PURGE';
  });
  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    saveBtn.textContent = 'Purging...';
    const msgEl = document.getElementById('up-msg');
    try {
      const res = await fetch(`/api/admin/users/${id}/purge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not purge the account.');
      showFormMsg(msgEl, data.message, 'success');
      loadUsers();
      setTimeout(hideModal, 6000);
    } catch (err) {
      showFormMsg(msgEl, err.message, 'error');
      saveBtn.disabled = false;
      saveBtn.textContent = 'Purge Permanently';
    }
  });
}

function setupAuditSection() {
  document.getElementById('audit-action-filter').addEventListener('change', (e) => {
    auditMgr.action = e.target.value;
    auditMgr.page = 1;
    loadAudit();
  });
}

function auditRowHtml(log) {
  const isDestructive = log.action === 'delete_user' || log.action === 'purge_user';
  return `
    <tr>
      <td>${formatDateTime(log.created_at)}</td>
      <td>${escapeHtml(log.admin_name || 'System')}</td>
      <td><span class="status-badge status-${isDestructive ? 'cancelled' : 'confirmed'}">${escapeHtml(ACTION_LABELS[log.action] || log.action)}</span></td>
      <td>${log.target_type === 'user' ? 'user #' + escapeHtml(String(log.target_id)) : escapeHtml(String(log.target_type || ''))}</td>
      <td>${escapeHtml(log.detail || '')}</td>
    </tr>`;
}

async function loadAudit() {
  const body = document.getElementById('audit-body');
  body.innerHTML = '<tr><td colspan="5">Loading...</td></tr>';
  const params = new URLSearchParams({ page: String(auditMgr.page), perPage: String(auditMgr.pageSize) });
  if (auditMgr.action !== 'all') params.set('action', auditMgr.action);
  try {
    const res = await fetch(`/api/admin/audit-logs?${params}`);
    if (!res.ok) throw new Error();
    const data = await res.json();
    auditMgr.totalPages = data.pages;
    auditMgr.total = data.total;
    body.innerHTML = data.logs.length
      ? data.logs.map(auditRowHtml).join('')
      : '<tr><td colspan="5">No audit entries yet.</td></tr>';
    renderManagerPagination('audit-pagination', auditMgr, loadAudit);
  } catch (err) {
    body.innerHTML = '<tr><td colspan="5">Could not load the audit log.</td></tr>';
  }
}

// ---- Settings section (clinic profile + SMTP + backup) ----
function setupSettingsSection() {
  const form = document.getElementById('settings-form');
  if (!form) return;
  const hint = document.getElementById('settings-role-hint');
  const isSuper = currentIsSuper();
  const smtpInputs = ['smtp-host', 'smtp-port', 'smtp-secure', 'smtp-user', 'smtp-pass', 'smtp-from-name', 'smtp-from-email'].map(id => document.getElementById(id));
  const smtpTestBtn = document.getElementById('smtp-test-btn');
  if (!isSuper) {
    form.querySelectorAll('input').forEach(i => i.disabled = true);
    document.getElementById('settings-save-btn').disabled = true;
    if (smtpTestBtn) smtpTestBtn.disabled = true;
    hint.textContent = 'You are signed in as an administrator. Reading settings — only a Super Administrator can edit them.';
  } else {
    hint.textContent = 'Signed in as Super Administrator — changes apply to every report immediately.';
  }
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = document.getElementById('settings-msg');
    msg.textContent = 'Saving...';
    try {
      const res = await fetch('/api/admin/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clinic_name: document.getElementById('settings-name').value,
          clinic_address: document.getElementById('settings-address').value,
          clinic_phone: document.getElementById('settings-phone').value,
          clinic_email: document.getElementById('settings-email').value,
          smtp_host: document.getElementById('smtp-host').value,
          smtp_port: document.getElementById('smtp-port').value,
          smtp_secure: document.getElementById('smtp-secure').checked ? 'true' : 'false',
          smtp_user: document.getElementById('smtp-user').value,
          smtp_pass: document.getElementById('smtp-pass').value,
          smtp_from_name: document.getElementById('smtp-from-name').value,
          smtp_from_email: document.getElementById('smtp-from-email').value
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not save settings.');
      msg.textContent = 'Saved.';
      setTimeout(() => { msg.textContent = ''; }, 2500);
      const badge = document.getElementById('smtp-status-badge');
      if (badge) badge.textContent = data.smtpConfigured ? 'Email (SMTP) is configured and ready.' : 'Email (SMTP) not configured yet.';
    } catch (err) {
      msg.textContent = err.message;
    }
  });
  if (smtpTestBtn) {
    smtpTestBtn.addEventListener('click', async () => {
      const tmsg = document.getElementById('smtp-test-msg');
      tmsg.textContent = 'Sending test…';
      try {
        const res = await fetch('/api/admin/settings/smtp-test', { method: 'POST' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Test failed.');
        tmsg.style.color = '#2F7A4D';
        tmsg.textContent = data.message;
      } catch (err) {
        tmsg.style.color = '#B3452F';
        tmsg.textContent = err.message;
      }
    });
  }
  const backupBtn = document.getElementById('backup-download-btn');
  if (backupBtn) backupBtn.addEventListener('click', () => { window.location.href = '/api/admin/backup'; });
}

async function loadSettings() {
  try {
    const res = await fetch('/api/admin/settings');
    if (!res.ok) throw new Error();
    const data = await res.json();
    const clinic = data.clinic || {};
    const smtp = data.smtp || {};
    document.getElementById('settings-name').value = clinic.clinic_name || '';
    document.getElementById('settings-address').value = clinic.clinic_address || '';
    document.getElementById('settings-phone').value = clinic.clinic_phone || '';
    document.getElementById('settings-email').value = clinic.clinic_email || '';
    document.getElementById('smtp-host').value = smtp.smtp_host || '';
    document.getElementById('smtp-port').value = smtp.smtp_port || '587';
    document.getElementById('smtp-secure').checked = smtp.smtp_secure === true;
    document.getElementById('smtp-user').value = smtp.smtp_user || '';
    document.getElementById('smtp-pass').value = '';
    document.getElementById('smtp-pass').placeholder = smtp.smtp_has_pass ? '••••••  (leave blank to keep the saved password)' : 'Password (shown only while setting up)';
    document.getElementById('smtp-from-name').value = smtp.smtp_from_name || '';
    document.getElementById('smtp-from-email').value = smtp.smtp_from_email || '';
    const badge = document.getElementById('smtp-status-badge');
    if (badge) badge.textContent = data.smtpConfigured
      ? 'Configured — email replies will be sent from the address below.'
      : 'Not configured yet — add your mail host/credentials to send email replies from the Messages tab.';
  } catch (err) {
    const msg = document.getElementById('settings-msg');
    if (msg) msg.textContent = 'Could not load settings.';
  }
}

// ---- In-app notification bell ----
function bellHtml(n) {
  const iconMap = { new_booking: '📅', new_patient: '👩‍⚕️', staff_created: '👥', staff_approved: '✅' };
  const link = (n.link || '').split('#')[1];
  return `<a href="#" class="bell-item${n.read ? '' : ' bell-unread'}" data-id="${n.id}" data-target="${escapeHtml(link || '')}">
    <span class="bell-icon">${iconMap[n.type] || '🔔'}</span>
    <span class="bell-text">${escapeHtml(n.message)}<small>${formatDateTime(n.created_at)}</small></span>
  </a>`;
}

async function loadBellNotifications() {
  const list = document.getElementById('bell-list');
  if (!list) return;
  try {
    const res = await fetch('/api/admin/notifications?limit=15');
    if (!res.ok) throw new Error();
    const data = await res.json();
    list.innerHTML = data.items.length
      ? data.items.map(bellHtml).join('')
      : '<div class="bell-empty">No notifications yet.</div>';
    list.querySelectorAll('.bell-item').forEach(item => {
      item.addEventListener('click', async (e) => {
        e.preventDefault();
        await markNotificationRead(item.dataset.id);
        const target = item.dataset.target;
        if (target) document.querySelector(`.admin-nav-link[data-target="${target}"]`)?.click();
      });
    });
  } catch (err) {
    list.innerHTML = '<div class="bell-empty">Could not load notifications.</div>';
  }
}

async function refreshBellCount() {
  const badge = document.getElementById('bell-badge');
  if (!badge) return;
  try {
    const res = await fetch('/api/admin/notifications/unread-count');
    if (!res.ok) throw new Error();
    const { unread } = await res.json();
    badge.textContent = unread;
    badge.style.display = unread > 0 ? 'inline-flex' : 'none';
  } catch (err) { /* quiet */ }
}

function pollBellCount() {
  refreshBellCount();
  setInterval(refreshBellCount, 30000);
}

function setupBell() {
  const bell = document.getElementById('admin-bell');
  if (!bell) return;
  const toggle = document.getElementById('bell-toggle');
  const panel = document.getElementById('bell-panel');
  toggle.addEventListener('click', () => {
    const open = panel.style.display !== 'none';
    panel.style.display = open ? 'none' : 'block';
    toggle.setAttribute('aria-expanded', String(!open));
    if (!open) loadBellNotifications();
  });
  document.addEventListener('click', (e) => {
    if (!bell.contains(e.target)) {
      panel.style.display = 'none';
      toggle.setAttribute('aria-expanded', 'false');
    }
  });
  const readAll = document.getElementById('bell-read-all');
  if (readAll) readAll.addEventListener('click', async () => {
    await fetch('/api/admin/notifications/read-all', { method: 'POST' });
    loadBellNotifications();
    refreshBellCount();
  });
}

async function markNotificationRead(id) {
  await fetch(`/api/admin/notifications/${id}/read`, { method: 'POST' });
  refreshBellCount();
}

// ---- Utilities ----
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
function formatDate(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d)) return dateStr;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
function showFormMsg(el, message, type) {
  if (!el) return;
  el.textContent = message;
  el.className = 'form-msg ' + (type || 'error');
  el.style.display = 'block';
}
