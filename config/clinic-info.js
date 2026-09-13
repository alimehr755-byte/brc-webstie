// config/clinic-info.js
// Runtime clinic profile read from the app_settings table, with the built-in
// defaults as a fallback. Return values are cached and refreshed whenever the
// settings are saved, so exports pick changes up without a server restart.

const db = require('../db/database');

const DEFAULTS = {
  clinic_name: 'Bonsai Rehabilitation Center',
  clinic_address: 'Shadman Colony, Abdara Road, University Town, Peshawar, Pakistan',
  clinic_phone: '0313 9327164',
  clinic_email: 'bonsai.rehabilitaion@gmail.com'
};

let cache = null;

function load() {
  const overrides = {};
  for (const row of db.prepare('SELECT key, value FROM app_settings').all()) {
    overrides[row.key] = row.value;
  }
  cache = { ...DEFAULTS, ...overrides };
  return cache;
}

function getClinic() {
  if (!cache) load();
  return cache;
}

// Call after writing app_settings so exports/labels use fresh values immediately.
function refreshClinic() {
  load();
}

module.exports = { getClinic, refreshClinic, DEFAULTS };