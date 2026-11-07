// ---- Coronal Plane Research Portal (standalone page) ----
// Renders into #research-portal-body. No modal/popup is used.

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = String(str == null ? '' : str);
  return div.innerHTML;
}

// Cache for research data to avoid re-fetching
let _researchCache = null;
let _researchCacheTime = 0;
const RESEARCH_CACHE_TTL = 60000; // 1 minute

async function loadResearchPortal(body) {
  const now = Date.now();
  if (_researchCache && (now - _researchCacheTime) < RESEARCH_CACHE_TTL) {
    renderResearchPortal(body, _researchCache.popData, _researchCache.coronalData);
    return;
  }

  body.innerHTML = '<div style="text-align:center; padding:40px;"><p style="color:var(--ink-600);">Loading research data...</p><div style="width:40px; height:40px; border:4px solid #E1EEF8; border-top-color:#1E3C82; border-radius:50%; animation:spin 1s linear infinite; margin:12px auto;"></div></div><style>@keyframes spin{to{transform:rotate(360deg)}}</style>';
  try {
    const popRes = await fetch('/api/gait/research/populations');
    if (!popRes.ok) throw new Error('Failed to load populations');
    const popData = await popRes.json();

    const coronalRes = await fetch('/api/gait/research/coronal');
    if (!coronalRes.ok) throw new Error('Failed to load coronal data');
    const coronalData = await coronalRes.json();

    _researchCache = { popData, coronalData };
    _researchCacheTime = Date.now();

    renderResearchPortal(body, popData, coronalData);
  } catch (e) {
    body.innerHTML = '<p class="empty-state">Could not load research data. Please sign in and try again.</p>';
  }
}

