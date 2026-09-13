// routes/content-utils.js
// Shared helpers for the blog + research content routes (slug generation, limits).

const db = require('../db/database');

const LIMITS = {
  title: 200,
  author: 100,
  category: 60,
  abstract: 1000,
  content: 200000
};

function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .trim()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90)
    .replace(/-+$/g, '');
}

function uniqueSlug(table, title, excludeId) {
  const base = slugify(title) || 'untitled';
  let slug = base;
  let i = 2;
  const stmt = db.prepare(`SELECT id FROM ${table} WHERE slug = ? AND id != ?`);
  while (stmt.get(slug, excludeId || -1)) slug = `${base}-${i++}`;
  return slug;
}

function cleanString(value, limit) {
  return String(value || '').trim().slice(0, limit);
}

function validateContent({ title, author, category, abstract, content, requireContent, requireAbstract }) {
  const errors = [];
  if (!title) errors.push('Please enter a title.');
  if (title && title.length > LIMITS.title) errors.push(`Title must be ${LIMITS.title} characters or fewer.`);
  if (!author) errors.push('Please enter the author name.');
  if (author && author.length > LIMITS.author) errors.push(`Author must be ${LIMITS.author} characters or fewer.`);
  if (!category) errors.push('Please enter a category.');
  if (category && category.length > LIMITS.category) errors.push(`Category must be ${LIMITS.category} characters or fewer.`);
  if (requireAbstract && !abstract) errors.push('Please write a short summary.');
  if (abstract && abstract.length > LIMITS.abstract) errors.push(`Summary must be ${LIMITS.abstract} characters or fewer.`);
  if (requireContent && !content) errors.push('Please write the content.');
  if (content && content.length > LIMITS.content) errors.push('Content is too long.');
  return errors.length ? errors[0] : null;
}

module.exports = { slugify, uniqueSlug, cleanString, validateContent, LIMITS };