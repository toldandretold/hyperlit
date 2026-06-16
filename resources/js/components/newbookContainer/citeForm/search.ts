// Library/source search for the cite-form (#import-search-*): debounced combined
// search, paginated results, result selection → fill the form (or show the
// "already in library" notice). Was setupImportSearch / performImportSearch /
// renderImportSearchResults / handleImportSearchSelection / showLibraryMatchNotice
// / fillFormFromSelection of newBookForm.js. Shared search bookkeeping lives in
// ./state.
import DOMPurify from 'dompurify';
import { $, qs } from './dom';
import { searchState } from './state';
import { generateBookIdFromMetadata, findAvailableBookId, updateBookUrlPreview } from './bookId';
import { populateFieldsFromBibtex } from './bibtex';
import { showFieldsForType } from './fields';

export function setupImportSearch() {
  const input = $('import-search-input');
  if (!input) return;

  input.addEventListener('input', () => {
    clearTimeout(searchState.debounce);
    const query = input.value.trim();
    if (query.length < 2) {
      const results = $('import-search-results');
      if (results) results.innerHTML = '';
      return;
    }
    searchState.debounce = setTimeout(() => performImportSearch(query), 300);
  });
}

async function performImportSearch(query: string, offset = 0) {
  if (searchState.abort) searchState.abort.abort();
  searchState.abort = new AbortController();

  const results = $('import-search-results');
  if (!results) return;

  // New query → reset state + clear
  if (offset === 0) {
    searchState.query = query;
    searchState.offset = 0;
    results.innerHTML = '<div class="import-search-loading">Searching...</div>';
  }

  try {
    const url = `/api/search/combined?q=${encodeURIComponent(query)}&limit=10&offset=${offset}`;
    const resp = await fetch(url, {
      headers: { 'X-CSRF-TOKEN': (document.querySelector('meta[name="csrf-token"]') as any)?.content },
      signal: searchState.abort.signal
    });
    if (!resp.ok) throw new Error('Search failed');
    const data = await resp.json();
    await renderImportSearchResults(data.results || [], offset, data.has_more ?? false);
  } catch (err: any) {
    if (err.name !== 'AbortError') {
      results.innerHTML = '<div class="import-search-empty">Search failed. Please try again.</div>';
    }
  }
}

async function renderImportSearchResults(items: any[], offset: number, hasMore: boolean) {
  const container = $('import-search-results');
  if (!container) return;

  // Remove existing "Load more" button
  container.querySelector('.citation-load-more')?.remove();

  // New search → clear; pagination → append
  if (offset === 0) {
    container.innerHTML = '';
  }

  if (items.length === 0 && offset === 0) {
    container.innerHTML = '<div class="import-search-empty">No results found</div>';
    return;
  }

  items.forEach(result => {
    const button = document.createElement('button');
    button.className = 'citation-result-item';
    button.type = 'button';

    // Store metadata for selection
    button.dataset.bookId = result.book || result.id || '';
    button.dataset.bibtex = result.bibtex || '';
    button.dataset.hasNodes = (result.has_nodes == null || !!result.has_nodes) ? '1' : '0';
    button.dataset.source = result.source || 'library';
    button.dataset.title = result.title || '';
    button.dataset.author = result.author || '';
    button.dataset.year = result.year || '';
    button.dataset.journal = result.journal || '';
    button.dataset.url = result.url || result.oa_url || '';

    // Title-first display: <em>Title</em> — Author, Year, Journal
    const title = result.title || 'Untitled';
    const meta = [result.author, result.year, result.journal].filter(Boolean).join(', ');
    button.innerHTML = DOMPurify.sanitize(`<em>${title}</em>${meta ? ' &mdash; ' + meta : ''}`, {
      ALLOWED_TAGS: ['i', 'em', 'b', 'strong']
    });

    // Click / Enter handler — collapse results after selection
    const select = () => {
      handleImportSearchSelection(button);
      container.innerHTML = '';
    };
    button.addEventListener('click', select);
    button.addEventListener('keydown', (e: any) => { if (e.key === 'Enter') select(); });

    container.appendChild(button);
  });

  // "Load more" button
  if (hasMore) {
    const loadMore = document.createElement('button');
    loadMore.className = 'citation-load-more citation-result-item';
    loadMore.textContent = 'Load more results';

    const triggerLoadMore = (e: any) => {
      e.preventDefault();
      e.stopPropagation();
      if (loadMore.disabled) return;
      searchState.offset += 10;
      loadMore.textContent = 'Loading…';
      loadMore.disabled = true;
      performImportSearch(searchState.query, searchState.offset);
    };

    loadMore.addEventListener('touchend', triggerLoadMore, { passive: false });
    loadMore.addEventListener('click', triggerLoadMore);
    container.appendChild(loadMore);
  }
}

