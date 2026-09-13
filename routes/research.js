// routes/research.js
// Research publications — public list/detail/file (published only) + admin CRUD + PDF upload.

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const db = require('../db/database');
const { requireAdmin } = require('./auth');
const { uniqueSlug, cleanString, validateContent } = require('./content-utils');

const router = express.Router();

// ---- local audit helper (mirrors the admin.js logAudit signature) ----
function auditResearch(req, action, targetType, targetId, detail) {
  try {
    const admin = req.session.user || {};
    db.prepare(`
      INSERT INTO audit_logs (admin_id, admin_name, action, target_type, target_id, detail)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(req.userId || admin.id || null, admin.guardian_name || admin.username || '', action, targetType, targetId, detail);
  } catch (e) { /* logging must never break the action */ }
}

const DEFAULT_PAGE_SIZE = 9;
const MAX_PAGE_SIZE = 24;
const MAX_FILE_BYTES = 8 * 1024 * 1024;

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads', 'research');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const RESOLVED_UPLOAD_DIR = path.resolve(UPLOAD_DIR);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = (path.extname(file.originalname) || '.pdf').toLowerCase();
    cb(null, `research-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    const ok = file.mimetype === 'application/pdf' && path.extname(file.originalname).toLowerCase() === '.pdf';
    cb(ok ? null : new Error('Only PDF files are allowed.'), ok);
  }
});

const toPaper = (r) => ({
  id: r.id,
  title: r.title,
  slug: r.slug,
  author: r.author,
  category: r.category,
  publicationDate: r.publication_date,
  abstract: r.abstract,
  status: r.status,
  publishedAt: r.published_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  hasFile: !!r.pdf_path,
  fileName: r.pdf_name
});

function buildWhere(query) {
  const where = [];
  const params = [];
  if (query.category && query.category !== 'all') {
    where.push('category = ?');
    params.push(query.category);
  }
  if (query.status && query.status !== 'all') {
    where.push('status = ?');
    params.push(query.status);
  }
  if (query.q) {
    where.push('(LOWER(title) LIKE ? OR LOWER(abstract) LIKE ? OR LOWER(author) LIKE ? OR LOWER(content) LIKE ?)');
    const like = `%${query.q.toLowerCase()}%`;
    params.push(like, like, like, like);
  }
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

function pagination(query) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(query.pageSize, 10) || DEFAULT_PAGE_SIZE));
  return { page, pageSize };
}

function safePdfPath(paper) {
  if (!paper || !paper.pdf_path) return null;
  const abs = path.resolve(path.join(__dirname, '..', paper.pdf_path));
  if (!abs.startsWith(RESOLVED_UPLOAD_DIR + path.sep)) return null;
  return fs.existsSync(abs) ? abs : null;
}

// ---- Public: published papers only ----
router.get('/', (req, res) => {
  const { page, pageSize } = pagination(req.query);
  const scope = buildWhere({ ...req.query, status: 'published' });

  const total = db.prepare(`SELECT COUNT(*) c FROM research_papers ${scope.sql}`).get(...scope.params).c;
  const rows = db.prepare(`
    SELECT id, title, slug, author, category, publication_date, abstract, status, pdf_path, pdf_name, published_at, created_at, updated_at
    FROM research_papers ${scope.sql}
    ORDER BY COALESCE(published_at, created_at) DESC, id DESC
    LIMIT ? OFFSET ?
  `).all(...scope.params, pageSize, (page - 1) * pageSize);

  const categories = db.prepare(
    "SELECT DISTINCT category FROM research_papers WHERE status = 'published' ORDER BY category"
  ).all().map(r => r.category);

  res.json({
    items: rows.map(toPaper),
    total,
    page,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    categories
  });
});

// ---- Public: download the stored PDF of a published paper ----
router.get('/:id/file', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const paper = db.prepare(
    "SELECT * FROM research_papers WHERE id = ? AND status = 'published'"
  ).get(id);
  const abs = safePdfPath(paper);
  if (!abs) return res.status(404).json({ error: 'File not found.' });

  const fileName = paper.pdf_name || 'research.pdf';
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(fileName)}"`);
  fs.createReadStream(abs).pipe(res);
});

// ---- Admin only (below this point) ----

// Admin: paginated management list (includes drafts + status filter). Before GET /:slug.
router.get('/manage', requireAdmin, (req, res) => {
  const { page, pageSize } = pagination(req.query);
  const scope = buildWhere(req.query);

  const total = db.prepare(`SELECT COUNT(*) c FROM research_papers ${scope.sql}`).get(...scope.params).c;
  const rows = db.prepare(`
    SELECT id, title, slug, author, category, publication_date, abstract, status, pdf_path, pdf_name, published_at, created_at, updated_at
    FROM research_papers ${scope.sql}
    ORDER BY updated_at DESC, id DESC
    LIMIT ? OFFSET ?
  `).all(...scope.params, pageSize, (page - 1) * pageSize);

  const categories = db.prepare(
    "SELECT DISTINCT category FROM research_papers ORDER BY category"
  ).all().map(r => r.category);

  res.json({
    items: rows.map(toPaper),
    total,
    page,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    categories
  });
});

// Admin: single paper by id (any status, includes full content + attachment details).
router.get('/item/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const paper = db.prepare('SELECT * FROM research_papers WHERE id = ?').get(id);
  if (!paper) return res.status(404).json({ error: 'Research paper not found.' });
  res.json({ paper });
});

