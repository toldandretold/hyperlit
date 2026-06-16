// URL-import flow for the cite-form (#import-url-*): inspect an arXiv/DOI URL
// for metadata + access level, preview it, then commit (create the book) while
// polling import progress. Includes the human-readable error/reason maps and
// the slug suggester. Was setupUrlImport / waitForImportCompletion /
// humanFetchReason / humanError / suggestBookId + STAGE_LABELS of newBookForm.js.
import { $ } from './dom';
import { isLoggedIn } from '../../../utilities/auth/index';
import { escapeHtml } from '../../../paste/utils/normalizer.js';

export function setupUrlImport() {
  const urlInput = $('import-url-input');
  const fetchBtn = $('import-url-fetch');
  const status = $('import-url-status');
  const preview = $('import-url-preview');
  const previewBody = $('import-url-preview-body');
  const bookInput = $('import-url-book');
  const bookPreview = $('import-url-book-preview');
  const commitBtn = $('import-url-commit');
  if (!urlInput || !fetchBtn || !commitBtn) return;

  let lastInspected: any = null;

  const setStatus = (text: string, isError = false, link: any = null) => {
    if (!status) return;
    // Built via DOM nodes (not innerHTML) so untrusted URLs/labels can't inject markup.
    status.textContent = text;
    if (link?.url) {
      status.appendChild(document.createTextNode(' '));
      const a = document.createElement('a');
      a.href = link.url;
      a.textContent = link.label || link.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      status.appendChild(a);
    }
    status.className = 'validation-message' + (isError ? ' error' : '');
    status.style.display = (text || link) ? '' : 'none';
  };

  // Mirror the file-upload form's auth gate: anonymous users get a clear "log in /
  // register" prompt instead of a vague 401 from the backend's `author` middleware.
  const renderAuthPrompt = () => {
    if (!status) return;
    status.textContent = '';
    status.appendChild(document.createTextNode('You need to '));
    const openUserContainer = (mode: string) => async (e: any) => {
      e.preventDefault();
      (window as any).newBookManager?.closeContainer();
      const { initializeUserContainer } = await import('../../userButton/userButton');
      const mgr = initializeUserContainer();
      if (!mgr) return;
      mode === 'login' ? mgr.showLoginForm() : mgr.showRegisterForm();
    };
    const login = document.createElement('a');
    login.href = '#';
    login.textContent = 'log in';
    login.className = 'import-auth-link import-auth-login';
    login.addEventListener('click', openUserContainer('login'));
    const register = document.createElement('a');
    register.href = '#';
    register.textContent = 'register';
    register.className = 'import-auth-link import-auth-register';
    register.addEventListener('click', openUserContainer('register'));
    status.appendChild(login);
    status.appendChild(document.createTextNode(' or '));
    status.appendChild(register);
    status.appendChild(document.createTextNode(' to import books.'));
    status.className = 'validation-message error';
    status.style.display = '';
  };

  const requireAuth = async () => {
    if (await isLoggedIn()) return true;
    renderAuthPrompt();
    return false;
  };

  const hidePreview = () => {
    if (preview) preview.style.display = 'none';
    previewBody.innerHTML = '';
    lastInspected = null;
  };

  const fmtAccess = (plan: any) => {
    if (plan.access === 'open') {
      return `<span class="access-badge open">Open&nbsp;Access</span>`;
    }
    return `<span class="access-badge closed">Closed&nbsp;Access</span> &nbsp;— switch to <em>Import a file</em> to upload the PDF.`;
  };

  const fmtExistingVersions = (versions: any) => {
    if (!versions || !versions.length) return '';
    const items = versions.map((v: any) => {
      const meta = [v.author, v.year].filter(Boolean).join(' · ');
      return `
              <li>
                <a href="/${v.book}" class="import-existing-link">${escapeHtml(v.title || v.book)}</a>
                ${meta ? ` <span class="muted">${escapeHtml(meta)}</span>` : ''}
              </li>`;
    }).join('');
    return `
          <div class="import-existing-versions">
            <p><strong>This source is already in the library:</strong></p>
            <ul>${items}</ul>
            <p class="muted">Continue below to create your own version anyway.</p>
          </div>`;
  };

  const renderPreview = (data: any) => {
    const m = data.metadata || {};
    const title = decodeEntities(m.title || '(untitled)');
    const author = m.author || '';
    const year = m.year || '';
    const journal = m.journal || '';
    const meta = [author, year, journal].filter(Boolean).join(' · ');

    previewBody.innerHTML = `
          <div class="import-url-preview-card">
            <h3>${escapeHtml(title)}</h3>
            ${meta ? `<p class="muted">${escapeHtml(meta)}</p>` : ''}
            <p class="import-url-access-line">${fmtAccess(data.plan)}</p>
          </div>
          ${fmtExistingVersions(data.existing_versions)}
        `;

    const canCreate = data.plan.access === 'open';
    commitBtn.disabled = !canCreate;
    commitBtn.style.display = canCreate ? '' : 'none';
    bookInput.style.display = canCreate ? '' : 'none';
    bookInput.previousElementSibling && (bookInput.previousElementSibling.style.display = canCreate ? '' : 'none');

    // Always prefer the server-supplied unique slug — the server has the
    // authoritative view of which /url values are taken. Client-side
    // suggestion is only a fallback if the server didn't send one.
    if (canCreate) {
      const slug = data.suggested_slug || suggestBookId(m);
      bookInput.value = slug;
      bookPreview.textContent = slug || 'your-id';
    }
    preview.style.display = '';
    setStatus('');
  };

  function decodeEntities(s: any) {
    const txt = document.createElement('textarea');
    txt.innerHTML = s;
    return txt.value;
  }

  const inspect = async () => {
    const url = urlInput.value.trim();
    if (!url) return;
    if (!await requireAuth()) return;
    hidePreview();
    setStatus('');
    fetchBtn.disabled = true;
    fetchBtn.classList.add('is-loading');
    const originalFetchText = fetchBtn.textContent;
    fetchBtn.textContent = 'Looking up…';
    try {
      const resp = await fetch('/import-url/inspect', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-TOKEN': (document.querySelector('meta[name="csrf-token"]') as any)?.content,
          'Accept': 'application/json',
        },
        body: JSON.stringify({ url }),
      });
      const data = await resp.json();
      if (!resp.ok || !data.ok) {
        setStatus(humanError(data.error) || 'Could not resolve this URL.', true);
        return;
      }
      setStatus('');
      lastInspected = data;
      renderPreview(data);
    } catch (e) {
      console.error(e);
      setStatus('Network error while fetching metadata.', true);
    } finally {
      fetchBtn.disabled = false;
      fetchBtn.classList.remove('is-loading');
      fetchBtn.textContent = originalFetchText;
    }
  };

  fetchBtn.addEventListener('click', inspect);
  urlInput.addEventListener('keydown', (e: any) => {
    if (e.key === 'Enter') { e.preventDefault(); inspect(); }
  });

  bookInput.addEventListener('input', () => {
    const sanitized = bookInput.value.replace(/[^a-zA-Z0-9_-]/g, '');
    if (sanitized !== bookInput.value) bookInput.value = sanitized;
    bookPreview.textContent = sanitized || 'your-id';
  });

  commitBtn.addEventListener('click', async () => {
    if (!lastInspected) return;
    // Defensive re-check: session may have expired between inspect and commit.
    if (!await requireAuth()) return;
    const book = bookInput.value.trim();
    if (!book) { setStatus('Pick a /url for this book.', true); return; }
    commitBtn.disabled = true;
    commitBtn.classList.add('is-loading');
    commitBtn.textContent = 'Starting…';

    // Poll progress.json in parallel with the POST so the user sees live
    // "Opening browser / Locating PDF / Downloading PDF" updates during the
    // sync fetch instead of a dead spinner. The slug is already known.
    const pollCtl = { stop: false };
    const pollPromise = waitForImportCompletion(book, (label: any, pct: any, detail: any) => {
      if (pollCtl.stop) return;
      const human = STAGE_LABELS[label] || label || 'Working';
      commitBtn.textContent = pct != null ? `${human} ${pct}%` : `${human}…`;
      if (detail) setStatus(detail, false);
    }, pollCtl);

    const resetButton = () => {
      commitBtn.disabled = false;
      commitBtn.classList.remove('is-loading');
      commitBtn.textContent = 'Create Book';
    };

    try {
      const resp = await fetch('/import-url', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-TOKEN': (document.querySelector('meta[name="csrf-token"]') as any)?.content,
          'Accept': 'application/json',
        },
        body: JSON.stringify({ url: urlInput.value.trim(), book }),
      });
      const data = await resp.json();
      if (!resp.ok || !data.ok) {
        pollCtl.stop = true;
        await pollPromise.catch(() => {});
        const reasonMsg = data.reason ? humanFetchReason(data.reason) : null;
        const link = data.source_url
          ? { url: data.source_url, label: 'Open publisher page →' }
          : null;
        setStatus(reasonMsg || humanError(data.error) || 'Import failed.', true, link);
        resetButton();
        return;
      }
      // POST returned (fetch succeeded, job dispatched). Polling continues
      // through the queue processor until the worker has populated nodes.
      const result = await pollPromise;
      if (result.status === 'failed') {
        setStatus(result.detail || 'Import job failed. Check Laravel logs for details.', true);
        resetButton();
        return;
      }
      window.location.href = `/${data.bookId}`;
    } catch (e) {
      console.error(e);
      pollCtl.stop = true;
      setStatus('Network error during import.', true);
      resetButton();
    }
  });
}

