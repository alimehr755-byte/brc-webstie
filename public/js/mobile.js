/* mobile.js — Capacitor bridge loaded by every page.
 *
 * No-op on the desktop web. When running inside a native Capacitor shell it:
 *  1. Rewrites every fetch('/api/...') to the remote server URL with
 *     an Authorization: Bearer header (avoids cross-origin cookie issues).
 *  2. Persists the JWT token via @capacitor/preferences.
 *  3. Intercepts link clicks / downloads targeting /api/ and opens them in the
 *     system browser so they download cleanly.
 */
(function () {
  // --- Configuration ---
  // The deployed backend URL. Change this single value for each environment.
  var API_BASE = 'https://bonsai-rehab-server.onrender.com';

  // Detect native Capacitor shell at runtime (Capacitor sets this global)
  var isNative = (typeof window.Capacitor !== 'undefined' && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  if (!isNative) return; // desktop web — do nothing

  var Preferences = window.Capacitor.Plugins.Preferences;
  var Browser     = window.Capacitor.Plugins.Browser;

  // --- Token storage helpers ---
  function getToken() {
    return Preferences ? Preferences.get({ key: 'brc_token' }).then(function (r) { return r.value || ''; }) : Promise.resolve('');
  }
  function setToken(t) {
    return Preferences ? Preferences.set({ key: 'brc_token', value: t || '' }) : Promise.resolve();
  }
  function clearToken() {
    return Preferences ? Preferences.remove({ key: 'brc_token' }) : Promise.resolve();
  }

  // Expose helpers so auth.js / main.js can use them from the web page context
  window.BRC_MOBILE = { getToken: getToken, setToken: setToken, clearToken: clearToken, API_BASE: API_BASE };

  // --- Patch fetch to rewrite relative /api/ calls + inject Bearer token ---
  var origFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    var url = (typeof input === 'string') ? input : (input && input.url) || '';
    // Only intercept relative /api/ requests (skip absolute URLs, blob:, data:, etc.)
    if (url.charAt(0) === '/' && url.indexOf('/api/') === 0) {
      url = API_BASE + url;
      if (typeof input === 'string') input = url;
      else { input = new Request(url, input); }
      // Attach Bearer token synchronously from our cached copy
      if (window._brc_token) {
        init = init || {};
        init.headers = init.headers || {};
        // Support both plain object and Headers instance
        if (init.headers instanceof window.Headers) {
          if (!init.headers.has('Authorization')) init.headers.set('Authorization', 'Bearer ' + window._brc_token);
        } else {
          if (!init.headers['Authorization']) init.headers['Authorization'] = 'Bearer ' + window._brc_token;
        }
      }
      init.credentials = 'omit'; // no cookies to send cross-origin
    }
    return origFetch(input, init);
  };

  // --- Intercept anchor clicks targeting /api/ → open in system browser ---
  document.addEventListener('click', function (e) {
    var a = e.target.closest('a');
    if (!a) return;
    var href = a.getAttribute('href') || '';
    if (href.indexOf('/api/') !== 0) return;
    e.preventDefault();
    var full = API_BASE + href;
    if (Browser && Browser.open) { Browser.open({ url: full }); }
    else { window.open(full, '_system'); }
  }, true);

  // --- Boot: read token once and start listening for login/logout ---
  getToken().then(function (t) { window._brc_token = t; });

  // Listen for custom events fired by auth.js after login/logout
  document.addEventListener('brc-login', function (e) {
    if (e.detail && e.detail.token) setToken(e.detail.token);
  });
  document.addEventListener('brc-logout', function () {
    clearToken();
  });
})();
