// ---- Coronal Plane Research Portal (comprehensive dashboard) ----
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = String(str == null ? '' : str);
  return div.innerHTML;
}

const JOINT_METRICS = {
  knee: ['knee_valgus_mean', 'knee_valgus_off_max'],
  hip: ['pelvic_obliquity_mean', 'pelvic_obliquity_max'],
  ankle: ['step_width_mean', 'weight_shift_max'],
  pelvis: ['pelvic_obliquity_mean', 'lateral_trunk_lean_max', 'head_lateral_tilt_max', 'shoulder_asymmetry_index'],
};

const METRIC_LABELS = {
  pelvic_obliquity_mean: 'Pelvic Obliquity Mean (deg)',
  pelvic_obliquity_max: 'Pelvic Obliquity Max (deg)',
  lateral_trunk_lean_max: 'Trunk Lean Max (deg)',
  knee_valgus_mean: 'Knee Valgus Mean (deg)',
  knee_valgus_off_max: 'Knee Valgus Off Max (deg)',
  step_width_mean: 'Step Width Mean',
  weight_shift_max: 'Weight Shift Max',
  shoulder_asymmetry_index: 'Shoulder Asymmetry Index',
  head_lateral_tilt_max: 'Head Lateral Tilt Max (deg)',
  shoulder_drop_max: 'Shoulder Drop Max (deg)',
};

const ALL_METRICS = Object.keys(METRIC_LABELS);

let totalSystemPopulation = 0;
let currentPopulations = [];
let currentSessions = [];
let currentSummary = [];
let metricChart = null;
let cadenceChart = null;

function $(id) { return document.getElementById(id); }

function getFilters() {
  return {
    joint: $('filter-joint').value,
    sex: $('filter-sex').value,
    pathology: $('filter-pathology').value,
    ageMin: $('filter-age-min').value,
    ageMax: $('filter-age-max').value,
  };
}

function buildQuery(extra) {
  const f = getFilters();
  const params = new URLSearchParams();
  if (f.sex && f.sex !== 'all') params.set('gender', f.sex);
  if (f.ageMin) params.set('age_min', f.ageMin);
  if (f.ageMax) params.set('age_max', f.ageMax);
  if (f.pathology) params.set('population', f.pathology);
  if (extra) {
    Object.keys(extra).forEach(k => {
      if (extra[k] != null && extra[k] !== '') params.set(k, extra[k]);
    });
  }
  return params.toString();
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('Request failed: ' + res.status);
  return res.json();
}

async function loadDashboard() {
  const q = buildQuery();
  try {
    // Total system population (unfiltered)
    if (!totalSystemPopulation) {
      const allPop = await fetchJson('/api/gait/research/populations');
      totalSystemPopulation = allPop.total || 0;
    }
    const nichePop = await fetchJson('/api/gait/research/populations' + (q ? '?' + q.replace(/population=[^&]*&?/, '') : ''));
    // Remove population param for population counts (counts by diagnosis should reflect sex/age filters only)
    const popParams = new URLSearchParams(q);
    popParams.delete('population');
    const popQ = popParams.toString();
    const nichePop2 = await fetchJson('/api/gait/research/populations' + (popQ ? '?' + popQ : ''));
    currentPopulations = nichePop2.populations || [];
    const nicheTotal = nichePop2.total || 0;

    const coronalQ = q;
    const coronal = await fetchJson('/api/gait/research/coronal' + (coronalQ ? '?' + coronalQ : ''));
    currentSessions = coronal.sessions || [];
    currentSummary = coronal.summary || [];

    // Counters
    $('counter-total').textContent = totalSystemPopulation;
    $('counter-niche').textContent = nicheTotal;
    const f = getFilters();
    $('counter-label').textContent = 'Filters: ' + (f.joint || 'knee') + ' joint, ' + (f.sex || 'all') + ', ' + (f.pathology || 'all populations');

    // KPIs
    $('kpi-filtered').textContent = currentSessions.length;
    $('kpi-pops').textContent = currentPopulations.length;
    const cadences = currentSessions.map(s => s.cadence).filter(v => v != null && Number.isFinite(v));
    const cadenceMean = cadences.length ? cadences.reduce((a,b)=>a+b,0)/cadences.length : null;
    $('kpi-cadence').textContent = cadenceMean != null ? cadenceMean.toFixed(2) : '-';
    const stances = currentSessions.map(s => s.stance_pct).filter(v => v != null && Number.isFinite(v));
    const stanceMean = stances.length ? stances.reduce((a,b)=>a+b,0)/stances.length : null;
    $('kpi-stance').textContent = stanceMean != null ? stanceMean.toFixed(1) + '%' : '-';

    populatePathologyDropdown();
    renderPopulationTable(nicheTotal);
    renderSessionTable();
    renderMetricChart();
    renderSpatiotemporal();
    renderCadenceChart();
    renderDeformities();
    renderCompareSelectors();
    renderExportDropdown();
    renderRomTable();
  } catch (e) {
    console.error(e);
  }
}

