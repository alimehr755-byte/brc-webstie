// public/js/main.js
// Shared behavior across every page: mobile nav toggle + login-state aware nav.

document.addEventListener('DOMContentLoaded', () => {
  const toggle = document.querySelector('.nav-toggle');
  const links = document.querySelector('.nav-links');
  if (toggle && links) {
    const closeMenu = () => {
      links.classList.remove('open');
      toggle.setAttribute('aria-expanded', 'false');
    };
    toggle.addEventListener('click', () => {
      const isOpen = links.classList.toggle('open');
      toggle.setAttribute('aria-expanded', String(isOpen));
    });
    links.querySelectorAll('a').forEach(a => a.addEventListener('click', closeMenu));
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.navbar')) closeMenu();
    });
    window.addEventListener('resize', () => { if (window.innerWidth > 860) closeMenu(); });
  }

  updateNavForAuthState();
});

// Checks whether a session cookie is valid and swaps the nav CTA
// between "Log in" and "Dashboard / Log out" accordingly.
async function updateNavForAuthState() {
  const authSlot = document.getElementById('nav-auth-slot');
  if (!authSlot) return;

  try {
    const res = await fetch('/api/auth/me');
    if (res.ok) {
      const { user } = await res.json();
      const dashUrl = (user.role === 'admin' || user.role === 'super_admin') ? '/admin-dashboard.html' : '/dashboard.html';
      authSlot.innerHTML = `
        <a href="${dashUrl}">Dashboard</a>
        <a href="#" id="nav-logout-btn" class="nav-cta">Log out</a>
      `;
      document.getElementById('nav-logout-btn').addEventListener('click', async (e) => {
        e.preventDefault();
        await fetch('/api/auth/logout', { method: 'POST' });
        document.dispatchEvent(new CustomEvent('brc-logout'));
        window.location.href = '/index.html';
      });
    } else {
      authSlot.innerHTML = `
        <a href="/login.html">Log in</a>
        <a href="/signup.html" class="nav-cta">Book an Appointment</a>
      `;
    }
  } catch (err) {
    authSlot.innerHTML = `
      <a href="/login.html">Log in</a>
      <a href="/signup.html" class="nav-cta">Book an Appointment</a>
    `;
  }
}

// Utility: show a form message box (error or success)
function showFormMsg(el, message, type = 'error') {
  el.textContent = message;
  el.className = 'form-msg ' + type;
  el.style.display = 'block';
}
