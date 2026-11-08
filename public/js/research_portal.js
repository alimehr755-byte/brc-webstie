// ---- Multi-Plane Coronal Research Portal (comprehensive dashboard) ----
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
  spine: ['lateral_trunk_lean_max', 'head_lateral_tilt_max', 'shoulder_asymmetry_index']
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
  shoulder_drop_max: 'Shoulder Drop Max (deg)'
};

const NORMATIVE_WAVEFORM_BANDS = {
  knee: {
    sagittal: { L: [0, 60], R: [0, 60] },
    frontal: { L: [0, 10], R: [0, 10] },
    transverse: null
  },
  hip: {
    sagittal: { L: [-10, 40], R: [-10, 40] },
    frontal: { L: [-5, 10], R: [-5, 10] },
    transverse: null
  },
  ankle: {
    sagittal: { L: [-10, 20], R: [-10, 20] },
    frontal: null,
    transverse: null
  }
};

function normativeBand(joint, plane, side) {
  const j = NORMATIVE_WAVEFORM_BANDS[joint];
  if (!j) return null;
  const p = j[plane];
  if (!p) return null;
  return p[side] || (side === 'B' ? p.L : null);
}

const ALL_METRICS = Object.keys(METRIC_LABELS);
const GMFCS_LEVELS = ['I','II','III','IV','V'];

let currentNormative = [];

const NORMATIVE_METRIC_MAP = {
  knee: { sagittal: 'knee_flex', frontal: 'knee_valgus', transverse: null },
  hip: { sagittal: 'hip_flex', frontal: 'hip_ab_abd', transverse: null },
  ankle: { sagittal: 'ankle_angle', frontal: null, transverse: null },
  pelvis: { sagittal: 'pelvic_obliquity_mean', frontal: 'pelvic_obliquity_mean', transverse: null },
  spine: { sagittal: 'lateral_trunk_lean_max', frontal: 'lateral_trunk_lean_max', transverse: null },
};

async function fetchNormativeBands() {
  const f = getFilters();
  const params = new URLSearchParams({ joint: f.joint, plane: f.plane, side: f.side, sex: f.sex });
  if (f.ageMin) params.set('age', f.ageMin);
  try {
    const data = await fetchJson('/api/gait/research/normative?' + params.toString());
    currentNormative = data.bands || [];
  } catch (e) {
    currentNormative = [];
  }
}

function dbNormativeBand(joint, plane, side) {
  const metric = NORMATIVE_METRIC_MAP[joint] && NORMATIVE_METRIC_MAP[joint][plane];
  if (!metric) return null;
  const row = currentNormative.find(b => b.joint === joint && b.plane === plane && b.side === side && b.metric === metric);
  if (!row || row.p5 == null || row.p95 == null) return null;
  return [row.p5, row.p95];
}

let totalSystemPopulation = 0;
let currentPopulations = [];
let currentSessions = [];
let currentSummary = [];
let currentWaveform = { joint: 'knee', plane: 'sagittal', side: 'L', populations: [], samples: 120, phases: [] };
let currentLongitudinal = { patients: [], metric: 'cadence' };
let metricChart = null;
let cadenceChart = null;
let waveformChart = null;
let longitudinalChart = null;

function $(id) { return document.getElementById(id); }

function getFilters() {
  return {
    joint: $('filter-joint').value,
    plane: $('filter-plane').value,
    side: $('filter-side').value,
    sex: $('filter-sex').value,
    gmfcs: $('filter-gmfcs').value,
    pathology: $('filter-pathology').value,
    ageMin: $('filter-age-min').value,
    ageMax: $('filter-age-max').value
  };
}

function dataQuery(extra) {
  const f = getFilters();
  const params = new URLSearchParams();
  if (f.sex && f.sex !== 'all') params.set('gender', f.sex);
  if (f.gmfcs) params.set('gmfcs_level', f.gmfcs);
  if (f.pathology) params.set('population', f.pathology);
  if (f.ageMin) params.set('age_min', f.ageMin);
  if (f.ageMax) params.set('age_max', f.ageMax);
  if (extra) {
    Object.keys(extra).forEach(k => {
      const v = extra[k];
      if (v != null && v !== '') params.set(k, v);
    });
  }
  return params.toString();
}