function populatePathologyDropdown() {
  const sel = $('filter-pathology');
  const current = sel.value;
  sel.innerHTML = '<option value="">All populations</option>';
  currentPopulations.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.diagnosis || '';
    opt.textContent = (p.diagnosis || 'Unknown') + ' (n=' + p.session_count + ')';
    sel.appendChild(opt);
  });
  if (current) sel.value = current;
}

function renderPopulationTable(nicheTotal) {
  const tbody = $('population-table-body');
  if (!currentPopulations.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-state">No populations found.</td></tr>';
    return;
  }
  tbody.innerHTML = currentPopulations.map(p => {
    const s = currentSummary.find(x => x.diagnosis === p.diagnosis) || { metrics: {} };
    const m = s.metrics || {};
    const pct = nicheTotal > 0 ? Math.round((p.session_count / nicheTotal) * 100) : 0;
    return `<tr>
      <td><strong>${escapeHtml(p.diagnosis || 'Unknown')}</strong></td>
      <td>${p.session_count}</td>
      <td>${pct}%</td>
      <td>${m.pelvic_obliquity_mean && m.pelvic_obliquity_mean.mean != null ? m.pelvic_obliquity_mean.mean : '-'}</td>
      <td>${m.lateral_trunk_lean_max && m.lateral_trunk_lean_max.mean != null ? m.lateral_trunk_lean_max.mean : '-'}</td>
      <td>${m.knee_valgus_mean && m.knee_valgus_mean.mean != null ? m.knee_valgus_mean.mean : '-'}</td>
    </tr>`;
  }).join('') + `<tr style="font-weight:700;"><td>Total</td><td>${nicheTotal}</td><td>100%</td><td colspan="3"></td></tr>`;
}

function renderSessionTable() {
  const tbody = $('session-table-body');
  if (!currentSessions.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty-state">No sessions found.</td></tr>';
    return;
  }
  tbody.innerHTML = currentSessions.map(s => `<tr>
    <td>${s.session_id}</td>
    <td>${escapeHtml(s.child_name || '-')}</td>
    <td>${escapeHtml(s.diagnosis || 'Unknown')}</td>
    <td>${escapeHtml(s.gender || '-')}</td>
    <td>${s.age_years != null ? s.age_years : '-'}</td>
    <td>${s.cadence != null ? Number(s.cadence).toFixed(2) : '-'}</td>
    <td>${s.stance_pct != null ? Number(s.stance_pct).toFixed(1) + '%' : '-'}</td>
  </tr>`).join('');
}

function renderMetricChart() {
  const canvas = $('metric-chart');
  if (!canvas) return;
  if (metricChart) metricChart.destroy();
  const joint = getFilters().joint;
  const metrics = JOINT_METRICS[joint] || ALL_METRICS.slice(0, 4);
  const labels = currentPopulations.map(p => p.diagnosis || 'Unknown');
  const datasets = metrics.map((m, idx) => ({
    label: METRIC_LABELS[m] || m,
    data: currentPopulations.map(p => {
      const s = currentSummary.find(x => x.diagnosis === p.diagnosis);
      const agg = s && s.metrics && s.metrics[m];
      return agg && agg.mean != null ? agg.mean : null;
    }),
    backgroundColor: ['#1E3C82', '#46B4DC', '#2F7A4D', '#C99436', '#B3452F', '#6B4C9A'][idx % 6],
  }));
  metricChart = new Chart(canvas, {
    type: 'bar',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { position: 'bottom' } },
      scales: { y: { beginAtZero: true } },
    }
  });
}

