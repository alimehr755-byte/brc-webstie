// public/js/assessment.js
// Loads the questionnaire, renders it grouped by domain, submits answers,
// and shows the preliminary summary (or a previous result if one already exists).

let allQuestionIds = [];

document.addEventListener('DOMContentLoaded', async () => {
  const authed = await checkAuth();
  if (!authed) {
    window.location.href = '/login.html';
    return;
  }

  const existing = await checkExistingAssessment();
  if (existing) {
    showExisting(existing);
  } else {
    await loadForm();
  }

  document.getElementById('retake-link').addEventListener('click', async (e) => {
    e.preventDefault();
    document.getElementById('already-submitted').style.display = 'none';
    await loadForm();
  });
});

async function checkAuth() {
  try {
    const res = await fetch('/api/auth/me');
    return res.ok;
  } catch (err) {
    return false;
  }
}

async function checkExistingAssessment() {
  try {
    const res = await fetch('/api/assessments/mine');
    if (!res.ok) return null;
    const { assessments } = await res.json();
    return assessments.length > 0 ? assessments[0] : null;
  } catch (err) {
    return null;
  }
}

function showExisting(assessment) {
  const block = document.getElementById('already-submitted');
  block.style.display = 'block';
  document.getElementById('previous-summary').textContent = assessment.preliminarySummary;
  if (assessment.adminConclusion) {
    document.getElementById('previous-conclusion-block').style.display = 'block';
    document.getElementById('previous-conclusion').textContent = assessment.adminConclusion;
  }
}

async function loadForm() {
  const form = document.getElementById('assessment-form');
  const container = document.getElementById('questions-container');
  form.style.display = 'block';

  try {
    const res = await fetch('/api/assessments/questions');
    const { domains, answerOptions } = await res.json();

    container.innerHTML = domains.map(domain => `
      <div class="mb-24">
        <h3 style="margin-bottom:4px;">${escapeHtml(domain.label)}</h3>
        ${domain.questions.map(q => `
          <div class="field">
            <label>${escapeHtml(q.text)}</label>
            <div class="radio-pill-group">
              ${answerOptions.map(opt => `
                <label class="radio-pill">
                  <input type="radio" name="${q.id}" value="${opt.value}">
                  ${escapeHtml(opt.label)}
                </label>
              `).join('')}
            </div>
          </div>
        `).join('')}
      </div>
    `).join('');

    // Radio inputs are visually hidden (styled as pills), so the browser's native
    // "required" validation can't focus them and silently blocks submission with
    // no visible error. We validate manually in handleSubmit instead.
    allQuestionIds = domains.flatMap(d => d.questions.map(q => q.id));

    form.addEventListener('submit', handleSubmit);
  } catch (err) {
    container.innerHTML = '<p class="empty-state">Could not load the assessment. Please refresh.</p>';
  }
}

async function handleSubmit(e) {
  e.preventDefault();
  const form = e.target;
  const msgBox = document.getElementById('assessment-msg');
  const submitBtn = document.getElementById('assessment-submit');

  const formData = new FormData(form);
  const responses = {};
  for (const [key, value] of formData.entries()) {
    if (key === 'additionalNotes') continue;
    responses[key] = parseInt(value, 10);
  }

  // Manual validation: radios are hidden for the pill styling, so native
  // "required" validation can't run. Check every question was answered ourselves.
  const missing = allQuestionIds.filter(id => !(id in responses));
  if (missing.length > 0) {
    showFormMsg(msgBox, `Please answer all questions before submitting — ${missing.length} question(s) still need an answer.`, 'error');
    const firstMissingInput = form.querySelector(`input[name="${missing[0]}"]`);
    if (firstMissingInput) {
      firstMissingInput.closest('.field').scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    return;
  }

  submitBtn.disabled = true;
  submitBtn.textContent = 'Submitting...';

  try {
    const res = await fetch('/api/assessments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ responses, additionalNotes: document.getElementById('additionalNotes').value.trim() })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not submit assessment.');

    form.style.display = 'none';
    const resultCard = document.getElementById('result-card');
    resultCard.style.display = 'block';
    document.getElementById('result-summary').textContent = data.summary;
    document.getElementById('result-domains').innerHTML = data.domainResults.map(d => `
      <div class="appt-item">
        <div><strong>${escapeHtml(d.label)}</strong></div>
        <span class="status-badge ${d.flagged ? 'status-pending' : 'status-completed'}">${d.flagged ? 'For Review' : 'No Concern Flagged'}</span>
      </div>
    `).join('');
    resultCard.scrollIntoView({ behavior: 'smooth' });
  } catch (err) {
    showFormMsg(msgBox, err.message, 'error');
    submitBtn.disabled = false;
    submitBtn.textContent = 'Submit Assessment';
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