const STAGE_LABELS: any = {
  fetching_metadata: 'Looking up source',
  fetching_pdf: 'Fetching PDF',
  fetching_pdf_browser: 'Opening browser',
  fetching_pdf_navigating: 'Navigating to publisher',
  fetching_pdf_locating: 'Locating PDF',
  fetching_pdf_downloading: 'Downloading PDF',
  fetch_failed: 'Fetch failed',
  queued: 'Queued',
  starting: 'Starting',
  doc_parse: 'Parsing',
  doc_bibliography: 'Reading bibliography',
  doc_footnotes: 'Reading footnotes',
  doc_linking: 'Linking citations',
  doc_footnote_linking: 'Linking footnotes',
  doc_audit: 'Auditing',
  doc_json_written: 'Writing nodes',
  db_write: 'Saving nodes',
  db_footnotes: 'Saving footnotes',
  db_references: 'Saving references',
  metadata: 'Finishing',
  processing: 'Processing',
};

async function waitForImportCompletion(bookId: any, onProgress: any, ctl: any) {
  const POLL_INTERVAL = 1500;
  const MAX_WAIT_MS = 10 * 60 * 1000;
  const start = Date.now();
  while (Date.now() - start < MAX_WAIT_MS) {
    if (ctl?.stop) return { status: 'cancelled' };
    try {
      const resp = await fetch(`/api/import-progress/${bookId}`);
      if (resp.ok) {
        const data = await resp.json();
        if (data.status === 'complete') return { status: 'complete', detail: data.detail };
        if (data.status === 'failed') return { status: 'failed', detail: data.detail };
        onProgress?.(data.stage || 'processing', data.percent ?? null, data.detail);
      } else if (resp.status !== 404) {
        // 404 just means progress.json hasn't been written yet; keep polling.
        console.warn(`[urlImport] progress poll ${resp.status}`);
      }
    } catch (e) {
      console.warn('[urlImport] progress poll network error', e);
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL));
  }
  return { status: 'timeout' };
}