function renderSpatiotemporal() {
  const tbody = $('spatiotemporal-body');
  if (!currentSessions.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-state">No sessions found.</td></tr>';
    return;
  }
  const byDx = {};
  currentSessions.forEach(s => {
    const dx = s.diagnosis || 'Unknown';
    if (!byDx[dx]) byDx[dx] = [];
    byDx[dx].push(s);
  });
  tbody.innerHTML = Object.entries(byDx).map(([dx, sess]) => {
    const cad = sess.map(s => s.cadence).filter(v => v != null && Number.isFinite(v));
    const cyc = sess.map(s => s.cycle_seconds).filter(v => v != null && Number.isFinite(v));
    const st = sess.map(s => s.stance_pct).filter(v => v != null && Number.isFinite(v));
    const sw = sess.map(s => s.swing_pct).filter(v => v != null && Number.isFinite(v));
    const mean = arr => arr.length ? (arr.reduce((a,b)=>a+b,0)/arr.length) : null;
    return `<tr>
      <td><strong>${escapeHtml(dx)}</strong></td>
      <td>${sess.length}</td>
      <td>${mean(cad) != null ? mean(cad).toFixed(2) : '-'}</td>
      <td>${mean(cyc) != null ? mean(cyc).toFixed(2) : '-'}</td>
      <td>${mean(st) != null ? mean(st).toFixed(1) + '%' : '-'}</td>
      <td>${mean(sw) != null ? mean(sw).toFixed(1) + '%' : '-'}</td>
    </tr>`;
  }).join('');
}

function renderCadenceChart() {
  const canvas = $('cadence-chart');
  if (!canvas) return;
  if (cadenceChart) cadenceChart.destroy();
  const byDx = {};
  currentSessions.forEach(s => {
    const dx = s.diagnosis || 'Unknown';
    if (!byDx[dx]) byDx[dx] = [];
    byDx[dx].push(s);
  });
  const labels = Object.keys(byDx);
  const data = labels.map(dx => {
    const vals = byDx[dx].map(s => s.cadence).filter(v => v != null && Number.isFinite(v));
    return vals.length ? vals.reduce((a,b)=>a+b,0)/vals.length : 0;
  });
  cadenceChart = new Chart(canvas, {
    type: 'bar',
    data: { labels, datasets: [{ label: 'Mean Cadence (cycles/s)', data, backgroundColor: '#46B4DC' }] },
    options: { responsive: true, maintainAspectRatio: false, scales: { y: { beginAtZero: true } } }
  });
}

function renderDeformities() {
  const container = $('deformity-heatmap');
  if (!currentSessions.length) {
    container.innerHTML = '<p class="empty-state">No sessions found.</p>';
    return;
  }
  const byDx = {};
  currentSessions.forEach(s => {
    const dx = s.diagnosis || 'Unknown';
    if (!byDx[dx]) byDx[dx] = { frontal: 0, sagittal: 0, rotational: 0, total: 0 };
    const d = s.deformities || {};
    ['frontal', 'sagittal', 'rotational'].forEach(plane => {
      const arr = Array.isArray(d[plane]) ? d[plane] : [];
      byDx[dx][plane] += arr.length;
      byDx[dx].total += arr.length;
    });
  });
  const maxTotal = Math.max(1, ...Object.values(byDx).map(v => v.total));
  let html = '<div class="rp-heat-row"><div class="rp-heat-head">Population</div><div class="rp-heat-head">Frontal</div><div class="rp-heat-head">Sagittal</div><div class="rp-heat-head">Rotational</div></div>';
  Object.entries(byDx).forEach(([dx, v]) => {
    const intensity = v.total / maxTotal;
    html += '<div class="rp-heat-row">';
    html += `<div><strong>${escapeHtml(dx)}</strong> (n=${v.total})</div>`;
    ['frontal', 'sagittal', 'rotational'].forEach(plane => {
      const count = v[plane];
      const alpha = Math.min(0.85, 0.15 + (count / Math.max(1, maxTotal)) * 0.7);
      const bg = count > 0 ? `rgba(179,69,47,${alpha})` : 'rgba(232,244,253,0.6)';
      const color = count > 0 ? '#fff' : '#1E3C82';
      html += `<div class="rp-heat-cell" style="background:${bg}; color:${color};">${count}</div>`;
    });
    html += '</div>';
  });
  container.innerHTML = html;
}

