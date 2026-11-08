p = "routes/gait.js"
s = open(p, encoding="utf-8").read()
marker = "module.exports = router;"
if s.count(marker) != 1:
    raise SystemExit("marker count " + str(s.count(marker)))
new_routes = """// ---- Research: multi-planar JSON export ----
router.get('/research/export.json', requireAuth, (req, res) => {
  const population = req.query.population || null;
  const gender = req.query.gender || null;
  const gmfcsLevel = req.query.gmfcs_level || null;
  const ageMin = req.query.age_min ? Number(req.query.age_min) : null;
  const ageMax = req.query.age_max ? Number(req.query.age_max) : null;
  const plane = req.query.plane || null;

  let where = "WHERE s.status IN ('analyzed', 'reviewed') AND s.results IS NOT NULL";
  const params = [];
  if (population) { where += " AND COALESCE(NULLIF(s.diagnosis, ''), u.diagnosis) = ?"; params.push(population); }
  if (gender && gender !== 'all') { where += " AND s.gender = ?"; params.push(gender); }
  if (gmfcsLevel && gmfcsLevel !== 'unspecified') { where += " AND s.gmfcs_level = ?"; params.push(gmfcsLevel); }
  if (ageMin != null && Number.isFinite(ageMin)) { where += " AND s.age_years >= ?"; params.push(ageMin); }
  if (ageMax != null && Number.isFinite(ageMax)) { where += " AND s.age_years <= ?"; params.push(ageMax); }

  const rows = db.prepare(`
    SELECT s.id, u.child_name, s.diagnosis, s.gmfcs_level, s.age_years, s.gender, s.created_at, s.results
    FROM gait_sessions s
    JOIN users u ON u.id = s.user_id
    ${where}
    ORDER BY s.created_at ASC
  `).all(...params);

  const out = rows.map(r => {
    const j = safeJson(r.results) || {};
    const cv3d = j.cv3d || {};
    let timeseries = cv3d.timeseries || {};
    if (plane && timeseries[plane]) {
      timeseries = { [plane]: timeseries[plane] };
    }
    const profile = j.profile || {};
    return {
      session_id: r.id,
      patient: r.child_name || '',
      diagnosis: r.diagnosis || '',
      gmfcs_level: r.gmfcs_level || '',
      age_years: r.age_years,
      gender: r.gender,
      created_at: r.created_at,
      cycle: j.cycle || {},
      cv3d: {
        timeseries,
        frontal_angles_3d: cv3d.frontal_angles_3d || {},
        symmetry: cv3d.symmetry || {}
      },
      deformities: {
        frontal: Array.isArray(profile.frontal && profile.frontal.deformities) ? profile.frontal.deformities : [],
        sagittal: Array.isArray(profile.sagittal && profile.sagittal.deformities) ? profile.sagittal.deformities : [],
        rotational: Array.isArray(profile.rotational && profile.rotational.deformities) ? profile.rotational.deformities : []
      },
      metrics: ((j.cv && j.cv.frontal && j.cv.frontal.metrics) || {})
    };
  });

  const stamp = new Date().toISOString().split('T')[0];
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="research_export_${population || 'all'}_${stamp}.json"`);
  res.send(JSON.stringify(out, null, 2));
});

// ---- Research: PDF report for the current filtered cohort ----
router.get('/research/export.pdf', requireAuth, async (req, res) => {
  const population = req.query.population || null;
  const gender = req.query.gender || null;
  const gmfcsLevel = req.query.gmfcs_level || null;
  const ageMin = req.query.age_min ? Number(req.query.age_min) : null;
  const ageMax = req.query.age_max ? Number(req.query.age_max) : null;

  let where = "WHERE s.status IN ('analyzed', 'reviewed') AND s.results IS NOT NULL";
  const params = [];
  if (population) { where += " AND COALESCE(NULLIF(s.diagnosis, ''), u.diagnosis) = ?"; params.push(population); }
  if (gender && gender !== 'all') { where += " AND s.gender = ?"; params.push(gender); }
  if (gmfcsLevel && gmfcsLevel !== 'unspecified') { where += " AND s.gmfcs_level = ?"; params.push(gmfcsLevel); }
  if (ageMin != null && Number.isFinite(ageMin)) { where += " AND s.age_years >= ?"; params.push(ageMin); }
  if (ageMax != null && Number.isFinite(ageMax)) { where += " AND s.age_years <= ?"; params.push(ageMax); }

  const rows = db.prepare(`
    SELECT s.id, u.child_name, s.diagnosis, s.gmfcs_level, s.age_years, s.gender, s.body_mass_kg, s.height_cm, s.clinician_name, s.created_at, s.results
    FROM gait_sessions s
    JOIN users u ON u.id = s.user_id
    ${where}
    ORDER BY s.created_at ASC
  `).all(...params);

  const esc = str => String(str == null ? '' : str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const clinic = getClinic();
  const stamp = new Date().toISOString().split('T')[0];
  const filename = `research_report_${population || 'all'}_${stamp}.pdf`;

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${esc(filename)}"`);

  const doc = new PDFDocument({ margin: 50, bufferPages: true });
  doc.pipe(res);

  try { doc.image(LOGO_PATH, 50, 38, { width: 62 }); } catch (e) { /* noop */ }
  doc.fontSize(16).fillColor('#1E3C82').text(clinic.clinic_name, 122, 42, { width: 380 });
  doc.fontSize(8.5).fillColor('#5A5D55').text(clinic.clinic_address, 122, 62, { width: 380 });
  doc.fontSize(8.5).fillColor('#5A5D55').text(`${clinic.clinic_email}   �   ${clinic.clinic_phone}`, 122, 74, { width: 380 });
  doc.moveTo(50, 104).lineTo(545, 104).strokeColor('#E1EEF8').lineWidth(1).stroke();
  doc.fontSize(14).fillColor('#C99436').text('Gait Research Cohort Report', 50, 114);
  doc.fontSize(7.5).fillColor('#9FC3E0').text(`Generated ${new Date().toLocaleString()}   �   Confidential � research use only`, 50, 130);
  doc.y = 150;

  const filterParts = [];
  if (population) filterParts.push(`Population: ${esc(population)}`);
  if (gender && gender !== 'all') filterParts.push(`Sex: ${esc(gender)}`);
  if (gmfcsLevel && gmfcsLevel !== 'unspecified') filterParts.push(`GMFCS: ${esc(gmfcsLevel)}`);
  if (ageMin != null && Number.isFinite(ageMin)) filterParts.push(`Age >= ${ageMin}`);
  if (ageMax != null && Number.isFinite(ageMax)) filterParts.push(`Age <= ${ageMax}`);
  doc.fontSize(9).fillColor('#232520').text(`Filters: ${filterParts.length ? filterParts.join(' ; ') : 'none'}`, { width: 495 });
  doc.y += 8;

  let byDx = {};
  rows.forEach(r => {
    const dx = esc(r.diagnosis || 'Unknown');
    if (!byDx[dx]) byDx[dx] = 0;
    byDx[dx] += 1;
  });
  doc.fontSize(10).fillColor('#1E3C82').text(`Cohort summary: ${rows.length} analyzed session(s)`, { width: 495 });
  doc.y += 6;
  Object.entries(byDx).forEach(([dx, n]) => {
    doc.fontSize(8.5).fillColor('#232520').text(`- ${dx}: ${n} session(s)`, { width: 495 });
    doc.y += 5;
  });
  doc.y += 6;

  let y = doc.y;
  const rowHeight = 16;
  doc.fontSize(7.5).fillColor('#1E3C82').text('Session', 50, y, { width: 40 });
  doc.text('Patient', 110, y, { width: 90 });
  doc.text('Diagnosis', 200, y, { width: 95 });
  doc.text('GMFCS', 295, y, { width: 40 });
  doc.text('Age', 335, y, { width: 35 });
  doc.text('Sex', 370, y, { width: 30 });
  doc.text('Cadence', 400, y, { width: 50 });
  doc.text('Stance %', 450, y, { width: 45 });
  y += rowHeight + 4;
  doc.moveTo(50, y).lineTo(545, y).strokeColor('#E1EEF8').stroke();
  y += 6;

  rows.forEach(r => {
    const j = safeJson(r.results) || {};
    const cycle = j.cycle || {};
    const cadence = typeof cycle.cadence_cycles_per_second === 'number' ? cycle.cadence_cycles_per_second.toFixed(2) : '-';
    const stance = typeof cycle.stance_pct === 'number' ? cycle.stance_pct.toFixed(1) : '-';
    const vals = [
      esc(r.id),
      esc(r.child_name || '-'),
      esc(r.diagnosis || '-'),
      esc(r.gmfcs_level || '-'),
      esc(r.age_years != null ? r.age_years : '-'),
      esc(r.gender || '-'),
      esc(cadence),
      esc(stance)
    ];
    const xs = [50, 110, 200, 295, 335, 370, 400, 450];
    const widths = [40, 90, 95, 40, 35, 30, 50, 45];
    vals.forEach((v, i) => {
      doc.fontSize(7).fillColor('#232520').text(v, xs[i], y, { width: widths[i], ellipsis: true });
    });
    y += rowHeight;
    if (y > 720) {
      doc.addPage();
      y = 50;
    }
  });

  doc.end();
});

"""
s = s.replace(marker, new_routes + marker)
open(p, "w", encoding="utf-8").write(s)
print("backend appended")