function handleImportSearchSelection(div: any) {
  const { bookId, bibtex, hasNodes, source, title, author, year, journal, url: resultUrl } = div.dataset;

  // Library result with existing content → show notice
  if (source === 'library' && hasNodes === '1' && bookId) {
    showLibraryMatchNotice(bookId, bibtex, title, author, year, resultUrl);
    return;
  }

  // Otherwise fill form directly
  fillFormFromSelection(bibtex, title, author, year, journal, resultUrl, bookId);
}

function showLibraryMatchNotice(bookId: any, bibtex: any, title: any, author: any, year: any, resultUrl: any) {
  const notice = $('library-match-notice');
  if (!notice) return;

  notice.style.display = '';

  // View existing
  const viewBtn = $('library-match-view');
  if (viewBtn) {
    viewBtn.href = `/${bookId}`;
    viewBtn.onclick = (e: any) => {
      // Navigate directly
      e.stopPropagation();
      // Mark external to preserve form state on mobile
      if ((window as any).newBookManager) (window as any).newBookManager.recentExternalLinkClick = true;
    };
  }

  // Create own version
  const ownBtn = $('library-match-own');
  if (ownBtn) {
    ownBtn.onclick = () => {
      notice.style.display = 'none';
      // Generate a variant ID (append _v2 etc.)
      const variantId = bookId + '_v2';
      fillFormFromSelection(bibtex, title, author, year, '', resultUrl, variantId);
    };
  }
}

async function fillFormFromSelection(bibtex: any, title: any, author: any, year: any, journal: any, resultUrl: any, bookId: any) {
  // Don't reveal #import-form-fields — detail fields stay hidden in search/bibtex modes.
  // The hidden inputs still get populated and submitted with the form.

  if (bibtex) {
    // Use BibTeX to populate all fields
    const bibtexField = $('bibtex');
    if (bibtexField) {
      bibtexField.value = bibtex;
      // Detect type
      const typeMatch = bibtex.match(/@(\w+)\s*\{/i);
      if (typeMatch) {
        const bibType = typeMatch[1].toLowerCase();
        const radio = qs(`input[name="type"][value="${bibType}"]`);
        if (radio) {
          radio.checked = true;
          showFieldsForType(bibType);
        } else {
          const misc = qs('input[name="type"][value="misc"]');
          if (misc) { misc.checked = true; showFieldsForType('misc'); }
        }
      }
      populateFieldsFromBibtex();
    }
  } else {
    // Set fields directly from metadata
    const setVal = (id: string, val: any) => { const el = $(id); if (el && val) el.value = val; };
    setVal('title', title);
    setVal('author', author);
    setVal('year', year);
    setVal('journal', journal);
    setVal('url', resultUrl);
  }

  // Auto-generate book ID with async uniqueness check
  // Always overwrite — populateFieldsFromBibtex may have set a raw key (e.g. OpenAlex W-ID)
  const generatedId = generateBookIdFromMetadata(bibtex, title, author, year);
  const bookField = $('book');
  if (bookField && generatedId) {
    const availableId = await findAvailableBookId(generatedId);
    bookField.value = availableId;
    updateBookUrlPreview(availableId);
    bookField.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // Trigger title validation
  const titleField = $('title');
  if (titleField) titleField.dispatchEvent(new Event('input', { bubbles: true }));
}