// Public: single published paper by slug.
router.get('/:slug', (req, res) => {
  const paper = db.prepare(
    "SELECT * FROM research_papers WHERE slug = ? AND status = 'published'"
  ).get(req.params.slug);
  if (!paper) return res.status(404).json({ error: 'Research paper not found.' });
  res.json({ paper: { ...toPaper(paper), content: paper.content || '', hasFile: !!paper.pdf_path } });
});

// Admin: create.
router.post('/', requireAdmin, (req, res) => {
  const title = cleanString(req.body.title, 200);
  const author = cleanString(req.body.author, 100) || 'Bonsai Rehabilitation Center';
  const category = cleanString(req.body.category, 60) || 'General';
  const publicationDate = cleanString(req.body.publicationDate, 20);
  const abstract = cleanString(req.body.abstract, 1000);
  const content = String(req.body.content || '').trim().slice(0, 200000);
  const status = req.body.status === 'published' ? 'published' : 'draft';

  const error = validateContent({ title, author, category, abstract, content, requireContent: false, requireAbstract: true });
  if (error) return res.status(400).json({ error });

  const slug = uniqueSlug('research_papers', title);
  const publishedAt = status === 'published' ? new Date().toISOString() : null;

  const result = db.prepare(`
    INSERT INTO research_papers (title, slug, author, category, publication_date, abstract, content, status, published_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(title, slug, author, category, publicationDate, abstract, content, status, publishedAt);

  res.json({ success: true, id: result.lastInsertRowid, slug, message: status === 'published' ? 'Paper published.' : 'Draft saved.' });
  auditResearch(req, 'research_create', 'research', result.lastInsertRowid, `Created research paper "${title}" (${status})`);
});

// Admin: update.
router.put('/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const existing = db.prepare('SELECT * FROM research_papers WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Research paper not found.' });

  const title = cleanString(req.body.title, 200);
  const author = cleanString(req.body.author, 100) || 'Bonsai Rehabilitation Center';
  const category = cleanString(req.body.category, 60) || 'General';
  const publicationDate = cleanString(req.body.publicationDate, 20);
  const abstract = cleanString(req.body.abstract, 1000);
  const content = String(req.body.content || '').trim().slice(0, 200000);
  const status = req.body.status === 'published' ? 'published' : 'draft';

  const error = validateContent({ title, author, category, abstract, content, requireContent: false, requireAbstract: true });
  if (error) return res.status(400).json({ error });

  const slug = uniqueSlug('research_papers', title, existing.id);
  const publishedAt = status === 'published' && !existing.published_at
    ? new Date().toISOString()
    : (status === 'draft' ? null : existing.published_at);

  db.prepare(`
    UPDATE research_papers
    SET title = ?, slug = ?, author = ?, category = ?, publication_date = ?, abstract = ?, content = ?, status = ?, published_at = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(title, slug, author, category, publicationDate, abstract, content, status, publishedAt, id);

  res.json({ success: true, id, slug, message: 'Changes saved.' });
  auditResearch(req, 'research_update', 'research', id, `Updated research paper "${title}" (${status})`);
});

// Admin: delete (also removes the attached PDF, if any).
router.delete('/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const paper = db.prepare('SELECT * FROM research_papers WHERE id = ?').get(id);
  if (!paper) return res.status(404).json({ error: 'Research paper not found.' });

  const abs = safePdfPath(paper);
  db.prepare('DELETE FROM research_papers WHERE id = ?').run(id);
  if (abs) { try { fs.unlinkSync(abs); } catch (e) { /* file may already be gone */ } }
  auditResearch(req, 'research_delete', 'research', id, `Deleted research paper "${paper.title}"`);
  res.json({ success: true, message: 'Research paper deleted.' });
});

// Admin: attach / replace a PDF file.
router.post('/:id/attachment', requireAdmin, (req, res) => {
  upload.single('pdf')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Upload failed.' });
    const id = parseInt(req.params.id, 10);
    const paper = db.prepare('SELECT * FROM research_papers WHERE id = ?').get(id);
    if (!paper) {
      if (req.file) { try { fs.unlinkSync(req.file.path); } catch (e) { /* noop */ } }
      return res.status(404).json({ error: 'Research paper not found.' });
    }
    if (!req.file) return res.status(400).json({ error: 'Please choose a PDF file to upload.' });

    const oldAbs = safePdfPath(paper);
    if (oldAbs) { try { fs.unlinkSync(oldAbs); } catch (e) { /* noop */ } }

    const rel = path.relative(path.join(__dirname, '..'), req.file.path).replace(/\\/g, '/');
    db.prepare(
      "UPDATE research_papers SET pdf_path = ?, pdf_name = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(rel, String(req.file.originalname).slice(0, 255), id);

    res.json({ success: true, fileName: req.file.originalname, message: 'PDF attached.' });
    auditResearch(req, 'research_attach_pdf', 'research', id, `Attached PDF "${String(req.file.originalname).slice(0, 255)}" to "${paper.title}"`);
  });
});

// Admin: remove the attached PDF.
router.delete('/:id/attachment', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const paper = db.prepare('SELECT * FROM research_papers WHERE id = ?').get(id);
  if (!paper) return res.status(404).json({ error: 'Research paper not found.' });

  const abs = safePdfPath(paper);
  db.prepare(
    "UPDATE research_papers SET pdf_path = NULL, pdf_name = NULL, updated_at = datetime('now') WHERE id = ?"
  ).run(id);
  if (abs) { try { fs.unlinkSync(abs); } catch (e) { /* noop */ } }
  auditResearch(req, 'research_remove_pdf', 'research', id, `Removed PDF from "${paper.title}"`);
  res.json({ success: true, message: 'PDF removed.' });
});

module.exports = router;