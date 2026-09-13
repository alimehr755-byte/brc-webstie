// public/js/research.js
// Powers the Research listing page (search / category / pagination) and the single paper page.

const researchState = { q: '', category: 'all', page: 1, pageSize: 9, totalPages: 1 };

document.addEventListener('DOMContentLoaded', () => {
  // Single paper page
  if (document.getElementById('paper-content')) {
    loadSinglePaper();
    return;
  }

  const searchInput = document.getElementById('research-search');
  searchInput.addEventListener('input', () => {
    clearTimeout(searchInput._debounce);
    searchInput._debounce = setTimeout(() => {
      researchState.q = searchInput.value.trim();
      researchState.page = 1;
      loadPapers();
    }, 300);
  });

  document.getElementById('research-category-pills').addEventListener('click', (e) => {
    const pill = e.target.closest('.filter-pill');
    if (!pill) return;
    researchState.category = pill.dataset.category;
    researchState.page = 1;
    document.querySelectorAll('#research-category-pills .filter-pill').forEach(p => p.classList.remove('active'));
    pill.classList.add('active');
    loadPapers();
  });

  loadPapers();
});

async function loadPapers() {
  const grid = document.getElementById('research-grid');
  const params = new URLSearchParams({ page: String(researchState.page), pageSize: String(researchState.pageSize) });
  if (researchState.category !== 'all') params.set('category', researchState.category);
  if (researchState.q) params.set('q', researchState.q);

  grid.innerHTML = '<p class="empty-state" style="grid-column:1 / -1;">Loading papers...</p>';
  try {
    const res = await fetch(`/api/research?${params}`);
    if (!res.ok) throw new Error();
    const data = await res.json();

    if (researchState.category !== 'all' && !data.categories.includes(researchState.category)) {
      researchState.category = 'all';
      return loadPapers();
    }

    renderCategoryPills(data.categories);
    researchState.totalPages = data.totalPages;

    if (data.items.length === 0) {
      grid.innerHTML = '<p class="empty-state" style="grid-column:1 / -1;">No publications found. Try a different search or category.</p>';
    } else {
      grid.innerHTML = data.items.map(paperCardHtml).join('');
    }
    renderPagination();
  } catch (err) {
    grid.innerHTML = '<p class="empty-state" style="grid-column:1 / -1;">Could not load publications. Please refresh.</p>';
  }
}

function renderCategoryPills(categories) {
  const container = document.getElementById('research-category-pills');
  const all = ['all', ...categories];
  container.innerHTML = all.map(cat => `
    <button class="filter-pill ${cat === researchState.category ? 'active' : ''}" data-category="${escapeHtml(cat)}">
      ${cat === 'all' ? 'All' : escapeHtml(cat)}
    </button>
  `).join('');
}

function paperCardHtml(paper) {
  const date = formatShortDate(paper.publicationDate || paper.publishedAt || paper.createdAt);
  return `
    <div class="card post-card">
      <div class="post-meta">
        <span class="category-chip">${escapeHtml(paper.category)}</span>
        <span class="post-date">${date}</span>
      </div>
      <h3><a href="/research-paper.html?slug=${encodeURIComponent(paper.slug)}">${escapeHtml(paper.title)}</a></h3>
      <p class="post-excerpt">${escapeHtml(paper.abstract || '')}</p>
      <div class="post-actions">
        <a class="row-link" href="/research-paper.html?slug=${encodeURIComponent(paper.slug)}">View summary →</a>
        ${paper.hasFile ? `<a class="row-link" href="/api/research/${paper.id}/file" target="_blank" style="margin-left:14px;">⬇ PDF</a>` : ''}
      </div>
    </div>
  `;
}

function renderPagination() {
  const el = document.getElementById('research-pagination');
  if (!el) return;
  if (researchState.totalPages <= 1) { el.innerHTML = ''; return; }
  el.innerHTML = `
    <button class="btn btn-outline btn-sm" data-page="${researchState.page - 1}" ${researchState.page <= 1 ? 'disabled' : ''}>← Prev</button>
    <span class="page-info">Page ${researchState.page} of ${researchState.totalPages}</span>
    <button class="btn btn-outline btn-sm" data-page="${researchState.page + 1}" ${researchState.page >= researchState.totalPages ? 'disabled' : ''}>Next →</button>
  `;
  el.querySelectorAll('button[data-page]').forEach(btn => {
    if (btn.disabled) return;
    btn.addEventListener('click', () => {
      const p = parseInt(btn.dataset.page, 10);
      if (p >= 1 && p <= researchState.totalPages) {
        researchState.page = p;
        loadPapers();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    });
  });
}

async function loadSinglePaper() {
  const slug = new URLSearchParams(window.location.search).get('slug');
  const titleEl = document.getElementById('paper-title');
  const categoryEl = document.getElementById('paper-category');
  const metaEl = document.getElementById('paper-meta');
  const contentEl = document.getElementById('paper-content');
  const downloadEl = document.getElementById('paper-download');

  if (!slug) {
    titleEl.textContent = 'Publication not found';
    contentEl.innerHTML = '<p class="empty-state">Missing publication reference.</p>';
    return;
  }

  try {
    const res = await fetch(`/api/research/${encodeURIComponent(slug)}`);
    if (!res.ok) throw new Error();
    const { paper } = await res.json();
    document.title = `${paper.title} | Bonsai Rehabilitation Center`;
    categoryEl.textContent = paper.category;
    titleEl.textContent = paper.title;
    metaEl.innerHTML = `
      <span class="post-date">By ${escapeHtml(paper.author)}</span>
      <span class="post-date">${formatShortDate(paper.publicationDate || paper.publishedAt || paper.createdAt)}</span>
    `;
    if (paper.hasFile) {
      downloadEl.innerHTML = `<a class="btn btn-primary" href="/api/research/${paper.id}/file" target="_blank">⬇ Download PDF</a>`;
    }
    contentEl.innerHTML = paper.content ? renderMarkdown(paper.content) : '<p class="empty-state">The full paper is available as a PDF download above.</p>';
  } catch (err) {
    titleEl.textContent = 'Publication not found';
    contentEl.innerHTML = '<p class="empty-state">This publication could not be found.</p>';
  }
}

function escapeHtml(str) { const div = document.createElement('div'); div.textContent = str; return div.innerHTML; }

function formatShortDate(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d)) return dateStr || '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}