function renderResearchPortal(body, popData, coronalData) {
  const populations = popData.populations || [];
  const summary = coronalData.summary || [];
  const totalSessions = coronalData.total || 0;

  const joints = ['Knee', 'Hip', 'Ankle', 'Pelvis', 'Shoulder', 'Trunk'];
  const jointMetrics = {
    'Knee': ['knee_valgus_mean', 'knee_valgus_off_max'],
    'Hip': ['pelvic_obliquity_mean', 'pelvic_obliquity_max'],
    'Ankle': ['step_width_mean', 'weight_shift_max'],
    'Pelvis': ['pelvic_obliquity_mean', 'pelvic_obliquity_max', 'coronal_load_symmetry'],
    'Shoulder': ['shoulder_asymmetry_index', 'shoulder_drop_max'],
    'Trunk': ['lateral_trunk_lean_max', 'head_lateral_tilt_max'],
  };

  const metrics = ['pelvic_obliquity_mean', 'lateral_trunk_lean_max', 'knee_valgus_mean',
    'step_width_mean', 'weight_shift_max', 'shoulder_asymmetry_index'];

  const metricLabels = {
    'pelvic_obliquity_mean': 'Pelvic Obliquity (deg)',
    'lateral_trunk_lean_max': 'Trunk Lean (deg)',
    'knee_valgus_mean': 'Knee Valgus (deg)',
    'step_width_mean': 'Step Width',
    'weight_shift_max': 'Weight Shift',
    'shoulder_asymmetry_index': 'Shoulder Asymmetry',
  };

  body.innerHTML = `
    <div class="gait-tabs" id="research-tabs">
      <button class="gait-tab active" data-tab="overview">Overview</button>
      <button class="gait-tab" data-tab="populations">Populations</button>
      <button class="gait-tab" data-tab="compare">Compare Groups</button>
      <button class="gait-tab" data-tab="export">Export</button>
    </div>

    <div id="research-tab-overview" class="gait-tab-panel" data-default="1">
      <h4 style="color:#1E3C82; margin-bottom:12px;">Coronal Plane Research Overview</h4>
      <div class="gait-kpis">
        <div class="gait-kpi">
          <p class="gait-kpi-label">Total Sessions</p>
          <p class="gait-kpi-value">${totalSessions}</p>
        </div>
        <div class="gait-kpi">
          <p class="gait-kpi-label">Populations</p>
          <p class="gait-kpi-value">${populations.length}</p>
        </div>
        <div class="gait-kpi">
          <p class="gait-kpi-label">Metrics Available</p>
          <p class="gait-kpi-value">${metrics.length}</p>
        </div>
      </div>
      <div class="mt-16">
        <h5 style="color:#1E3C82;">Population Breakdown</h5>
        <table class="admin-table mt-8">
          <thead><tr><th>Diagnosis</th><th>Sessions</th><th>Pelvic Obliquity (mean)</th><th>Trunk Lean (mean)</th><th>Knee Valgus (mean)</th></tr></thead>
          <tbody>
            ${summary.map(s => `
              <tr>
                <td><strong>${escapeHtml(s.diagnosis || 'Unknown')}</strong></td>
                <td>${s.session_count}</td>
                <td>${s.metrics.pelvic_obliquity_mean ? s.metrics.pelvic_obliquity_mean.mean + ' (n=' + s.metrics.pelvic_obliquity_mean.n + ')' : '-'}</td>
                <td>${s.metrics.lateral_trunk_lean_max ? s.metrics.lateral_trunk_lean_max.mean + ' (n=' + s.metrics.lateral_trunk_lean_max.n + ')' : '-'}</td>
                <td>${s.metrics.knee_valgus_mean ? s.metrics.knee_valgus_mean.mean + ' (n=' + s.metrics.knee_valgus_mean.n + ')' : '-'}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>

    <div id="research-tab-populations" class="gait-tab-panel">
      <h4 style="color:#1E3C82; margin-bottom:12px;">Population Counts</h4>
      <table class="admin-table">
        <thead><tr><th>Diagnosis</th><th>Sessions</th><th>Percentage</th></tr></thead>
        <tbody>
          ${populations.map(p => `
            <tr>
              <td><strong>${escapeHtml(p.diagnosis || 'Unknown')}</strong></td>
              <td>${p.session_count}</td>
              <td>${totalSessions > 0 ? Math.round((p.session_count / totalSessions) * 100) : 0}%</td>
            </tr>
          `).join('')}
          <tr style="font-weight:700;">
            <td>Total</td>
            <td>${totalSessions}</td>
            <td>100%</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div id="research-tab-compare" class="gait-tab-panel">
      <h4 style="color:#1E3C82; margin-bottom:12px;">Compare Groups</h4>
      <div class="grid grid-2" style="gap:12px;">
        <div class="field">
          <label>Group 1</label>
          <select id="research-pop1" class="status-select">
            ${populations.map(p => `<option value="${escapeHtml(p.diagnosis || '')}">${escapeHtml(p.diagnosis || 'Unknown')} (n=${p.session_count})</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label>Group 2</label>
          <select id="research-pop2" class="status-select">
            ${populations.map(p => `<option value="${escapeHtml(p.diagnosis || '')}">${escapeHtml(p.diagnosis || 'Unknown')} (n=${p.session_count})</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="field mt-12">
        <label>Metric</label>
        <select id="research-metric" class="status-select">
          ${metrics.map(m => `<option value="${m}">${metricLabels[m]}</option>`).join('')}
        </select>
      </div>
      <button class="btn btn-primary mt-12" id="research-compare-btn">Compare</button>
      <div id="research-compare-results" class="mt-16"></div>
    </div>

    <div id="research-tab-export" class="gait-tab-panel">
      <h4 style="color:#1E3C82; margin-bottom:12px;">Export Research Data</h4>
      <p style="color:var(--ink-600); font-size:.9rem;">Export coronal plane metrics to CSV for statistical analysis in Excel, SPSS, or R.</p>
      <div class="field mt-12">
        <label>Filter by population (optional)</label>
        <select id="research-export-pop" class="status-select">
          <option value="">All populations</option>
          ${populations.map(p => `<option value="${escapeHtml(p.diagnosis || '')}">${escapeHtml(p.diagnosis || 'Unknown')} (n=${p.session_count})</option>`).join('')}
        </select>
      </div>
      <button class="btn btn-primary mt-12" id="research-export-btn">Download CSV</button>
    </div>
  `;

  body.querySelectorAll('.gait-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      body.querySelectorAll('.gait-tab').forEach(t => t.classList.remove('active'));
      body.querySelectorAll('.gait-tab-panel').forEach(p => p.style.display = 'none');
      tab.classList.add('active');
      const panel = body.querySelector('#research-tab-' + tab.dataset.tab);
      if (panel) panel.style.display = 'block';
    });
  });
  body.querySelectorAll('.gait-tab-panel').forEach((p, i) => {
    p.style.display = i === 0 ? 'block' : 'none';
  });

  const compareBtn = body.querySelector('#research-compare-btn');
  if (compareBtn) {
    compareBtn.addEventListener('click', async () => {
      const pop1 = body.querySelector('#research-pop1').value;
      const pop2 = body.querySelector('#research-pop2').value;
      const metric = body.querySelector('#research-metric').value;
      const resultsEl = body.querySelector('#research-compare-results');
      resultsEl.innerHTML = '<p class="empty-state">Comparing...</p>';
      try {
        const res = await fetch(`/api/gait/research/compare?pop1=${encodeURIComponent(pop1)}&pop2=${encodeURIComponent(pop2)}&metric=${encodeURIComponent(metric)}`);
        if (!res.ok) throw new Error('Comparison failed');
        const data = await res.json();
        const r1 = data.pop1, r2 = data.pop2;
        resultsEl.innerHTML = `
          <table class="admin-table">
            <thead><tr><th>Group</th><th>N</th><th>Mean</th><th>SD</th><th>Cohen's d</th><th>Effect Size</th></tr></thead>
            <tbody>
              <tr><td><strong>${escapeHtml(r1.diagnosis)}</strong></td><td>${r1.n}</td><td>${r1.mean != null ? r1.mean : '-'}</td><td>${r1.sd != null ? r1.sd : '-'}</td><td rowspan="2">${data.cohens_d != null ? data.cohens_d : '-'}</td><td rowspan="2">${data.effect_size || '-'}</td></tr>
              <tr><td><strong>${escapeHtml(r2.diagnosis)}</strong></td><td>${r2.n}</td><td>${r2.mean != null ? r2.mean : '-'}</td><td>${r2.sd != null ? r2.sd : '-'}</td></tr>
            </tbody>
          </table>
          ${r1.n < 5 || r2.n < 5 ? '<p style="color:#B3452F; font-size:.8rem; margin-top:8px;">Warning: small sample size (n &lt; 5) - results may not be reliable.</p>' : ''}
        `;
      } catch (e) {
        resultsEl.innerHTML = '<p class="empty-state">Comparison failed. Check that both populations have analyzed sessions.</p>';
      }
    });
  }

  const exportBtn = body.querySelector('#research-export-btn');
  if (exportBtn) {
    exportBtn.addEventListener('click', () => {
      const pop = body.querySelector('#research-export-pop').value;
      window.open(`/api/gait/research/export?population=${encodeURIComponent(pop)}`, '_blank');
    });
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const body = document.getElementById('research-portal-body');
  if (body) loadResearchPortal(body);
});