function waveformQuery() {
  const f = getFilters();
  const params = new URLSearchParams(dataQuery());
  params.set('joint', f.joint);
  params.set('plane', f.plane);
  params.set('side', f.side);
  return params.toString();
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('Request failed: ' + res.status);
  return res.json();
}

async function loadDashboard() {
  const dq = dataQuery();
  try {
    if (!totalSystemPopulation) {
      const allPop = await fetchJson('/api/gait/research/populations');
      totalSystemPopulation = allPop.total || 0;
    }
    await fetchNormativeBands();
    const popQ = new URLSearchParams(dq);
    popQ.delete('population');
    const nichePop = await fetchJson('/api/gait/research/populations' + (popQ.toString() ? '?' + popQ.toString() : ''));
    currentPopulations = nichePop.populations || [];
    const nicheTotal = nichePop.total || 0;

    const coronal = await fetchJson('/api/gait/research/coronal' + (dq ? '?' + dq : ''));
    currentSessions = coronal.sessions || [];
    currentSummary = coronal.summary || [];

    const wq = waveformQuery();
    currentWaveform = await fetchJson('/api/gait/research/waveforms' + (wq ? '?' + wq : '')) || { populations: [], samples: 120, phases: [] };
    currentWaveform.joint = $('filter-joint').value;
    currentWaveform.plane = $('filter-plane').value;
    currentWaveform.side = $('filter-side').value;

    $('counter-total').textContent = totalSystemPopulation;
    $('counter-niche').textContent = nicheTotal;
    const f = getFilters();
    $('counter-label').textContent = 'Filters: ' + f.plane + ' / ' + f.joint + ' / side ' + f.side + ', ' + (f.sex || 'all') + ', GMFCS ' + (f.gmfcs || 'all') + ', ' + (f.pathology || 'all populations');

    $('kpi-filtered').textContent = currentSessions.length;
    $('kpi-pops').textContent = currentPopulations.length;
    const cadences = currentSessions.map(s => s.cadence).filter(v => v != null && Number.isFinite(v));
    const cadenceMean = cadences.length ? cadences.reduce((a,b)=>a+b,0)/cadences.length : null;
    $('kpi-cadence').textContent = cadenceMean != null ? cadenceMean.toFixed(2) : '-';
    const stances = currentSessions.map(s => s.stance_pct).filter(v => v != null && Number.isFinite(v));
    const stanceMean = stances.length ? stances.reduce((a,b)=>a+b,0)/stances.length : null;
    $('kpi-stance').textContent = stanceMean != null ? stanceMean.toFixed(1) + '%' : '-';

    populatePathologyDropdown();
    populateGMFCSDropdown();
    renderPopulationTable(nicheTotal);
    renderSessionTable();
    renderMetricChart();
    renderMultiplane();
    renderSpatiotemporal();
    renderCadenceChart();
    await loadProgression();
    renderDeformities();
    renderCompareSelectors();
    renderExportDropdown();
    renderRomTable();
  } catch (e) {
    console.error(e);
  }
}