function renderCompareSelectors() {
  const pop1 = $('research-pop1');
  const pop2 = $('research-pop2');
  const metric = $('research-metric');
  const exportPop = $('research-export-pop');
  const opts = currentPopulations.map(p => `<option value="${escapeHtml(p.diagnosis || '')}">${escapeHtml(p.diagnosis || 'Unknown')} (n=${p.session_count})</option>`).join('');
  if (pop1) { pop1.innerHTML = opts; if (pop1.options.length > 1) pop1.selectedIndex = 1; }
  if (pop2) { pop2.innerHTML = opts; }
  if (metric) {
    metric.innerHTML = ALL_METRICS.map(m => `<option value="${m}">${METRIC_LABELS[m]}</option>`).join('');
  }
  if (exportPop) {
    exportPop.innerHTML = '<option value="">All populations</option>' + opts;
  }
}

function renderRomTable() {
  const tbody = $('rom-table-body');
  let romRows = [];
  for (const s of currentSessions) {
    // ROM not included in coronal payload; skip (would need session detail endpoint)
  }
  tbody.innerHTML = '<tr><td colspan="5" class="empty-state">ROM observations are available in individual gait reports.</td></tr>';
}

function renderExportDropdown() {
  // already handled in renderCompareSelectors
}

// Tab switching
function setupTabs() {
  const body = document.querySelector('.dash-body');
  document.querySelectorAll('.gait-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.gait-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.gait-tab-panel').forEach(p => p.style.display = 'none');
      tab.classList.add('active');
      const panel = document.querySelector('#research-tab-' + tab.dataset.tab);
      if (panel) panel.style.display = 'block';
    });
  });
  document.querySelectorAll('.gait-tab-panel').forEach((p, i) => {
    p.style.display = i === 0 ? 'block' : 'none';
  });
}

function setupCompare() {
  const btn = $('research-compare-btn');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const pop1 = $('research-pop1').value;
    const pop2 = $('research-pop2').value;
    const metric = $('research-metric').value;
    const resultsEl = $('research-compare-results');
    resultsEl.innerHTML = '<p class="empty-state">Comparing...</p>';
    try {
      const q = buildQuery({ pop1, pop2, metric });
      const res = await fetch('/api/gait/research/compare?' + q);
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

function setupExport() {
  const btn = $('research-export-btn');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const pop = $('research-export-pop').value;
    const q = buildQuery({ population: pop });
    // buildQuery includes population from filter; override with selected export pop
    const params = new URLSearchParams(q);
    if (pop) params.set('population', pop); else params.delete('population');
    window.open('/api/gait/research/export?' + params.toString(), '_blank');
  });
}

function setupFilters() {
  $('apply-filters-btn').addEventListener('click', loadDashboard);
  $('reset-filters-btn').addEventListener('click', () => {
    $('filter-joint').value = 'knee';
    $('filter-sex').value = 'all';
    $('filter-pathology').value = '';
    $('filter-age-min').value = '';
    $('filter-age-max').value = '';
    loadDashboard();
  });
  $('filter-joint').addEventListener('change', () => {
    renderMetricChart();
  });
}

document.addEventListener('DOMContentLoaded', () => {
  setupTabs();
  setupFilters();
  setupCompare();
  setupExport();
  loadDashboard();
});
