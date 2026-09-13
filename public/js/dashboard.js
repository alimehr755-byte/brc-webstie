// public/js/dashboard.js
// Protects the dashboard page (redirects to login if no session),
// loads profile + appointment history, and handles new bookings.

const THERAPY_LABELS = {
  occupational_therapy: 'Occupational Therapy',
  speech_therapy: 'Speech Therapy',
  physical_therapy: 'Physical Therapy',
  behavior_therapy: 'Behavior Therapy',
  audio_verbal_therapy: 'Audio-Verbal Therapy',
  prosthetic_orthotic: 'Prosthetic / Orthotic',
  montessori: 'Montessori Program',
  school_readiness: 'School Readiness Program',
  other: 'Other'
};

document.addEventListener('DOMContentLoaded', async () => {
  const user = await loadProfile();
  if (!user) {
    window.location.href = '/login.html';
    return;
  }
  loadAppointments();
  loadAssessmentStatus();
  loadGaitStatus();
  setupOtherToggle();
  setupBookingForm();
});

async function loadProfile() {
  try {
    const res = await fetch('/api/auth/me');
    if (!res.ok) return null;
    const { user } = await res.json();

    if (user.must_change_password) {
      window.location.href = '/change-password.html';
      return null;
    }

    if (user.role === 'admin' || user.role === 'super_admin') {
      window.location.href = '/admin-dashboard.html';
      return null;
    }

    document.getElementById('dash-welcome').textContent = `Welcome back, ${user.guardian_name}`;
    document.getElementById('dash-subtitle').textContent = `Managing care for ${user.child_name}`;
    document.getElementById('profile-summary').innerHTML = `
      <strong>Child:</strong> ${escapeHtml(user.child_name)}<br>
      <strong>Diagnosis:</strong> ${escapeHtml(user.diagnosis || 'Not specified')}<br>
      <strong>Phone:</strong> ${escapeHtml(user.username)}
    `;
    return user;
  } catch (err) {
    return null;
  }
}

async function loadAppointments() {
  const listEl = document.getElementById('appointments-list');
  try {
    const res = await fetch('/api/appointments');
    if (!res.ok) throw new Error();
    const { appointments } = await res.json();

    if (appointments.length === 0) {
      listEl.innerHTML = '<p class="empty-state">No appointments yet. Book your first session using the form.</p>';
      return;
    }

    listEl.innerHTML = appointments.map(appt => {
      const labels = appt.therapy_types.map(t => THERAPY_LABELS[t] || t).join(', ');
      const modeLabel = appt.mode === 'online' ? 'Online' : 'In-Clinic';
      const dateLabel = appt.preferred_date ? formatDate(appt.preferred_date) : 'No date specified';
      return `
        <div class="appt-item">
          <div>
            <strong>${escapeHtml(labels)}</strong>
            <div class="tags">${modeLabel} · ${dateLabel}</div>
          </div>
          <span class="status-badge status-${appt.status}">${appt.status}</span>
        </div>
      `;
    }).join('');
  } catch (err) {
    listEl.innerHTML = '<p class="empty-state">Could not load appointments. Please refresh.</p>';
  }
}

function setupOtherToggle() {
  const otherCheckbox = document.getElementById('other-checkbox');
  const otherField = document.getElementById('other-desc-field');
  otherCheckbox.addEventListener('change', () => {
    otherField.style.display = otherCheckbox.checked ? 'block' : 'none';
  });
}

function setupBookingForm() {
  const form = document.getElementById('booking-form');
  const msgBox = document.getElementById('booking-msg');
  const submitBtn = document.getElementById('booking-submit');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const therapyTypes = Array.from(form.querySelectorAll('input[name="therapyTypes"]:checked')).map(el => el.value);
    const mode = form.querySelector('input[name="mode"]:checked').value;
    const otherDescription = document.getElementById('otherDescription').value.trim();
    const preferredDate = document.getElementById('preferredDate').value;
    const notes = document.getElementById('notes').value.trim();

    if (therapyTypes.length === 0) {
      showFormMsg(msgBox, 'Please select at least one therapy type.', 'error');
      return;
    }
    if (therapyTypes.includes('other') && !otherDescription) {
      showFormMsg(msgBox, 'Please describe your "Other" therapy need.', 'error');
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Submitting...';

    try {
      const res = await fetch('/api/appointments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ therapyTypes, otherDescription, mode, preferredDate, notes })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not submit appointment.');
      showFormMsg(msgBox, data.message, 'success');
      form.reset();
      document.getElementById('other-desc-field').style.display = 'none';
      loadAppointments();
    } catch (err) {
      showFormMsg(msgBox, err.message, 'error');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Submit Appointment Request';
    }
  });
}

async function loadAssessmentStatus() {
  const textEl = document.getElementById('assessment-status-text');
  const btnEl = document.getElementById('assessment-btn');
  try {
    const res = await fetch('/api/assessments/mine');
    if (!res.ok) return;
    const { assessments } = await res.json();
    if (assessments.length === 0) return; // keep default "Start Assessment" state

    const latest = assessments[0];
    if (latest.status === 'reviewed') {
      textEl.textContent = 'Reviewed — see your therapist\'s conclusion.';
      btnEl.textContent = 'View Results';
    } else {
      textEl.textContent = 'Submitted — our team is reviewing it.';
      btnEl.textContent = 'View Submission';
    }
  } catch (err) {
    // leave default state
  }
}

async function loadGaitStatus() {
  const textEl = document.getElementById('gait-status-text');
  const btnEl = document.getElementById('gait-btn');
  try {
    const res = await fetch('/api/gait/sessions');
    if (!res.ok) return;
    const { sessions } = await res.json();
    if (!sessions || sessions.length === 0) return; // keep default state
    const latest = sessions[0];
    if (latest.status === 'analyzed' || latest.status === 'reviewed') {
      textEl.textContent = `Your latest gait session (#${latest.id}) has been ${latest.status}${latest.reviewed_at ? ' and reviewed by ' + (latest.reviewed_by || 'staff') : ''}. Open it to view the report.`;
      btnEl.textContent = 'View Gait Report';
    } else if (latest.status === 'created') {
      textEl.textContent = `You have an unfinished gait session (#${latest.id}). Upload your videos to continue.`;
    }
  } catch (err) {
    // leave default state
  }
}

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
