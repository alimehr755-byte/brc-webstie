// routes/blog.js
// Blog posts — public list/detail (published only) + admin CRUD (drafts and published).

const express = require('express');
const db = require('../db/database');
const { requireAdmin } = require('./auth');
const { uniqueSlug, cleanString, validateContent } = require('./content-utils');

const router = express.Router();

// ---- local audit helper (mirrors the admin.js logAudit signature) ----
function auditBlog(req, action, targetType, targetId, detail) {
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

const toPost = (r) => ({
  id: r.id,
  title: r.title,
  slug: r.slug,
  author: r.author,
  category: r.category,
  abstract: r.abstract,
  status: r.status,
  publishedAt: r.published_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at
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

// ---- Public: published posts only ----
router.get('/', (req, res) => {
  const { page, pageSize } = pagination(req.query);
  const scope = buildWhere({ ...req.query, status: 'published' });

  const total = db.prepare(`SELECT COUNT(*) c FROM blog_posts ${scope.sql}`).get(...scope.params).c;
  const rows = db.prepare(`
    SELECT id, title, slug, author, category, abstract, status, published_at, created_at, updated_at
    FROM blog_posts ${scope.sql}
    ORDER BY COALESCE(published_at, created_at) DESC, id DESC
    LIMIT ? OFFSET ?
  `).all(...scope.params, pageSize, (page - 1) * pageSize);

  const categories = db.prepare(
    "SELECT DISTINCT category FROM blog_posts WHERE status = 'published' ORDER BY category"
  ).all().map(r => r.category);

  res.json({
    items: rows.map(toPost),
    total,
    page,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    categories
  });
});

// ---- Admin only (below this point) ----

// Admin: paginated management list (includes drafts). Must be declared before GET /:slug.
router.get('/manage', requireAdmin, (req, res) => {
  const { page, pageSize } = pagination(req.query);
  const scope = buildWhere(req.query);

  const total = db.prepare(`SELECT COUNT(*) c FROM blog_posts ${scope.sql}`).get(...scope.params).c;
  const rows = db.prepare(`
    SELECT id, title, slug, author, category, abstract, status, published_at, created_at, updated_at
    FROM blog_posts ${scope.sql}
    ORDER BY updated_at DESC, id DESC
    LIMIT ? OFFSET ?
  `).all(...scope.params, pageSize, (page - 1) * pageSize);

  const categories = db.prepare(
    "SELECT DISTINCT category FROM blog_posts ORDER BY category"
  ).all().map(r => r.category);

  res.json({
    items: rows.map(toPost),
    total,
    page,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    categories
  });
});

// Admin: single post by id (any status).
router.get('/item/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const post = db.prepare('SELECT * FROM blog_posts WHERE id = ?').get(id);
  if (!post) return res.status(404).json({ error: 'Post not found.' });
  res.json({ post });
});

// Public: single published post by slug (declared after the admin /manage + /item paths).
router.get('/:slug', (req, res) => {
  const post = db.prepare(
    "SELECT * FROM blog_posts WHERE slug = ? AND status = 'published'"
  ).get(req.params.slug);
  if (!post) return res.status(404).json({ error: 'Post not found.' });
  res.json({ post });
});

// Admin: create.
router.post('/', requireAdmin, (req, res) => {
  const title = cleanString(req.body.title, 200);
  const author = cleanString(req.body.author, 100) || 'Bonsai Rehabilitation Center';
  const category = cleanString(req.body.category, 60) || 'General';
  const abstract = cleanString(req.body.abstract, 1000);
  const content = String(req.body.content || '').trim().slice(0, 200000);
  const status = req.body.status === 'published' ? 'published' : 'draft';

  const error = validateContent({ title, author, category, abstract, content, requireContent: true });
  if (error) return res.status(400).json({ error });

  const slug = uniqueSlug('blog_posts', title);
  const publishedAt = status === 'published' ? new Date().toISOString() : null;

  const result = db.prepare(`
    INSERT INTO blog_posts (title, slug, author, category, abstract, content, status, published_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(title, slug, author, category, abstract, content, status, publishedAt);

  res.json({ success: true, id: result.lastInsertRowid, slug, message: status === 'published' ? 'Post published.' : 'Draft saved.' });
  auditBlog(req, 'blog_create', 'blog', result.lastInsertRowid, `Created blog post "${title}" (${status})`);
});

// Admin: update.
router.put('/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const existing = db.prepare('SELECT * FROM blog_posts WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Post not found.' });

  const title = cleanString(req.body.title, 200);
  const author = cleanString(req.body.author, 100) || 'Bonsai Rehabilitation Center';
  const category = cleanString(req.body.category, 60) || 'General';
  const abstract = cleanString(req.body.abstract, 1000);
  const content = String(req.body.content || '').trim().slice(0, 200000);
  const status = req.body.status === 'published' ? 'published' : 'draft';

  const error = validateContent({ title, author, category, abstract, content, requireContent: true });
  if (error) return res.status(400).json({ error });

  const slug = uniqueSlug('blog_posts', title, existing.id);
  const publishedAt = status === 'published' && !existing.published_at
    ? new Date().toISOString()
    : (status === 'draft' ? null : existing.published_at);

  db.prepare(`
    UPDATE blog_posts
    SET title = ?, slug = ?, author = ?, category = ?, abstract = ?, content = ?, status = ?, published_at = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(title, slug, author, category, abstract, content, status, publishedAt, id);

  res.json({ success: true, id, slug, message: 'Changes saved.' });
  auditBlog(req, 'blog_update', 'blog', id, `Updated blog post "${title}" (${status})`);
});

// Admin: delete.
router.delete('/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const existing = db.prepare('SELECT title FROM blog_posts WHERE id = ?').get(id);
  const result = db.prepare('DELETE FROM blog_posts WHERE id = ?').run(id);
  if (!result.changes) return res.status(404).json({ error: 'Post not found.' });
  auditBlog(req, 'blog_delete', 'blog', id, `Deleted blog post "${existing ? existing.title : id}"`);
  res.json({ success: true, message: 'Post deleted.' });
});

module.exports = router;