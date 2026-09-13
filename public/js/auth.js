// public/js/auth.js
// Handles both the signup form and the login form (whichever is present on the page).

document.addEventListener('DOMContentLoaded', () => {
  const signupForm = document.getElementById('signup-form');
  const loginForm = document.getElementById('login-form');

  if (signupForm) {
    signupForm.addEventListener('submit', handleSignup);
  }
  if (loginForm) {
    loginForm.addEventListener('submit', handleLogin);
  }
});

async function handleSignup(e) {
  e.preventDefault();
  const msgBox = document.getElementById('signup-msg');
  const submitBtn = document.getElementById('signup-submit');

  const payload = {
    guardianName: document.getElementById('guardianName').value.trim(),
    childName: document.getElementById('childName').value.trim(),
    diagnosis: document.getElementById('diagnosis').value.trim(),
    countryCode: document.getElementById('countryCode').value,
    phone: document.getElementById('phone').value.trim(),
    address: document.getElementById('address').value.trim(),
    password: document.getElementById('password').value,
    confirmPassword: document.getElementById('confirmPassword').value
  };

  if (payload.password !== payload.confirmPassword) {
    showFormMsg(msgBox, 'Passwords do not match.', 'error');
    return;
  }

  submitBtn.disabled = true;
  submitBtn.textContent = 'Creating account...';

  try {
    const res = await fetch('/api/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not create account.');
    if (data.token) document.dispatchEvent(new CustomEvent('brc-login', { detail: { token: data.token } }));
    showFormMsg(msgBox, 'Account created! Redirecting to your dashboard...', 'success');
    setTimeout(() => window.location.href = '/dashboard.html', 900);
  } catch (err) {
    showFormMsg(msgBox, err.message, 'error');
    submitBtn.disabled = false;
    submitBtn.textContent = 'Create Account';
  }
}

async function handleLogin(e) {
  e.preventDefault();
  const msgBox = document.getElementById('login-msg');
  const submitBtn = document.getElementById('login-submit');

  const payload = {
    username: document.getElementById('username').value.trim(),
    password: document.getElementById('password').value
  };

  submitBtn.disabled = true;
  submitBtn.textContent = 'Logging in...';

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not log in.');
    if (data.token) document.dispatchEvent(new CustomEvent('brc-login', { detail: { token: data.token } }));
    showFormMsg(msgBox, 'Welcome back! Redirecting...', 'success');
    const destination = data.mustChangePassword
      ? '/change-password.html'
      : ((data.role === 'admin' || data.role === 'super_admin') ? '/admin-dashboard.html' : '/dashboard.html');
    setTimeout(() => window.location.href = destination, 700);
  } catch (err) {
    showFormMsg(msgBox, err.message, 'error');
    submitBtn.disabled = false;
    submitBtn.textContent = 'Log In';
  }
}
