// public/js/markdown.js
// Tiny, dependency-free, XSS-safe Markdown renderer.
// Everything is HTML-escaped FIRST, so any raw HTML in the source is shown as
// plain text rather than interpreted. Supports a safe subset common to blog
// posts and research summaries: #/##/### headings, bold, italic, inline code,
// fenced code blocks, unordered/ordered lists, blockquotes, links, and rules.

function escapeHtml(str) {
  if (str == null) return '';
  const div = document.createElement('div');
  div.textContent = String(str);
  return div.innerHTML;
}

function renderInline(text) {
  let s = escapeHtml(String(text || '').trim());
  // Links — only http(s) and mailto are allowed; javascript: etc. stay escaped.
  s = s.replace(/\[([^\]]*)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  // Inline code
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  // Bold
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
  // Italic
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^_])_([^_\n]+)_/g, '$1<em>$2</em>');
  return s;
}

function renderMarkdown(md) {
  if (md == null) return '';
  const lines = String(md).replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let listType = null;
  let inFence = false;
  const codeLines = [];

  const closeList = () => {
    if (listType) { out.push(`</${listType}>`); listType = null; }
  };

  for (const line of lines) {
    // Fenced code blocks (```  ... ```)
    if (/^\s*```/.test(line)) {
      closeList();
      if (inFence) {
        out.push('<pre><code>' + codeLines.map(escapeHtml).join('\n') + '</code></pre>');
        codeLines.length = 0;
        inFence = false;
      } else {
        inFence = true;
      }
      continue;
    }
    if (inFence) { codeLines.push(line); continue; }

    const trimmed = line.trim();

    if (trimmed === '') {
      closeList();
      out.push('');
      continue;
    }

    // Headings
    const h = trimmed.match(/^(#{1,3})\s+(.*)$/);
    if (h) { closeList(); out.push(`<h${h[1].length}>${renderInline(h[2])}</h${h[1].length}>`); continue; }

    // Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) { closeList(); out.push('<hr>'); continue; }

    // Blockquote
    if (/^>\s?/.test(line)) { closeList(); out.push(`<blockquote>${renderInline(line.replace(/^>\s?/, ''))}</blockquote>`); continue; }

    // Unordered list
    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    if (ul) {
      if (listType !== 'ul') { closeList(); out.push('<ul>'); listType = 'ul'; }
      out.push(`<li>${renderInline(ul[1])}</li>`);
      continue;
    }

    // Ordered list
    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ol) {
      if (listType !== 'ol') { closeList(); out.push('<ol>'); listType = 'ol'; }
      out.push(`<li>${renderInline(ol[1])}</li>`);
      continue;
    }

    // Paragraph
    closeList();
    out.push(`<p>${renderInline(line)}</p>`);
  }

  if (inFence) {
    out.push('<pre><code>' + codeLines.map(escapeHtml).join('\n') + '</code></pre>');
    codeLines.length = 0;
  }
  closeList();
  return out.join('\n');
}