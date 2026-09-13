// public/js/blog.js
// Powers the Blog listing page (search / category / pagination) and the single post page.

const blogState = { q: '', category: 'all', page: 1, pageSize: 9, totalPages: 1 };

document.addEventListener('DOMContentLoaded', () => {
  // Single post page
  if (document.getElementById('post-content')) {
    loadSinglePost();
    return;
  }

  const searchInput = document.getElementById('blog-search');
  searchInput.addEventListener('input', () => {
    clearTimeout(searchInput._debounce);
    searchInput._debounce = setTimeout(() => {
      blogState.q = searchInput.value.trim();
      blogState.page = 1;
      loadPosts();
    }, 300);
  });

  document.getElementById('blog-category-pills').addEventListener('click', (e) => {
    const pill = e.target.closest('.filter-pill');
    if (!pill) return;
    blogState.category = pill.dataset.category;
    blogState.page = 1;
    document.querySelectorAll('#blog-category-pills .filter-pill').forEach(p => p.classList.remove('active'));
    pill.classList.add('active');
    loadPosts();
  });

  loadPosts();
});

async function loadPosts() {
  const grid = document.getElementById('blog-grid');
  const params = new URLSearchParams({ page: String(blogState.page), pageSize: String(blogState.pageSize) });
  if (blogState.category !== 'all') params.set('category', blogState.category);
  if (blogState.q) params.set('q', blogState.q);

  grid.innerHTML = '<p class="empty-state" style="grid-column:1 / -1;">Loading posts...</p>';
  try {
    const res = await fetch(`/api/blog?${params}`);
    if (!res.ok) throw new Error();
    const data = await res.json();

    if (blogState.category !== 'all' && !data.categories.includes(blogState.category)) {
      blogState.category = 'all';
      return loadPosts();
    }

    renderCategoryPills(data.categories);
    blogState.totalPages = data.totalPages;

    if (data.items.length === 0) {
      grid.innerHTML = '<p class="empty-state" style="grid-column:1 / -1;">No posts found. Try a different search or category.</p>';
    } else {
      grid.innerHTML = data.items.map(postCardHtml).join('');
    }
    renderPagination();
  } catch (err) {
    grid.innerHTML = '<p class="empty-state" style="grid-column:1 / -1;">Could not load posts. Please refresh.</p>';
  }
}

function renderCategoryPills(categories) {
  const container = document.getElementById('blog-category-pills');
  const all = ['all', ...categories];
  container.innerHTML = all.map(cat => `
    <button class="filter-pill ${cat === blogState.category ? 'active' : ''}" data-category="${escapeHtml(cat)}">
      ${cat === 'all' ? 'All' : escapeHtml(cat)}
    </button>
  `).join('');
}

function postCardHtml(post) {
  return `
    <div class="card post-card">
      <div class="post-meta">
        <span class="category-chip">${escapeHtml(post.category)}</span>
        <span class="post-date">${formatShortDate(post.publishedAt || post.createdAt)}</span>
      </div>
      <h3><a href="/blog-post.html?slug=${encodeURIComponent(post.slug)}">${escapeHtml(post.title)}</a></h3>
      <p class="post-excerpt">${escapeHtml(post.abstract || '')}</p>
      <div class="post-actions">
        <a class="row-link" href="/blog-post.html?slug=${encodeURIComponent(post.slug)}">Read more →</a>
      </div>
    </div>
  `;
}

function renderPagination() {
  const el = document.getElementById('blog-pagination');
  if (!el) return;
  if (blogState.totalPages <= 1) { el.innerHTML = ''; return; }
  el.innerHTML = `
    <button class="btn btn-outline btn-sm" data-page="${blogState.page - 1}" ${blogState.page <= 1 ? 'disabled' : ''}>← Prev</button>
    <span class="page-info">Page ${blogState.page} of ${blogState.totalPages}</span>
    <button class="btn btn-outline btn-sm" data-page="${blogState.page + 1}" ${blogState.page >= blogState.totalPages ? 'disabled' : ''}>Next →</button>
  `;
  el.querySelectorAll('button[data-page]').forEach(btn => {
    if (btn.disabled) return;
    btn.addEventListener('click', () => {
      const p = parseInt(btn.dataset.page, 10);
      if (p >= 1 && p <= blogState.totalPages) {
        blogState.page = p;
        loadPosts();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    });
  });
}

async function loadSinglePost() {
  const slug = new URLSearchParams(window.location.search).get('slug');
  const titleEl = document.getElementById('post-title');
  const categoryEl = document.getElementById('post-category');
  const metaEl = document.getElementById('post-meta');
  const contentEl = document.getElementById('post-content');

  if (!slug) {
    titleEl.textContent = 'Post not found';
    contentEl.innerHTML = '<p class="empty-state">Missing post reference.</p>';
    return;
  }

  try {
    const res = await fetch(`/api/blog/${encodeURIComponent(slug)}`);
    if (!res.ok) throw new Error();
    const { post } = await res.json();
    document.title = `${post.title} | Bonsai Rehabilitation Center`;
    categoryEl.textContent = post.category;
    titleEl.textContent = post.title;
    metaEl.innerHTML = `
      <span class="post-date">By ${escapeHtml(post.author)}</span>
      <span class="post-date">${formatShortDate(post.publishedAt || post.createdAt)}</span>
    `;
    contentEl.innerHTML = renderMarkdown(post.content);
  } catch (err) {
    titleEl.textContent = 'Post not found';
    contentEl.innerHTML = '<p class="empty-state">This post could not be found.</p>';
  }
}

function escapeHtml(str) { const div = document.createElement('div'); div.textContent = str; return div.innerHTML; }

function formatShortDate(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d)) return dateStr || '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}