function populateGMFCSDropdown() {
  const sel = $('filter-gmfcs');
  const current = sel.value;
  sel.innerHTML = '<option value="">Not specified</option>';
  GMFCS_LEVELS.forEach(l => {
    const opt = document.createElement('option');
    opt.value = l;
    opt.textContent = l;
    sel.appendChild(opt);
  });
  if (current) sel.value = current;
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
      <td>-</td>
      <td>${p.session_count}</td>
      <td>${pct}%</td>
      <td>${m.pelvic_obliquity_mean && m.pelvic_obliquity_mean.mean != null ? m.pelvic_obliquity_mean.mean : '-'}</td>
      <td>${m.knee_valgus_mean && m.knee_valgus_mean.mean != null ? m.knee_valgus_mean.mean : '-'}</td>
    </tr>`;
  }).join('') + `<tr style="font-weight:700;"><td>Total</td><td>-</td><td>${nicheTotal}</td><td>100%</td><td colspan="2"></td></tr>`;
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
    <td>${escapeHtml(s.gmfcs_level || '-')}</td>
    <td>${escapeHtml(s.gender || '-')}</td>
    <td>${s.age_years != null ? s.age_years : '-'}</td>
    <td>${s.cadence != null ? Number(s.cadence).toFixed(2) : '-'}</td>
    <td>${s.frontal_video || s.sagittal_video || s.combined_video || s.third_video ? `<a class="btn btn-ghost btn-sm" href="/api/gait/sessions/${s.session_id}/video/frontal" target="_blank" rel="noopener">Frontal</a> ${s.sagittal_video ? `<a class="btn btn-ghost btn-sm" href="/api/gait/sessions/${s.session_id}/video/sagittal" target="_blank" rel="noopener">Sagittal</a>` : ''}${s.combined_video ? `<a class="btn btn-ghost btn-sm" href="/api/gait/sessions/${s.session_id}/video/combined" target="_blank" rel="noopener">Combined</a>` : ''}${s.third_video ? `<a class="btn btn-ghost btn-sm" href="/api/gait/sessions/${s.session_id}/video/third" target="_blank" rel="noopener">Third</a>` : ''}` : '—'}</td>
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
    backgroundColor: ['#1E3C82', '#46B4DC', '#2F7A4D', '#C99436', '#B3452F', '#6B4C9A'][idx % 6]
  }));
  metricChart = new Chart(canvas, {
    type: 'bar',
    data: { labels, datasets },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } }, scales: { y: { beginAtZero: true } } }
  });
}

function ensureChart(callback) {
  if (typeof Chart !== 'undefined') return callback();
  setTimeout(() => ensureChart(callback), 150);
}

function renderMultiplane() {
  ensureChart(renderWaveformChart);
  renderMultiplaneTable();
}

function renderWaveformChart() {
  const canvas = $('waveform-chart');
  const note = $('waveform-note');
  const showNorm = $('show-normative') && $('show-normative').checked;
  if (!canvas) return;
  if (waveformChart) waveformChart.destroy();
  const w = currentWaveform;
  if (!w.populations || !w.populations.length) {
    canvas.style.display = 'none';
    if (note) note.textContent = 'No waveform data for the selected plane/joint/side and filters.';
    return;
  }
  canvas.style.display = 'block';
  if (note) note.textContent = 'Mean gait-cycle curves (0–100% samples) by population for ' + w.plane + ' / ' + w.joint + ' / side ' + w.side + '. Shaded bands show mean ± SD.';
  const labels = Array.from({ length: w.samples || 120 }, (_, i) => Math.round((i / Math.max(1, (w.samples || 120) - 1)) * 100));
  const colors = ['#1E3C82', '#46B4DC', '#2F7A4D', '#C99436', '#B3452F', '#6B4C9A', '#8E44AD', '#16A085'];
  const datasets = [];
  const band = showNorm ? dbNormativeBand(w.joint, w.plane, w.side) : null;
  if (band) {
    datasets.push({
      label: '',
      data: labels.map(() => band[1]),
      borderWidth: 0,
      showLine: true,
      borderColor: 'transparent',
      pointRadius: 0,
      backgroundColor: '#C994361a'
    });
    datasets.push({
      label: 'Normative range',
      data: labels.map(() => band[0]),
      borderWidth: 0,
      showLine: true,
      borderColor: 'transparent',
      pointRadius: 0,
      backgroundColor: '#C994361a',
      fill: '-1'
    });
  }
  w.populations.slice(0, 8).forEach((pop, idx) => {
    const color = colors[idx % colors.length];
    const means = pop.means || [];
    const sds = pop.sds || [];
    const upper = means.map((v, i) => v != null && sds[i] != null ? v + sds[i] : null);
    const lower = means.map((v, i) => v != null && sds[i] != null ? v - sds[i] : null);
    datasets.push({
      label: pop.diagnosis || 'Unknown',
      data: labels.map((_, i) => (i < means.length ? means[i] : null)),
      borderColor: color,
      backgroundColor: color + '22',
      fill: false,
      tension: 0.2,
      pointRadius: 0,
      borderWidth: 2
    });
    datasets.push({
      label: (pop.diagnosis || 'Unknown') + ' — SD band',
      data: upper,
      borderWidth: 0,
      showLine: true,
      borderColor: 'transparent',
      pointRadius: 0,
      backgroundColor: color + '22',
      fill: '+1'
    });
    datasets.push({
      label: '',
      data: lower,
      borderWidth: 0,
      showLine: true,
      borderColor: 'transparent',
      pointRadius: 0,
      backgroundColor: color + '22',
      fill: '-1'
    });
  });
  waveformChart = new Chart(canvas, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'bottom',
          labels: {
            filter: (item) => item.text !== '' && !item.text.includes('SD band')
          }
        }
      },
      scales: {
        x: { title: { display: true, text: 'Gait Cycle (%)' }, min: 0, max: 100 },
        y: { title: { display: true, text: 'Angle (deg)' } }
      }
    }
  });
}



function renderMultiplaneTable() {
  const tbody = $('multiplane-table-body');
  const pops = currentWaveform.populations || [];
  if (!pops.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-state">No cross-disability waveform data for the selected filters.</td></tr>';
    return;
  }
  const control = pops.find(p => /healthy/.test(String(p.diagnosis || '')));
  const controlMean = control ? meanOfMeans(control) : null;
  tbody.innerHTML = pops.map(p => {
    const m = meanOfMeans(p);
    const range = rangeOfMeans(p);
    const delta = controlMean != null && m != null ? (m - controlMean) : null;
    return `<tr>
      <td><strong>${escapeHtml(p.diagnosis || 'Unknown')}</strong></td>
      <td>${p.n}</td>
      <td>${m != null ? m.toFixed(2) : '-'}</td>
      <td>${avgSD(p) != null ? avgSD(p).toFixed(2) : '-'}</td>
      <td>${range != null ? range.toFixed(2) : '-'}</td>
      <td>${delta != null ? delta.toFixed(2) : (control ? '-' : 'no control')}</td>
    </tr>`;
  }).join('');
}

function meanOfMeans(pop) {
  const vals = (pop.means || []).filter(v => v != null && Number.isFinite(v));
  return vals.length ? vals.reduce((a,b)=>a+b,0)/vals.length : null;
}
function avgSD(pop) {
  const vals = (pop.sds || []).filter(v => v != null && Number.isFinite(v));
  return vals.length ? vals.reduce((a,b)=>a+b,0)/vals.length : null;
}
function rangeOfMeans(pop) {
  const vals = (pop.means || []).filter(v => v != null && Number.isFinite(v));
  if (!vals.length) return null;
  return Math.max(...vals) - Math.min(...vals);
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

async function loadProgression() {
  const f = getFilters();
  const params = new URLSearchParams();
  if (f.pathology) params.set('diagnosis', f.pathology);
  if (f.sex && f.sex !== 'all') params.set('gender', f.sex);
  if (f.gmfcs) params.set('gmfcs_level', f.gmfcs);
  if (f.ageMin) params.set('age_min', f.ageMin);
  if (f.ageMax) params.set('age_max', f.ageMax);
  params.set('metric', $('longitudinal-metric') ? $('longitudinal-metric').value : 'cadence');
  try {
    currentLongitudinal = await fetchJson('/api/gait/research/progression?' + params.toString()) || { patients: [] };
  } catch (e) {
    currentLongitudinal = { patients: [] };
  }
  renderLongitudinalChart();
}

function renderLongitudinalChart() {
  const canvas = $('longitudinal-chart');
  if (!canvas) return;
  if (longitudinalChart) longitudinalChart.destroy();
  const patients = (currentLongitudinal && currentLongitudinal.patients) || [];
  const metric = $('longitudinal-metric') ? $('longitudinal-metric').value : 'cadence';
  if (!patients.length) {
    canvas.style.display = 'none';
    return;
  }
  canvas.style.display = 'block';
  const colors = ['#1E3C82', '#46B4DC', '#2F7A4D', '#C99436', '#B3452F', '#6B4C9A', '#8E44AD', '#16A085'];
  const datasets = patients.slice(0, 8).map((p, idx) => {
    const sessions = (p.sessions || []).sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
    const labels = sessions.map(s => s.created_at ? s.created_at.slice(0, 10) : '');
    const data = sessions.map(s => s[metric]);
    return {
      label: `${escapeHtml(p.patient)} ${p.diagnosis ? '(' + escapeHtml(p.diagnosis) + ')' : ''}`,
      data,
      borderColor: colors[idx % colors.length],
      backgroundColor: colors[idx % colors.length] + '22',
      fill: false,
      tension: 0.2,
      pointRadius: 4,
      pointHoverRadius: 6,
      borderWidth: 2,
    };
  });
  // Shared x-axis = sorted unique session dates across patients
  const allDates = new Set();
  patients.forEach(p => (p.sessions || []).forEach(s => { if (s.created_at) allDates.add(s.created_at.slice(0, 10)); }));
  const xLabels = Array.from(allDates).sort();
  longitudinalChart = new Chart(canvas, {
    type: 'line',
    data: { labels: xLabels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { position: 'bottom' } },
      scales: {
        x: { title: { display: true, text: 'Session date' } },
        y: { title: { display: true, text: metric }, beginAtZero: false },
      }
    }
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
    html += '<div class="rp-heat-row">';
    html += `<div><strong>${escapeHtml(dx)}</strong> (n=${v.total})</div>`;
    ['frontal', 'sagittal', 'rotational'].forEach(plane => {
      const count = v[plane];
      const alpha = Math.min(0.85, 0.15 + (count / maxTotal) * 0.7);
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
  tbody.innerHTML = '<tr><td colspan="5" class="empty-state">ROM observations are available in individual gait reports.</td></tr>';
}

function renderExportDropdown() {
  // handled in renderCompareSelectors
}

function setupTabs() {
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

function setupPlaneButtons() {
  ['sagittal','frontal','transverse'].forEach(plane => {
    const btn = $('plane-' + plane);
    if (!btn) return;
    btn.addEventListener('click', () => {
      $('filter-plane').value = plane;
      document.querySelectorAll('.rp-plane-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      loadDashboard();
    });
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
      const q = dataQuery({ pop1, pop2, metric });
      const res = await fetch('/api/gait/research/compare?' + q);
      if (!res.ok) throw new Error('Comparison failed');
      const data = await res.json();
      const r1 = data.pop1, r2 = data.pop2;
      resultsEl.innerHTML = `
        <table class="admin-table">
          <thead><tr><th>Group</th><th>N</th><th>Mean</th><th>SD</th><th>Welch t</th><th>df</th><th>p-value</th><th>95% CI</th><th>Signif.</th></tr></thead>
          <tbody>
            <tr>
              <td><strong>${escapeHtml(r1.diagnosis)}</strong></td>
              <td>${r1.n}</td>
              <td>${r1.mean != null ? r1.mean : '-'}</td>
              <td>${r1.sd != null ? r1.sd : '-'}</td>
              <td>${data.welch_t != null ? data.welch_t : '-'}</td>
              <td>${data.welch_df != null ? data.welch_df : '-'}</td>
              <td>${data.welch_p != null ? data.welch_p : '-'}</td>
              <td>${data.mean_diff_ci95 ? `[${data.mean_diff_ci95[0]}, ${data.mean_diff_ci95[1]}]` : '-'}</td>
              <td>${data.significant ? '<span style="color:#B3452F;font-weight:700;">p&lt;0.05</span>' : '<span style="color:#2F7A4D;">ns</span>'}</td>
            </tr>
            <tr>
              <td><strong>${escapeHtml(r2.diagnosis)}</strong></td>
              <td>${r2.n}</td>
              <td>${r2.mean != null ? r2.mean : '-'}</td>
              <td>${r2.sd != null ? r2.sd : '-'}</td>
              <td colspan="5" style="text-align:center;">Mean difference (${escapeHtml(r1.diagnosis)} − ${escapeHtml(r2.diagnosis)}): ${data.welch_t != null ? ((r1.mean != null && r2.mean != null) ? (r1.mean - r2.mean).toFixed(2) : '-') : '-'}</td>
            </tr>
          </tbody>
        </table>
        ${data.welch_p != null && data.welch_p < 0.001 ? '<p style="color:#B3452F;font-size:.8rem;margin-top:8px;">Highly significant difference between groups.</p>' : ''}
        ${r1.n < 5 || r2.n < 5 ? '<p style="color:#B3452F;font-size:.8rem;margin-top:8px;">Warning: small sample size (n &lt; 5) - results may not be reliable.</p>' : ''}
      `;
    } catch (e) {
      resultsEl.innerHTML = '<p class="empty-state">Comparison failed. Check that both populations have analyzed sessions.</p>';
    }
  });
}

function setupExport() {
  const csvBtn = $('research-export-btn');
  if (csvBtn) {
    csvBtn.addEventListener('click', () => {
      const pop = $('research-export-pop').value;
      const params = new URLSearchParams(dataQuery());
      if (pop) params.set('population', pop); else params.delete('population');
      window.open('/api/gait/research/export?' + params.toString(), '_blank');
    });
  }
  const jsonBtn = $('research-export-json-btn');
  if (jsonBtn) {
    jsonBtn.addEventListener('click', () => {
      const pop = $('research-export-pop').value;
      const params = new URLSearchParams(dataQuery());
      if (pop) params.set('population', pop); else params.delete('population');
      window.open('/api/gait/research/export.json?' + params.toString(), '_blank');
    });
  }
  const pdfBtn = $('research-export-pdf-btn');
  if (pdfBtn) {
    pdfBtn.addEventListener('click', () => {
      const pop = $('research-export-pop').value;
      const params = new URLSearchParams(dataQuery());
      if (pop) params.set('population', pop); else params.delete('population');
      window.open('/api/gait/research/export.pdf?' + params.toString(), '_blank');
    });
  }
}

function setupFilters() {
  $('apply-filters-btn').addEventListener('click', loadDashboard);
  $('reset-filters-btn').addEventListener('click', () => {
    $('filter-joint').value = 'knee';
    $('filter-plane').value = 'sagittal';
    $('filter-side').value = 'L';
    $('filter-sex').value = 'all';
    $('filter-gmfcs').value = '';
    $('filter-pathology').value = '';
    $('filter-age-min').value = '';
    $('filter-age-max').value = '';
    document.querySelectorAll('.rp-plane-btn').forEach(b => b.classList.remove('active'));
    $('plane-sagittal').classList.add('active');
    loadDashboard();
  });
  $('filter-joint').addEventListener('change', loadDashboard);
  const norm = $('show-normative');
  if (norm) norm.addEventListener('change', renderWaveformChart);
  setupPlaneButtons();
}

document.addEventListener('DOMContentLoaded', () => {
  setupTabs();
  setupFilters();
  setupCompare();
  setupExport();
  const longMetric = $('longitudinal-metric');
  const longRefresh = $('longitudinal-refresh-btn');
  if (longMetric) longMetric.addEventListener('change', loadProgression);
  if (longRefresh) longRefresh.addEventListener('click', loadProgression);
  loadDashboard();
});