function humanFetchReason(reason: any) {
  switch (reason) {
    case 'cloudflare_block': return 'Publisher blocked the download (Cloudflare). Try uploading the PDF directly.';
    case 'playwright_timeout': return 'Publisher took too long to respond. Try again, or upload the PDF directly.';
    case 'no_pdf_link_found': return "Couldn't find a downloadable PDF on the publisher's page.";
    case 'not_a_pdf': return 'Publisher returned a non-PDF response.';
    case 'blocked': return 'Publisher refused the download.';
    case 'http_error': return 'Publisher returned an error.';
    case 'navigation_failed': return "Couldn't load the publisher's page.";
    case 'node_unavailable': return 'PDF fetcher service is not available on the server.';
    case 'playwright_not_installed': return 'PDF fetcher service is not installed on the server.';
    case 'playwright_crash': return 'PDF fetcher crashed. Try again or upload the PDF directly.';
    case 'no_fetcher_attempted': return 'No PDF source available for this work.';
    default: return null;
  }
}

function suggestBookId(metadata: any) {
  const author = (metadata.author || '').split(/[;,]/)[0].trim().split(/\s+/).pop() || '';
  const year = metadata.year || '';
  const titleSlug = (metadata.title || '').toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/).slice(0, 3).join('-');
  return [author.toLowerCase(), year, titleSlug].filter(Boolean).join('-').replace(/[^a-z0-9_-]/g, '');
}

function humanError(code: any) {
  switch (code) {
    case 'unrecognised_identifier': return "Couldn't recognise that as an arXiv URL or DOI.";
    case 'metadata_unavailable': return "Couldn't find metadata for this work.";
    case 'metadata_unavailable_but_canonical_exists': return 'This source exists in the library, but external metadata could not be refreshed.';
    case 'closed_access_requires_upload': return 'This work is not open access. Switch to "Import a file" to upload the PDF.';
    case 'canonical_already_exists': return 'This source already exists in the library.';
    case 'book_id_taken': return 'That /url is already taken — pick a different one.';
    case 'content_fetch_failed': return 'We could not download the content. Try uploading the file instead.';
    case 'invalid_session': return 'Please sign in first.';
    default: return code ? code.replaceAll('_', ' ') : '';
  }
}
