require('dotenv').config();

// server.js
// Entry point for the Bonsai Rehabilitation Center website.
// Serves static frontend files + REST API for auth / appointments / contact.

const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const path = require('path');

const { router: authRouter } = require('./routes/auth');
const appointmentsRouter = require('./routes/appointments');
const contactRouter = require('./routes/contact');
const adminRouter = require('./routes/admin');
const assessmentsRouter = require('./routes/assessments');
const blogRouter = require('./routes/blog');
const researchRouter = require('./routes/research');
const gaitRouter = require('./routes/gait');

const app = express();
const PORT = process.env.PORT || 3000;

// Render persistent disk: when PERSIST_DIR is set, symlink the db/ and uploads/
// directories into the mounted disk so data survives redeploys.
if (process.env.PERSIST_DIR) {
  const fs = require('fs');
  for (const name of ['db', 'uploads']) {
    const target = path.join(process.env.PERSIST_DIR, name);
    const link  = path.join(__dirname, name);
    fs.mkdirSync(target, { recursive: true });
    if (!fs.existsSync(link)) {
      try { fs.symlinkSync(target, link, 'junction'); } catch (e) {
        console.warn(`[PERSIST] Could not symlink ${name}: ${e.message}`);
      }
    }
  }
}

// CORS for the native mobile app (Capacitor WebView origins) plus any configured
// web origins. The web site itself is same-origin and unaffected.
const CORS_ORIGINS = (process.env.CORS_ORIGINS || 'https://localhost,capacitor://localhost,https://capacitor.local')
  .split(',').map((s) => s.trim()).filter(Boolean);
app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true); // non-browser / curl
    if (CORS_ORIGINS.includes(origin)) return cb(null, true);
    const envApproved = (process.env.CORS_ALLOW_ANY === 'true');
    return cb(envApproved ? null : new Error('CORS: origin not allowed.'), envApproved);
  },
  credentials: true
}));

app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/auth', authRouter);
app.use('/api/appointments', appointmentsRouter);
app.use('/api/contact', contactRouter);
app.use('/api/admin', adminRouter);
app.use('/api/assessments', assessmentsRouter);
app.use('/api/blog', blogRouter);
app.use('/api/research', researchRouter);
app.use('/api/gait', gaitRouter);

// Fallback 404 for unknown API routes
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

// JSON error handler (e.g. CORS origin rejections)
app.use((err, req, res, next) => {
  if (err && err.message && err.message.startsWith('CORS:')) {
    return res.status(403).json({ error: err.message });
  }
  console.error(err);
  res.status(500).json({ error: 'Internal server error.' });
});

app.listen(PORT, () => {
  console.log(`Bonsai Rehabilitation Center website running at http://localhost:${PORT}`);
});
