// config/mailer.js
// Outbound email for the admin reply feature. SMTP credentials are read from the
// app_settings table (configured in the admin Settings tab) and cached per send.
// If nothing is configured, sendMail() throws a helpful error so the UI can tell
// the admin to set up SMTP before replying.

const nodemailer = require('nodemailer');
const db = require('../db/database');

const SMTP_DEFAULTS = {
  smtp_host: '',
  smtp_port: '587',
  smtp_secure: 'false',
  smtp_user: '',
  smtp_pass: '',
  smtp_from_name: '',
  smtp_from_email: ''
};

function getSmtp() {
  const overrides = {};
  for (const row of db.prepare('SELECT key, value FROM app_settings').all()) {
    overrides[row.key] = row.value;
  }
  return { ...SMTP_DEFAULTS, ...overrides };
}

function isConfigured(smtp) {
  smtp = smtp || getSmtp();
  return Boolean(smtp.smtp_host && smtp.smtp_user && smtp.smtp_pass);
}

function createTransport(smtp) {
  smtp = smtp || getSmtp();
  return nodemailer.createTransport({
    host: smtp.smtp_host,
    port: parseInt(smtp.smtp_port || (smtp.smtp_secure === 'true' ? 465 : 587), 10),
    secure: smtp.smtp_secure === 'true',
    auth: { user: smtp.smtp_user, pass: smtp.smtp_pass },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 20000
  });
}

/**
 * Send an email using the configured SMTP account.
 * @param {{to: string, subject: string, text: string, html?: string}} opts
 * @returns {Promise<{messageId: string, from: string, smtp: object}>}
 */
async function sendMail(opts) {
  const smtp = getSmtp();
  if (!isConfigured(smtp)) {
    const err = new Error('SMTP is not configured. Open Settings → Email, enter your mail host/credentials, and save.');
    err.code = 'SMTP_NOT_CONFIGURED';
    throw err;
  }
  const fromName = smtp.smtp_from_name || 'Bonsai Rehabilitation Center';
  const fromEmail = smtp.smtp_from_email || smtp.smtp_user;
  const transport = createTransport(smtp);
  try {
    const info = await transport.sendMail({
      from: `"${String(fromName).replace(/"/g, '')}" <${fromEmail}>`,
      to: opts.to,
      subject: opts.subject,
      text: opts.text,
      html: opts.html || null
    });
    return { messageId: info.messageId, from: fromEmail, smtp };
  } finally {
    try { transport.close(); } catch (e) { /* noop */ }
  }
}

module.exports = { SMTP_DEFAULTS, getSmtp, isConfigured, createTransport, sendMail };