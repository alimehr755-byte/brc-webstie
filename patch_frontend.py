import re

# ---------- research_portal.js ----------
p = "public/js/research_portal.js"
s = open(p, encoding="utf-8").read()

def rep(old, new):
    global s
    if old not in s:
        raise SystemExit("NOT FOUND in research_portal.js: " + old[:90].replace("\n", " "))
    s = s.replace(old, new, 1)

# dataQuery should forward extra compare params
rep(
"""function dataQuery() {
  const f = getFilters();
  const params = new URLSearchParams();
""",
"""function dataQuery(extra) {
  const f = getFilters();
  const params = new URLSearchParams();
""")
rep(
"""  if (f.ageMax) params.set('age_max', f.ageMax);
  return params.toString();
}""",
"""  if (f.ageMax) params.set('age_max', f.ageMax);
  if (extra) {
    Object.keys(extra).forEach(k => {
      const v = extra[k];
      if (v != null && v !== '') params.set(k, v);
    });
  }
  return params.toString();
}""")

# normative bands config after METRIC_LABELS
rep(
"""  head_lateral_tilt_max: 'Head Lateral Tilt Max (deg)',
  shoulder_drop_max: 'Shoulder Drop Max (deg)'
};

const ALL_METRICS = Object.keys(METRIC_LABELS);""",
"""  head_lateral_tilt_max: 'Head Lateral Tilt Max (deg)',
  shoulder_drop_max: 'Shoulder Drop Max (deg)'
};

const ALL_METRICSS = Object.keys(METRIC_LABELS);
const GMFCS_LEVELS = ['I','II','III','IV','V'];

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

const ALL_METRICS = ALL_METRICSS;""")

# replace renderWaveformChart via regex
new_rw = """function renderWaveformChart() {
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
  const band = showNorm ? normativeBand(w.joint, w.plane, w.side) : null;
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

"""
s = re.sub(r"function renderWaveformChart\(\) \{[\s\S]*?\n\}", new_rw, s, count=1)

# setupExport with JSON/PDF
rep(
"""function setupExport() {
  const btn = $('research-export-btn');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const pop = $('research-export-pop').value;
    const params = new URLSearchParams(dataQuery());
    if (pop) params.set('population', pop); else params.delete('population');
    window.open('/api/gait/research/export?' + params.toString(), '_blank');
  });
}""",
"""function setupExport() {
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
}""")

# setupFilters: joint change reloads dashboard; normative checkbox re-renders waveform
rep(
"""  $('filter-joint').addEventListener('change', () => renderMetricChart());
  setupPlaneButtons();
}""",
"""  $('filter-joint').addEventListener('change', loadDashboard);
  const norm = $('show-normative');
  if (norm) norm.addEventListener('change', renderWaveformChart);
  setupPlaneButtons();
}""")

open(p, "w", encoding="utf-8").write(s)
print("research_portal.js patched")

# ---------- research-portal.html ----------
p = "public/research-portal.html"
s = open(p, encoding="utf-8").read()

def repH(old, new):
    global s
    if old not in s:
        raise SystemExit("NOT FOUND in research-portal.html: " + old[:90].replace("\n", " "))
    s = s.replace(old, new, 1)

repH(
"""          <div class="rp-chart-box"><canvas id="waveform-chart"></canvas></div>
          <p class="rp-note" id="waveform-note">Averaged gait-cycle curves (0–100%) by population. Shaded SD bands are not drawn in this demo; lines show mean curves.</p>""",
"""          <div class="rp-chart-box"><canvas id="waveform-chart"></canvas></div>
          <div style="margin-top:8px; display:flex; align-items:center; gap:8px;">
            <input type="checkbox" id="show-normative" checked>
            <label for="show-normative" style="font-size:.8rem; cursor:pointer;">Show normative reference range</label>
          </div>
          <p class="rp-note" id="waveform-note">Averaged gait-cycle curves (0–100%) by population. Shaded bands show mean ± SD.</p>""")

repH(
"""          <div class="rp-actions">
            <button class="btn btn-primary" id="research-export-btn" type="button">Download CSV</button>
          </div>""",
"""          <div class="rp-actions">
            <button class="btn btn-primary" id="research-export-btn" type="button">Download CSV</button>
            <button class="btn btn-primary" id="research-export-json-btn" type="button">Download JSON</button>
            <button class="btn btn-ghost" id="research-export-pdf-btn" type="button">Download PDF</button>
          </div>""")

open(p, "w", encoding="utf-8").write(s)
print("research-portal.html patched")

# ---------- gait.js renderReport metadata ----------
p = "public/js/gait.js"
s = open(p, encoding="utf-8").read()
old = """  const cycle = r.cycle;
  const stanceW = Math.max(2, cycle.stance_pct);"""
new = """  const metaHtml = `
    <div class="rp-section" style="margin-bottom:16px;">
      <h4 style="margin:0 0 8px;">Session &amp; research metadata</h4>
      <table class="admin-table" style="font-size:.86rem;">
        <tr><th>Session</th><td>#${escapeHtml(s.id)}</td><th>Status</th><td>${escapeHtml(s.status || '-')}</td></tr>
        <tr><th>Patient</th><td>${escapeHtml(s.child_name || '-')}</td><th>Diagnosis</th><td>${escapeHtml(s.diagnosis || 'Not specified')}</td></tr>
        <tr><th>GMFCS</th><td>${escapeHtml(s.gmfcs_level || '-')}</td><th>Sex</th><td>${escapeHtml(s.gender || '-')}</td></tr>
        <tr><th>Age</th><td>${s.age_years != null ? s.age_years : '-'}</td><th>Height / Mass</th><td>${s.height_cm != null ? s.height_cm + ' cm' : '-'} / ${s.body_mass_kg != null ? s.body_mass_kg + ' kg' : '-'}</td></tr>
        <tr><th>Clinician</th><td>${escapeHtml(s.clinician_name || '-')}</td><th>Created</th><td>${escapeHtml(s.created_at || '-')}</td></tr>
        <tr><th>Videos attached</th><td colspan="3">${[s.frontal_video, s.sagittal_video, s.combined_video, s.third_video].filter(Boolean).map(v => `<span style="font-size:.78rem; color:var(--ink-500);">${v.split('/').pop()}</span>`).join(' · ') || 'None attached'}</td></tr>
        ${s.notes ? `<tr><th>Notes</th><td colspan="3">${escapeHtml(s.notes)}</td></tr>` : ''}
      </table>
    </div>`;
  const cycle = r.cycle;
  const stanceW = Math.max(2, cycle.stance_pct);"""
rep(old, new)
open(p, "w", encoding="utf-8").write(s)
print("gait.js patched")