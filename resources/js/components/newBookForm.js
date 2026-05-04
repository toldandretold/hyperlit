import { openDatabase } from '../indexedDB/index.js';
import '../utilities/debugLog.js';
import { generateBibtexFromForm } from "../utilities/bibtexProcessor.js";
import { getCurrentUser, getAnonymousToken, getCurrentUserInfo, isLoggedIn } from "../utilities/auth.js";
import { loadFromJSONFiles, loadHyperText } from '../initializePage.js';
import { escapeHtml } from '../paste/utils/normalizer.js';
import DOMPurify from 'dompurify';
// Navigation imports moved to new system - see submitToLaravelAndLoad function

// When the user clicks "Re-submit" from the footnote audit modal, the book ID
// from the cancelled import is stored here so that both the submit-time and
// real-time validators skip the server uniqueness check for that specific ID.
let allowedResubmitBookId = null;

// ─── PDF Cost Estimate ───────────────────────────────────────────────
const MISTRAL_OCR_COST_PER_1K_PAGES = 1.00;

const BILLING_TIERS = {
    premium:    { multiplier: 1.0, label: 'Premium' },
    budget:     { multiplier: 1.5, label: 'Budget' },
    solidarity: { multiplier: 2.0, label: 'Solidarity' },
    capitalist: { multiplier: 5.0, label: 'Honest Capitalist' },
};

function getUserTier() {
    const status = getCurrentUserInfo()?.status;
    return BILLING_TIERS[status] || BILLING_TIERS.budget;
}

let _pdfjsPromise = null;
function loadPdfJs() {
    if (!_pdfjsPromise) {
        _pdfjsPromise = import('https://cdn.jsdelivr.net/npm/pdfjs-dist@4.9.155/+esm')
            .then(mod => {
                const pdfjsLib = mod;
                pdfjsLib.GlobalWorkerOptions.workerSrc =
                    'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.9.155/build/pdf.worker.min.mjs';
                return pdfjsLib;
            })
            .catch(err => {
                _pdfjsPromise = null; // allow retry on next call
                throw err;
            });
    }
    return _pdfjsPromise;
}

async function showPdfCostEstimate(file) {
    const el = document.getElementById('pdf-cost-estimate');
    if (!el) return;

    // Show loading state
    el.style.display = 'block';
    el.style.color = 'var(--color-accent, #00bcd4)';
    el.style.fontSize = '13px';
    el.style.marginTop = '6px';
    el.style.padding = '8px 10px';
    el.style.borderRadius = '4px';
    el.style.backgroundColor = 'rgba(0, 188, 212, 0.08)';
    el.style.border = '1px solid rgba(0, 188, 212, 0.25)';
    el.textContent = 'Reading PDF...';

    try {
        const pdfjsLib = await loadPdfJs();
        const arrayBuffer = await file.arrayBuffer();
        const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
        const numPages = pdf.numPages;

        // Extract PDF metadata for auto-fill
        let pdfTitle = '', pdfAuthor = '', pdfYear = '';
        try {
            const meta = await pdf.getMetadata();
            const info = meta?.info || {};
            pdfTitle = (info.Title || '').trim();
            pdfAuthor = (info.Author || '').trim();
            // PDF dates are typically "D:YYYYMMDDHHmmSS" or similar
            const creationDate = info.CreationDate || '';
            const yearMatch = creationDate.match(/D:(\d{4})/) || creationDate.match(/(\d{4})/);
            if (yearMatch) pdfYear = yearMatch[1];
        } catch (metaErr) {
            console.warn('PDF metadata extraction failed (non-fatal):', metaErr);
        }
        pdf.destroy();

        // Auto-fill empty form fields from PDF metadata
        const setIfEmpty = (id, val) => {
            const el = document.getElementById(id);
            if (el && !el.value.trim() && val) {
                el.value = val;
                el.dispatchEvent(new Event('input', { bubbles: true }));
            }
        };
        setIfEmpty('title', pdfTitle);
        setIfEmpty('author', pdfAuthor);
        setIfEmpty('year', pdfYear);

        // Auto-generate book ID if empty
        const bookField = document.getElementById('book');
        if (bookField && !bookField.value.trim() && (pdfTitle || pdfAuthor)) {
            const generatedId = generateBookIdFromMetadata(null, pdfTitle, pdfAuthor, pdfYear);
            if (generatedId) {
                const availableId = await findAvailableBookId(generatedId);
                bookField.value = availableId;
                updateBookUrlPreview(availableId);
                bookField.dispatchEvent(new Event('input', { bubbles: true }));
            }
        }

        const tier = getUserTier();
        const baseCost = (numPages / 1000) * MISTRAL_OCR_COST_PER_1K_PAGES;
        const userCost = baseCost * tier.multiplier;

        const userStatus = getCurrentUserInfo()?.status || 'budget';
        const tierList = Object.entries(BILLING_TIERS)
            .map(([key, t]) => {
                const display = key === 'premium' ? `${t.label}: unlimited` : `${t.label}: ${t.multiplier}x`;
                return key === userStatus ? `<strong>${display} (you)</strong>` : display;
            })
            .join(' · ');

        const isPremium = userStatus === 'premium';
        el.innerHTML = isPremium
            ? `PDF: ${numPages} page${numPages !== 1 ? 's' : ''} — <strong>Included with Premium</strong>`
            : `PDF: ${numPages} page${numPages !== 1 ? 's' : ''} — Estimated cost: <strong>$${userCost.toFixed(2)}</strong>`
                + ` <span style="opacity:0.7">(${tier.multiplier}x ${tier.label})</span>`
                + ` <span class="pdf-cost-info-toggle" tabindex="0" role="button" aria-label="Pricing info" style="cursor:pointer;display:inline-block;width:15px;height:15px;line-height:15px;text-align:center;border-radius:50%;border:1px solid rgba(0,188,212,0.5);font-size:10px;vertical-align:middle;margin-left:4px;">?</span>`
                + `<span class="pdf-cost-info-detail" style="display:none;"> Mistral OCR costs $1.00/1k pages, multiplied by your tier: ${tierList}. For no markup, <a href="https://github.com/toldandretold/hyperlit" target="_blank" style="color:inherit;text-decoration:underline;">clone Hyperlit from GitHub</a> (it's free software) and use your own API key.</span>`;

        const toggle = el.querySelector('.pdf-cost-info-toggle');
        const detail = el.querySelector('.pdf-cost-info-detail');
        if (toggle && detail) {
            toggle.addEventListener('click', () => {
                const open = detail.style.display === 'none';
                detail.style.display = open ? 'inline' : 'none';
                toggle.textContent = open ? '?' : '?';
            });
        }
    } catch (err) {
        console.warn('PDF cost estimate failed:', err);
        el.style.color = '#EF8D34';
        el.style.backgroundColor = 'rgba(239, 141, 52, 0.08)';
        el.style.border = '1px solid rgba(239, 141, 52, 0.25)';
        el.textContent = 'Could not determine page count';
    }
}

function hidePdfCostEstimate() {
    const el = document.getElementById('pdf-cost-estimate');
    if (el) {
        el.style.display = 'none';
        el.textContent = '';
    }
}

function showInsufficientBalanceBanner() {
    // Remove any existing banner
    document.getElementById('insufficient-balance-banner')?.remove();

    const banner = document.createElement('div');
    banner.id = 'insufficient-balance-banner';
    banner.style.cssText = 'display:block; color:#d63384; font-size:13px; margin-top:8px; padding:10px 12px; border-radius:4px; background:rgba(214,51,132,0.08); border:1px solid rgba(214,51,132,0.3);';
    banner.innerHTML =
        '<strong>Insufficient balance.</strong> PDF import is billed per page. Please top up your credits to continue.' +
        '<br><a href="#" onclick="event.preventDefault(); fetch(\'/api/billing/checkout\', { method: \'POST\', headers: { \'Content-Type\': \'application/json\', \'Accept\': \'application/json\', \'X-XSRF-TOKEN\': decodeURIComponent(document.cookie.match(/XSRF-TOKEN=([^;]+)/)?.[1] || \'\') }, credentials: \'include\', body: JSON.stringify({ amount: 5, return_url: window.location.href }) }).then(r => r.json()).then(d => { if (d.checkout_url) window.location.href = d.checkout_url; })" style="display:inline-block; margin-top:8px; padding:6px 14px; background:#d63384; color:#fff; border-radius:4px; text-decoration:none; font-size:13px; font-weight:500;">Top Up Balance</a>';

    // Insert after the pdf-cost-estimate div, or after the file validation div
    const anchor = document.getElementById('pdf-cost-estimate') || document.getElementById('file-validation');
    if (anchor && anchor.parentNode) {
        anchor.parentNode.insertBefore(banner, anchor.nextSibling);
    }
}

function hideInsufficientBalanceBanner() {
    document.getElementById('insufficient-balance-banner')?.remove();
}

function handlePdfCostEstimate(fileInput) {
    if (!fileInput || !fileInput.files || fileInput.files.length === 0) {
        hidePdfCostEstimate();
        return;
    }
    const file = fileInput.files[0];
    if (file && file.name.toLowerCase().endsWith('.pdf')) {
        showPdfCostEstimate(file);
    } else {
        hidePdfCostEstimate();
    }
}

async function handleFileMetadataExtraction(fileInput) {
    if (!fileInput || !fileInput.files || fileInput.files.length === 0) {
        hidePdfCostEstimate();
        return;
    }
    const file = fileInput.files[0];
    const name = file.name.toLowerCase();

    // PDF: delegate to existing cost estimate + metadata path
    if (name.endsWith('.pdf')) {
        showPdfCostEstimate(file);
        return;
    }

    hidePdfCostEstimate();

    // Non-PDF: extract metadata from file contents
    const ext = name.split('.').pop();
    if (!['md', 'epub', 'docx', 'html', 'htm'].includes(ext)) return;

    try {
        const { extractFileMetadata } = await import('../utilities/fileMetadataExtractor.js');
        const meta = await extractFileMetadata(file);

        const setIfEmpty = (id, val) => {
            const el = document.getElementById(id);
            if (el && !el.value.trim() && val) {
                el.value = val;
                el.dispatchEvent(new Event('input', { bubbles: true }));
            }
        };
        setIfEmpty('title', meta.title);
        setIfEmpty('author', meta.author);
        setIfEmpty('year', meta.year);

        // Auto-generate book ID if empty
        const bookField = document.getElementById('book');
        if (bookField && !bookField.value.trim() && (meta.title || meta.author)) {
            const generatedId = generateBookIdFromMetadata(null, meta.title, meta.author, meta.year);
            if (generatedId) {
                const availableId = await findAvailableBookId(generatedId);
                bookField.value = availableId;
                updateBookUrlPreview(availableId);
                bookField.dispatchEvent(new Event('input', { bubbles: true }));
            }
        }
    } catch (err) {
        console.warn('File metadata extraction failed (non-fatal):', err);
    }
}

// Add the helper functions from createNewBook.js
function generateUUID() {
  return ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(
    /[018]/g,
    (c) =>
      (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] &
        (15 >> (c / 4)))).toString(16)
  );
}
 
async function getCreatorId() {
  // Use the new authentication system instead of localStorage
  const userId = await getCurrentUserId();
  console.log('getCreatorId() returning:', userId, typeof userId);
  return userId;
}

// Global functions that need to be accessible everywhere
function showFieldsForType(type) {
    document.querySelectorAll('.optional-field').forEach(field => {
        field.style.display = 'none';
        field.previousElementSibling.style.display = 'none';
    });

    // Always show common fields like URL
    const urlField = document.getElementById('url');
    if (urlField) urlField.style.display = 'block';

    if (type === 'article') {
        document.getElementById('journal').style.display = 'block';
        document.querySelector('label[for="journal"]').style.display = 'block';
        document.getElementById('volume').style.display = 'block';
        document.querySelector('label[for="volume"]').style.display = 'block';
        document.getElementById('issue').style.display = 'block';
        document.querySelector('label[for="issue"]').style.display = 'block';
        document.getElementById('pages').style.display = 'block';
        document.querySelector('label[for="pages"]').style.display = 'block';
    } else if (type === 'book') {
        document.getElementById('publisher').style.display = 'block';
        document.querySelector('label[for="publisher"]').style.display = 'block';
    } else if (type === 'incollection') {
        document.getElementById('booktitle').style.display = 'block';
        document.querySelector('label[for="booktitle"]').style.display = 'block';
        document.getElementById('editor').style.display = 'block';
        document.querySelector('label[for="editor"]').style.display = 'block';
        document.getElementById('publisher').style.display = 'block';
        document.querySelector('label[for="publisher"]').style.display = 'block';
        document.getElementById('chapter').style.display = 'block';
        document.querySelector('label[for="chapter"]').style.display = 'block';
        document.getElementById('pages').style.display = 'block';
        document.querySelector('label[for="pages"]').style.display = 'block';
    } else if (type === 'phdthesis') {
        document.getElementById('school').style.display = 'block';
        document.querySelector('label[for="school"]').style.display = 'block';
    } else if (type === 'misc') {
        document.getElementById('note').style.display = 'block';
        document.querySelector('label[for="note"]').style.display = 'block';
    }
}

function populateFieldsFromBibtex() {
    const bibtexField = document.getElementById('bibtex');
    if (!bibtexField) return;
    
    const bibtexText = bibtexField.value.trim();
    if (!bibtexText) return;

    const patterns = {
        id: /@\w+\s*\{\s*([^,]+)\s*,/,
        title: /title\s*=\s*[\{"']([^}\"']+)[\}"']/i,
        author: /author\s*=\s*[\{"']([^}\"']+)[\}"']/i,
        journal: /journal\s*=\s*[\{"']([^}\"']+)[\}"']/i,
        year: /year\s*=\s*[\{"']?(\d+)[\}"']?/i,
        pages: /pages\s*=\s*[\{"']([^}\"']+)[\}"']/i,
        publisher: /publisher\s*=\s*[\{"']([^}\"']+)[\}"']/i,
        school: /school\s*=\s*[\{"']([^}\"']+)[\}"']/i,
        note: /note\s*=\s*[\{"']([^}\"']+)[\}"']/i,
        url: /url\s*=\s*[\{"']([^}\"']+)[\}"']/i,
        volume: /volume\s*=\s*[\{"']([^}\"']+)[\}"']/i,
        issue: /number\s*=\s*[\{"']([^}\"']+)[\}"']/i,
        booktitle: /booktitle\s*=\s*[\{"']([^}\"']+)[\}"']/i,
        chapter: /chapter\s*=\s*[\{"']([^}\"']+)[\}"']/i,
        editor: /editor\s*=\s*[\{"']([^}\"']+)[\}"']/i
    };

    let changed = false;
    Object.entries(patterns).forEach(([field, pattern]) => {
        const match = bibtexText.match(pattern);
        if (match) {
            const fieldName = field === 'id' ? 'book' : field;
            const element = document.getElementById(fieldName);
            if (element) {
                let newVal = match[1].trim();
                
                // Auto-format URL if it's a URL field
                if (field === 'url' && newVal && !newVal.match(/^https?:\/\//i)) {
                    newVal = `https://${newVal}`;
                }
                
                if (element.value !== newVal) {
                    element.value = newVal;
                    changed = true;
                }
            }
        }
    });

    // If fields were updated programmatically, trigger their validation listeners
    if (changed) {
        const bookField = document.getElementById('book');
        const title = document.getElementById('title');
        if (bookField) bookField.dispatchEvent(new Event('input', { bubbles: true }));
        if (title) title.dispatchEvent(new Event('input', { bubbles: true }));
    }
}

// ─── Import Mode: state ───────────────────────────────────────────────
let importSearchAbort = null;
let importSearchDebounce = null;
let importSearchOffset = 0;
let importSearchQuery = '';

// ─── Mode Switching ──────────────────────────────────────────────────
function setupModeSwitching() {
    const modeRadios = document.querySelectorAll('input[name="import_mode"]');
    if (!modeRadios.length) return;

    modeRadios.forEach(radio => {
        radio.addEventListener('change', () => switchImportMode(radio.value));
    });
}

function switchImportMode(mode) {
    const searchPanel = document.getElementById('import-mode-search');
    const bibtexPanel = document.getElementById('import-mode-bibtex');
    const formFields = document.getElementById('import-form-fields');
    const libraryNotice = document.getElementById('library-match-notice');

    // Abort in-flight search
    if (importSearchAbort) { importSearchAbort.abort(); importSearchAbort = null; }

    // Hide library notice
    if (libraryNotice) libraryNotice.style.display = 'none';

    // Toggle panels
    if (searchPanel) searchPanel.style.display = mode === 'search' ? '' : 'none';
    if (bibtexPanel) bibtexPanel.style.display = mode === 'bibtex' ? '' : 'none';

    if (mode === 'manual') {
        // Show form fields immediately
        if (formFields) formFields.style.display = '';
    } else if (mode === 'search') {
        // Hide form fields until a result is selected
        if (formFields) formFields.style.display = 'none';
        // Clear search results + reset pagination
        importSearchOffset = 0;
        importSearchQuery = '';
        const results = document.getElementById('import-search-results');
        if (results) results.innerHTML = '';
        const input = document.getElementById('import-search-input');
        if (input) { input.value = ''; input.focus(); }
    } else if (mode === 'bibtex') {
        // Hide form fields until bibtex is parsed
        if (formFields) formFields.style.display = 'none';
        const bibtex = document.getElementById('bibtex');
        if (bibtex) bibtex.focus();
    }
}

// ─── Search Functionality ────────────────────────────────────────────
function setupImportSearch() {
    const input = document.getElementById('import-search-input');
    if (!input) return;

    input.addEventListener('input', () => {
        clearTimeout(importSearchDebounce);
        const query = input.value.trim();
        if (query.length < 2) {
            const results = document.getElementById('import-search-results');
            if (results) results.innerHTML = '';
            return;
        }
        importSearchDebounce = setTimeout(() => performImportSearch(query), 300);
    });
}

async function performImportSearch(query, offset = 0) {
    if (importSearchAbort) importSearchAbort.abort();
    importSearchAbort = new AbortController();

    const results = document.getElementById('import-search-results');
    if (!results) return;

    // New query → reset state + clear
    if (offset === 0) {
        importSearchQuery = query;
        importSearchOffset = 0;
        results.innerHTML = '<div class="import-search-loading">Searching...</div>';
    }

    try {
        const url = `/api/search/combined?q=${encodeURIComponent(query)}&limit=10&offset=${offset}`;
        const resp = await fetch(url, {
            headers: { 'X-CSRF-TOKEN': document.querySelector('meta[name="csrf-token"]')?.content },
            signal: importSearchAbort.signal
        });
        if (!resp.ok) throw new Error('Search failed');
        const data = await resp.json();
        await renderImportSearchResults(data.results || [], offset, data.has_more ?? false);
    } catch (err) {
        if (err.name !== 'AbortError') {
            results.innerHTML = '<div class="import-search-empty">Search failed. Please try again.</div>';
        }
    }
}

async function renderImportSearchResults(items, offset, hasMore) {
    const container = document.getElementById('import-search-results');
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
        button.addEventListener('keydown', (e) => { if (e.key === 'Enter') select(); });

        container.appendChild(button);
    });

    // "Load more" button
    if (hasMore) {
        const loadMore = document.createElement('button');
        loadMore.className = 'citation-load-more citation-result-item';
        loadMore.textContent = 'Load more results';

        const triggerLoadMore = (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (loadMore.disabled) return;
            importSearchOffset += 10;
            loadMore.textContent = 'Loading\u2026';
            loadMore.disabled = true;
            performImportSearch(importSearchQuery, importSearchOffset);
        };

        loadMore.addEventListener('touchend', triggerLoadMore, { passive: false });
        loadMore.addEventListener('click', triggerLoadMore);
        container.appendChild(loadMore);
    }
}

// ─── Search Result Selection ─────────────────────────────────────────
function handleImportSearchSelection(div) {
    const { bookId, bibtex, hasNodes, source, title, author, year, journal, url: resultUrl } = div.dataset;

    // Library result with existing content → show notice
    if (source === 'library' && hasNodes === '1' && bookId) {
        showLibraryMatchNotice(bookId, bibtex, title, author, year, resultUrl);
        return;
    }

    // Otherwise fill form directly
    fillFormFromSelection(bibtex, title, author, year, journal, resultUrl, bookId);
}

function showLibraryMatchNotice(bookId, bibtex, title, author, year, resultUrl) {
    const notice = document.getElementById('library-match-notice');
    if (!notice) return;

    notice.style.display = '';

    // View existing
    const viewBtn = document.getElementById('library-match-view');
    if (viewBtn) {
        viewBtn.href = `/${bookId}`;
        viewBtn.onclick = (e) => {
            // Navigate directly
            e.stopPropagation();
            // Mark external to preserve form state on mobile
            if (window.newBookManager) window.newBookManager.recentExternalLinkClick = true;
        };
    }

    // Create own version
    const ownBtn = document.getElementById('library-match-own');
    if (ownBtn) {
        ownBtn.onclick = () => {
            notice.style.display = 'none';
            // Generate a variant ID (append _v2 etc.)
            const variantId = bookId + '_v2';
            fillFormFromSelection(bibtex, title, author, year, '', resultUrl, variantId);
        };
    }
}

async function fillFormFromSelection(bibtex, title, author, year, journal, resultUrl, bookId) {
    // Don't reveal #import-form-fields — detail fields stay hidden in search/bibtex modes.
    // The hidden inputs still get populated and submitted with the form.

    if (bibtex) {
        // Use BibTeX to populate all fields
        const bibtexField = document.getElementById('bibtex');
        if (bibtexField) {
            bibtexField.value = bibtex;
            // Detect type
            const typeMatch = bibtex.match(/@(\w+)\s*\{/i);
            if (typeMatch) {
                const bibType = typeMatch[1].toLowerCase();
                const radio = document.querySelector(`input[name="type"][value="${bibType}"]`);
                if (radio) {
                    radio.checked = true;
                    showFieldsForType(bibType);
                } else {
                    const misc = document.querySelector('input[name="type"][value="misc"]');
                    if (misc) { misc.checked = true; showFieldsForType('misc'); }
                }
            }
            populateFieldsFromBibtex();
        }
    } else {
        // Set fields directly from metadata
        const setVal = (id, val) => { const el = document.getElementById(id); if (el && val) el.value = val; };
        setVal('title', title);
        setVal('author', author);
        setVal('year', year);
        setVal('journal', journal);
        setVal('url', resultUrl);
    }

    // Auto-generate book ID with async uniqueness check
    // Always overwrite — populateFieldsFromBibtex may have set a raw key (e.g. OpenAlex W-ID)
    const generatedId = generateBookIdFromMetadata(bibtex, title, author, year);
    const bookField = document.getElementById('book');
    if (bookField && generatedId) {
        const availableId = await findAvailableBookId(generatedId);
        bookField.value = availableId;
        updateBookUrlPreview(availableId);
        bookField.dispatchEvent(new Event('input', { bubbles: true }));
    }

    // Trigger title validation
    const titleField = document.getElementById('title');
    if (titleField) titleField.dispatchEvent(new Event('input', { bubbles: true }));
}

// ─── Book ID Auto-generation ─────────────────────────────────────────
function generateBookIdFromMetadata(bibtex, title, author, year) {
    // Priority 1: extract citation key from BibTeX (only if it looks human-readable)
    if (bibtex) {
        const keyMatch = bibtex.match(/@\w+\s*\{\s*([^,\s]+)\s*,/);
        if (keyMatch && keyMatch[1] && /^[a-zA-Z0-9_-]+$/.test(keyMatch[1]) && keyMatch[1].length >= 3
            && /[a-zA-Z]{2,}/.test(keyMatch[1])) {
            return keyMatch[1];
        }
    }

    const lastName = author ? author.split(/[,\s]+/)[0].replace(/[^a-zA-Z]/g, '').toLowerCase() : '';
    const firstTitleWord = title ? title.split(/\s+/)[0].replace(/[^a-zA-Z0-9]/g, '').toLowerCase() : '';

    // Priority 2: author + year + title → lastNameYEARfirstWord
    if (lastName.length >= 2 && year && firstTitleWord) {
        return lastName + year + firstTitleWord;
    }

    // Priority 3: author + year (no title)
    if (lastName.length >= 2 && year) {
        return lastName + year;
    }

    // Priority 4: title + year (no author)
    if (firstTitleWord && year) {
        return firstTitleWord + year;
    }

    // Priority 5: just title → first three words
    if (title) {
        const slug = title.toLowerCase()
            .replace(/[^a-z0-9\s]/g, '')
            .split(/\s+/)
            .slice(0, 3)
            .join('_');
        if (slug.length >= 3) return slug;
    }

    // Fallback
    return 'import_' + Date.now();
}

async function findAvailableBookId(baseId) {
    const csrf = document.querySelector('meta[name="csrf-token"]')?.content;

    const tryCandidate = async (candidate) => {
        const resp = await fetch('/api/validate-book-id', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-TOKEN': csrf },
            body: JSON.stringify({ book: candidate })
        });
        const data = await resp.json();
        return data.success && !data.exists;
    };

    // Phase 1: baseId, then _v2 through _v5
    for (let i = 0; i < 5; i++) {
        const candidate = i === 0 ? baseId : `${baseId}_v${i + 1}`;
        try {
            if (await tryCandidate(candidate)) return candidate;
        } catch { break; }
    }

    // Phase 2: 3 attempts with random 4-digit suffix
    for (let i = 0; i < 3; i++) {
        const rand = Math.floor(1000 + Math.random() * 9000);
        const candidate = `${baseId}_${rand}`;
        try {
            if (await tryCandidate(candidate)) return candidate;
        } catch { break; }
    }

    // Ultimate fallback: timestamp (guaranteed unique)
    return `${baseId}_${Date.now()}`;
}

function updateBookUrlPreview(value) {
    const preview = document.getElementById('book-url-preview');
    if (preview) {
        preview.textContent = value || 'your-id';
    }
}

function setupBookUrlPreview() {
    const bookField = document.getElementById('book');
    if (!bookField) return;
    bookField.addEventListener('input', () => {
        updateBookUrlPreview(bookField.value.trim());
    });
}

// ─── BibTeX Mode Enhancement ─────────────────────────────────────────
function setupBibtexModeAutoReveal() {
    const bibtexField = document.getElementById('bibtex');
    if (!bibtexField) return;

    // Watch for successful parse → auto-reveal form fields
    const observer = new MutationObserver(() => {});
    // Instead of MutationObserver, hook into the existing input/paste handlers
    // by checking if title got populated after bibtex change
    bibtexField.addEventListener('input', () => {
        clearTimeout(bibtexField._revealTimer);
        bibtexField._revealTimer = setTimeout(() => {
            checkBibtexAndReveal();
        }, 400);
    });
    bibtexField.addEventListener('paste', () => {
        setTimeout(() => checkBibtexAndReveal(), 100);
    });
}

async function checkBibtexAndReveal() {
    const currentMode = document.querySelector('input[name="import_mode"]:checked')?.value;
    if (currentMode !== 'bibtex') return;

    const titleField = document.getElementById('title');
    if (titleField && titleField.value.trim()) {
        // Title was populated — don't reveal #import-form-fields in bibtex mode;
        // detail fields stay hidden. The user sees file upload + /url + submit.

        // Auto-generate book ID if empty
        const bookField = document.getElementById('book');
        if (bookField && !bookField.value) {
            const bibtex = document.getElementById('bibtex')?.value || '';
            const title = titleField.value;
            const author = document.getElementById('author')?.value || '';
            const year = document.getElementById('year')?.value || '';
            const generatedId = generateBookIdFromMetadata(bibtex, title, author, year);
            if (generatedId) {
                const availableId = await findAvailableBookId(generatedId);
                bookField.value = availableId;
                updateBookUrlPreview(availableId);
                bookField.dispatchEvent(new Event('input', { bubbles: true }));
            }
        }
    }
}

function validateFileInput() {
    const fileInput = document.getElementById('markdown_file');
    
    let errorMsg = document.getElementById('file-error-message');
    if (!errorMsg) {
        errorMsg = document.createElement('div');
        errorMsg.id = 'file-error-message';
        errorMsg.style.color = 'red';
        errorMsg.style.marginTop = '5px';
        errorMsg.style.fontSize = '14px';
        fileInput.parentNode.insertBefore(errorMsg, fileInput.nextSibling);
    }
    
    if (!fileInput || !fileInput.files || fileInput.files.length === 0) {
        errorMsg.textContent = 'Please select a file to upload';
        errorMsg.style.display = 'block';
        return false;
    }
    
    // Handle folder upload (multiple files)
    if (fileInput.files.length > 1) {
        let hasMarkdown = false;
        let hasInvalidFiles = false;
        const validImageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg'];
        const validFileExts = ['.md', ...validImageExts];
        
        for (let i = 0; i < fileInput.files.length; i++) {
            const file = fileInput.files[i];
            const fileName = file.name.toLowerCase();
            const hasValidExt = validFileExts.some(ext => fileName.endsWith(ext));
            
            if (!hasValidExt) {
                hasInvalidFiles = true;
                break;
            }
            
            if (fileName.endsWith('.md')) {
                hasMarkdown = true;
            }
        }
        
        if (!hasMarkdown) {
            errorMsg.textContent = 'Folder must contain at least one .md file';
            errorMsg.style.display = 'block';
            return false;
        }
        
        if (hasInvalidFiles) {
            errorMsg.textContent = 'Folder should only contain .md and image files';
            errorMsg.style.display = 'block';
            return false;
        }
        
        errorMsg.style.display = 'none';
        return true;
    }
    
    // Handle single file upload
    const file = fileInput.files[0];
    const fileName = file.name.toLowerCase();
    const validExtensions = ['.md', '.epub', '.doc', '.docx', '.html', '.pdf'];
    const isValidType = validExtensions.some(ext => fileName.endsWith(ext));

    if (!isValidType) {
        const extList = validExtensions.join(', ');
        errorMsg.textContent = `Please select a valid file (${extList})`;
        errorMsg.style.display = 'block';
        return false;
    }
    
    errorMsg.style.display = 'none';
    return true;
}

function resetSubmitButton(submitButton) {
    if (submitButton) {
        submitButton.disabled = false;
        submitButton.textContent = 'Submit';
    }
}

// Form data persistence functions
function saveFormData() {
    const selectedType = document.querySelector('input[name="type"]:checked');
    const formData = {
        bibtex: document.getElementById('bibtex').value,
        author: document.getElementById('author').value,
        title: document.getElementById('title').value,
        journal: document.getElementById('journal').value,
        publisher: document.getElementById('publisher').value,
        year: document.getElementById('year').value,
        pages: document.getElementById('pages').value,
        book: document.getElementById('book').value,
        url: document.getElementById('url').value,
        school: document.getElementById('school').value,
        note: document.getElementById('note').value,
        volume: document.getElementById('volume')?.value || '',
        issue: document.getElementById('issue')?.value || '',
        booktitle: document.getElementById('booktitle')?.value || '',
        chapter: document.getElementById('chapter')?.value || '',
        editor: document.getElementById('editor')?.value || '',
        type: selectedType ? selectedType.value : '',
        import_mode: document.querySelector('input[name="import_mode"]:checked')?.value || 'search'
    };
    localStorage.setItem('formData', JSON.stringify(formData));
}

function loadFormData() {
    const savedData = localStorage.getItem('formData');
    if (savedData) {
        const formData = JSON.parse(savedData);

        // Restore import mode first
        if (formData.import_mode) {
            const modeRadio = document.querySelector(`input[name="import_mode"][value="${formData.import_mode}"]`);
            if (modeRadio) {
                modeRadio.checked = true;
                switchImportMode(formData.import_mode);
            }
        }

        Object.entries(formData).forEach(([key, value]) => {
            const element = document.getElementById(key);
            if (element && value) {
                element.value = value;
            }
        });

        if (formData.type) {
            const radio = document.querySelector(`input[name="type"][value="${formData.type}"]`);
            if (radio) {
                radio.checked = true;
                showFieldsForType(formData.type);
            }
        }

        // After restoring values, trigger validations so the user sees status immediately
        setTimeout(() => {
            try {
                const bookField = document.getElementById('book');
                const title = document.getElementById('title');
                const fileInput = document.getElementById('markdown_file');

                // Kick title validators (immediate UX feedback)
                if (title) {
                    title.dispatchEvent(new Event('input', { bubbles: true }));
                    title.dispatchEvent(new Event('blur', { bubbles: true }));
                }

                // Kick citation validators (server check runs once on blur if value exists)
                if (citation) {
                    citation.dispatchEvent(new Event('input', { bubbles: true }));
                    citation.dispatchEvent(new Event('blur', { bubbles: true }));
                }

                // Show file validation message (will indicate reselect if empty)
                if (fileInput) {
                    fileInput.dispatchEvent(new Event('change', { bubbles: true }));
                }
            } catch (e) {
                console.warn('Initial validation trigger failed', e);
            }
        }, 50);
    }
}

// ─── Book ID Sanitization ─────────────────────────────────────────────
function sanitizeBookIdValue(value, full = false) {
    let v = value.toLowerCase();
    if (full) {
        // Full cleanup: spaces → underscores, strip everything else
        v = v.replace(/\s+/g, '_');
    }
    // Strip any character not in [a-z0-9_-]
    v = v.replace(/[^a-z0-9_-]/g, '');
    return v;
}

function setupBookIdSanitization() {
    const bookField = document.getElementById('book');
    if (!bookField) return;

    bookField.addEventListener('paste', () => {
        // Defer to allow paste content to land in the field
        setTimeout(() => {
            const cleaned = sanitizeBookIdValue(bookField.value, true);
            if (cleaned !== bookField.value) {
                bookField.value = cleaned;
                updateBookUrlPreview(cleaned);
                bookField.dispatchEvent(new Event('input', { bubbles: true }));
            }
        }, 0);
    });

    bookField.addEventListener('blur', () => {
        const cleaned = sanitizeBookIdValue(bookField.value, true);
        if (cleaned !== bookField.value) {
            bookField.value = cleaned;
            updateBookUrlPreview(cleaned);
            bookField.dispatchEvent(new Event('input', { bubbles: true }));
        }
    });

    // On input: only strip clearly invalid chars (not spaces) to avoid fighting mid-keystroke
    bookField.addEventListener('input', () => {
        const cleaned = sanitizeBookIdValue(bookField.value, false);
        if (cleaned !== bookField.value) {
            const pos = bookField.selectionStart - (bookField.value.length - cleaned.length);
            bookField.value = cleaned;
            bookField.setSelectionRange(pos, pos);
        }
    });
}

// Main initialization function
export function initializeCitationFormListeners() {
    // Set up radio button listeners
    document.querySelectorAll('input[name="type"]').forEach(radio => {
        radio.addEventListener('change', function() {
            showFieldsForType(this.value);
        });
    });

    // Set up BibTeX field listeners
    const bibtexField = document.getElementById('bibtex');
    if (bibtexField) {
        // Helper to kick validators after programmatic autofill
        const triggerAutoValidation = () => {
            const bookField = document.getElementById('book');
            const title = document.getElementById('title');
            if (bookField) bookField.dispatchEvent(new Event('input', { bubbles: true }));
            if (title) title.dispatchEvent(new Event('input', { bubbles: true }));
        };
        bibtexField.addEventListener('paste', function(e) {
            setTimeout(() => {
                const bibtexText = this.value;
                const typeMatch = bibtexText.match(/@(\w+)\s*\{/i);
                
                if (typeMatch) {
                    const bibType = typeMatch[1].toLowerCase();
                    const radio = document.querySelector(`input[name="type"][value="${bibType}"]`);
                    
                    if (radio) {
                        radio.checked = true;
                        showFieldsForType(bibType);
                    } else {
                        const miscRadio = document.querySelector('input[name="type"][value="misc"]');
                        if (miscRadio) {
                            miscRadio.checked = true;
                            showFieldsForType('misc');
                        }
                    }
                    
                    setTimeout(() => {
                        populateFieldsFromBibtex();
                        triggerAutoValidation();
                    }, 50);
                }
            }, 0);
        });

        bibtexField.addEventListener('input', function() {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = setTimeout(() => {
                const bibtexText = this.value;
                const typeMatch = bibtexText.match(/@(\w+)\s*\{/i);
                
                if (typeMatch) {
                    const bibType = typeMatch[1].toLowerCase();
                    const radio = document.querySelector(`input[name="type"][value="${bibType}"]`);
                    
                    if (radio) {
                        radio.checked = true;
                        showFieldsForType(bibType);
                        populateFieldsFromBibtex();
                        triggerAutoValidation();
                    }
                }
            }, 300);
        });
    }

    console.log("Citation form event listeners initialized");

    // ✅ CRITICAL FIX: Set up validation when form is dynamically created
    setupFormSubmission();
    setupClearButton();
    setupRealTimeValidation();
    setupFormPersistence();
    loadFormData();

    // ✅ NEW: Set up 3-mode interface
    setupModeSwitching();
    setupImportSearch();
    setupBookUrlPreview();
    setupBibtexModeAutoReveal();
    setupBookIdSanitization();
}

function setupFormSubmission() {
    console.log("🔥 DEBUG: setupFormSubmission called");
    const form = document.getElementById('cite-form');
    if (!form) {
        console.error("🔥 DEBUG: setupFormSubmission - form not found");
        return;
    }
    
    console.log("🔥 DEBUG: setupFormSubmission - form found:", form);
    
    // ✅ FIX: Check for existing handler more robustly
    if (form._hasSubmitHandler) {
        console.log("🔥 DEBUG: setupFormSubmission - handler already exists, skipping");
        return;
    }
    
    console.log("🔥 DEBUG: setupFormSubmission - adding new handler to form");
    form._hasSubmitHandler = true;
    
    const submitHandler = async function(event) {
        console.log("🔥 DEBUG: FORM SUBMIT TRIGGERED");
        event.preventDefault();
        event.stopPropagation();

        if (form._submitting) {
            console.log('⏳ Submit suppressed: already submitting');
            return false;
        }
        form._submitting = true;

        // Auth gate — unauthenticated users cannot import books
        const loggedIn = await isLoggedIn();
        if (!loggedIn) {
            const summary = document.getElementById('form-validation-summary');
            const list = document.getElementById('validation-list');
            if (summary && list) {
                list.innerHTML = `<li>You need to <a class="import-auth-link import-auth-login">log in</a> or <a class="import-auth-link import-auth-register">register</a> to import books.</li>`;
                summary.querySelector('h4').textContent = 'Authentication required';
                summary.style.display = 'block';

                summary.querySelector('.import-auth-login')?.addEventListener('click', async () => {
                    window.newBookManager?.closeContainer();
                    const { initializeUserContainer } = await import('../components/userContainer.js');
                    const mgr = initializeUserContainer();
                    if (mgr) mgr.showLoginForm();
                });
                summary.querySelector('.import-auth-register')?.addEventListener('click', async () => {
                    window.newBookManager?.closeContainer();
                    const { initializeUserContainer } = await import('../components/userContainer.js');
                    const mgr = initializeUserContainer();
                    if (mgr) mgr.showRegisterForm();
                });
            }
            form._submitting = false;
            return false;
        }

        // Force blur active element so any pending validation completes
        try { if (document.activeElement) document.activeElement.blur(); } catch(_) {}

        // Quick file validation
        if (!validateFileInput()) {
            console.log("File validation failed");
            return false;
        }

        // Title + Citation ID validation (block duplicates)
        const submitButton = this.querySelector('button[type="submit"]');
        const bookInput = this.querySelector('#book');
        const titleInput = this.querySelector('#title');
        const fileInput = this.querySelector('#markdown_file');

        const errors = [];

        // Title: default to "Untitled" if empty
        if (!titleInput || !titleInput.value || titleInput.value.trim().length === 0) {
            if (titleInput) titleInput.value = 'Untitled';
        }

        // Citation ID — auto-fix instead of blocking
        let idVal = bookInput?.value?.trim() || '';
        const randomSuffix = () => '_' + Math.random().toString(36).slice(2, 8);

        if (!idVal) {
            idVal = 'book_' + Date.now();
        } else {
            // Strip invalid characters
            idVal = idVal.replace(/[^a-zA-Z0-9_-]/g, '');
            if (!idVal) idVal = 'book_' + Date.now();
        }
        // Ensure minimum length
        if (idVal.length < 3) idVal += randomSuffix();

        if (idVal !== allowedResubmitBookId) {
            // Server availability check — append suffix if taken
            try {
                const resp = await fetch('/api/validate-book-id', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-CSRF-TOKEN': document.querySelector('meta[name="csrf-token"]')?.content
                    },
                    body: JSON.stringify({ book: idVal })
                });
                const data = await resp.json();
                if (data.success && data.exists) {
                    idVal += randomSuffix();
                }
            } catch (e) {
                console.warn('Book ID check failed, proceeding with current value', e);
            }
        }

        // Update the input and preview with the final value
        if (bookInput) bookInput.value = idVal;
        updateBookUrlPreview(idVal);
        const bookValidationEl = document.getElementById('book-validation');
        if (bookValidationEl) { bookValidationEl.textContent = ''; bookValidationEl.className = 'validation-message'; }

        // Update summary
        const summary = document.getElementById('form-validation-summary');
        const list = document.getElementById('validation-list');
        if (summary && list) {
            if (errors.length > 0) {
                list.innerHTML = errors.map(e => `<li>${escapeHtml(e.field)}: ${escapeHtml(e.message)}</li>`).join('');
                summary.style.display = 'block';
            } else {
                summary.style.display = 'none';
            }
        }

        if (errors.length > 0) {
            // Do not proceed
            if (submitButton) {
                submitButton.disabled = false;
                submitButton.textContent = 'Create Book';
            }
            return false;
        }

        // Passed validations — disable to avoid double submission
        if (submitButton) {
            submitButton.disabled = true;
            submitButton.textContent = 'Processing...';
        }

        try {
            // Manual FormData construction for robustness
            const form = this;
            const formData = new FormData();
            
            // Append all other form fields
            new FormData(form).forEach((value, key) => {
                if (key !== 'markdown_file' && key !== 'markdown_file[]') {
                    formData.append(key, value);
                }
            });

            // Explicitly append the file(s)
            const fileInput = form.querySelector('#markdown_file');
            if (fileInput && fileInput.files.length > 0) {
                // Handle multiple files (folder upload) or single file
                for (let i = 0; i < fileInput.files.length; i++) {
                    formData.append('markdown_file[]', fileInput.files[i]);
                }
            }

            await submitToLaravelAndLoad(formData, submitButton);
        } finally {
            // If navigation did not occur, allow another try
            form._submitting = false;
        }
    };
    
    form.addEventListener('submit', submitHandler);
    // Store handler reference for potential cleanup
    form._submitHandler = submitHandler;
    
    // ✅ DEBUG: Test if the submit button is working + Safari single-tap submit shim
    const submitButton = form.querySelector('button[type="submit"]');
    if (submitButton) {
        console.log("🔥 DEBUG: Found submit button:", submitButton);

        const ensureSubmit = (e) => {
            // Mark that shim handled this tap to suppress the next click
            form._shimSubmitted = true;
            setTimeout(() => { form._shimSubmitted = false; }, 600);

            // Prevent the following synthetic click; we will submit programmatically
            e.preventDefault();
            e.stopPropagation();
            try {
                if (document.activeElement && document.activeElement !== submitButton) {
                    document.activeElement.blur();
                }
            } catch (_) {}
            // Defer slightly to allow blur handlers/validation to settle
            setTimeout(() => {
                // Guard: if form already disabled button (in-flight), skip
                if (submitButton.disabled) return;
                // Programmatic submit triggers our submit handler
                if (typeof form.requestSubmit === 'function') {
                    form.requestSubmit(submitButton);
                } else {
                    form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
                }
            }, 0);
        };

        // Use pointerup/touchend to capture the first tap on Safari and avoid double-tap
        try {
            submitButton.addEventListener('pointerup', ensureSubmit, { passive: false });
            submitButton.addEventListener('touchend', ensureSubmit, { passive: false });
        } catch (_) {
            submitButton.addEventListener('touchend', ensureSubmit);
        }

        // Suppress immediate native click after shim to avoid double submission in Chrome
        submitButton.addEventListener('click', function(e) {
            if (form._shimSubmitted) {
                e.preventDefault();
                e.stopPropagation();
                return false;
            }
            console.log("🔥 DEBUG: Submit button clicked!", e);
        });
    } else {
        console.error("🔥 DEBUG: Submit button not found!");
    }
}

async function saveToIndexedDBThenSync(libraryRecord, originalFormData, submitButton) {
    console.log("Opening IndexedDB using openDatabase function...");
    
    try {
        // Get creator ID before saving
        const creatorId = await getCreatorId();
        console.log("Creating citation with creator:", creatorId);
        
        // Add creator to the library record
        libraryRecord.creator = creatorId;
        
        // Use your existing openDatabase function
        const db = await openDatabase();
        console.log("IndexedDB opened successfully");
        
        // Check if the library object store exists
        if (!db.objectStoreNames.contains("library")) {
            console.error("Library object store does not exist");
            alert("Database structure error. Please refresh the page.");
            resetSubmitButton(submitButton);
            return;
        }
        
        const tx = db.transaction("library", "readwrite");
        const store = tx.objectStore("library");
        
        console.log("Saving record to IndexedDB:", libraryRecord);
        const saveRequest = store.put(libraryRecord);
        
        saveRequest.onsuccess = function(event) {
            console.log("Record saved successfully to IndexedDB");
        };
        
        saveRequest.onerror = function(event) {
            console.error("Error saving to IndexedDB:", event.target.error);
            alert("Error saving locally: " + event.target.error);
            resetSubmitButton(submitButton);
        };
        
        tx.oncomplete = function() {
            console.log("IndexedDB transaction completed successfully");
            
            // Step 3: Sync to PostgreSQL
            syncToPostgreSQL(libraryRecord)
                .then(() => {
                    console.log("Synced to PostgreSQL successfully");
                    
                    // Step 4: Submit to Laravel for file processing
                    submitToLaravel(originalFormData, submitButton);
                })
                .catch(error => {
                    console.error("PostgreSQL sync failed:", error);
                    // Continue with Laravel submission even if sync fails
                    submitToLaravel(originalFormData, submitButton);
                });
        };
        
        tx.onerror = function(event) {
            console.error("IndexedDB transaction error:", event.target.error);
            alert("Transaction error: " + event.target.error);
            resetSubmitButton(submitButton);
        };
        
        tx.onabort = function(event) {
            console.error("IndexedDB transaction aborted:", event.target.error);
            alert("Transaction aborted: " + event.target.error);
            resetSubmitButton(submitButton);
        };
        
    } catch (error) {
        console.error("Failed to open IndexedDB:", error);
        alert("Local storage error: " + error);
        resetSubmitButton(submitButton);
    }
}

// Placeholder for your PostgreSQL sync function
async function syncToPostgreSQL(libraryRecord) {
    console.log("Syncing to PostgreSQL:", libraryRecord);
    
    // TODO: Replace with your actual sync function
    // For now, just return a resolved promise
    return Promise.resolve();
}

async function submitToLaravelAndLoad(formData, submitButton) {
  console.log("🔥 DEBUG: submitToLaravelAndLoad STARTED");
  console.log("Submitting to Laravel controller for file processing...");

  try {
    // Use the new ImportBookTransition pathway
    const { ImportBookTransition } = await import('../navigation/pathways/ImportBookTransition.js');
    
    const result = await ImportBookTransition.handleFormSubmissionAndTransition(formData, submitButton);
    if (!result) {
      // User chose re-submit from footnote audit — form already reset by ImportBookTransition.
      // Store the book ID so validators skip the "already taken" check on re-submit.
      const bookInput = document.getElementById('book');
      allowedResubmitBookId = bookInput?.value?.trim() || null;
      return;
    }
    console.log(`🔥 DEBUG: ImportBookTransition completed for ${result.bookId}`);
    
  } catch (error) {
    console.error("❌ Import failed:", error);

    // Insufficient balance — show inline banner instead of alert
    if (error.status === 402) {
      showInsufficientBalanceBanner();
    } else {
      let userMessage = "Import failed: " + error.message;

      if (error.isProcessingError) {
        userMessage = "Document processing failed. This is likely a backend issue.\n\n" +
                     "Please check:\n" +
                     "• Document format and complexity\n" +
                     "• Backend processing logs\n" +
                     "• Try with a simpler test document\n\n" +
                     "Technical details:\n" + error.message;
      }

      alert(userMessage);
    }

    // Re-enable the button only on failure, since on success we navigate away.
    if (submitButton) {
      submitButton.disabled = false;
      submitButton.textContent = "Submit";
    }
  }
}

// Clear button handler
function setupClearButton() {
    const clearButton = document.getElementById('clearButton');
    if (clearButton) {
        clearButton.addEventListener('click', function(e) {
            e.preventDefault();
            const form = document.getElementById('cite-form');
            if (!form) return;

            // Reset inputs
            form.reset();

            // Hide PDF cost estimate and balance banner
            hidePdfCostEstimate();
            hideInsufficientBalanceBanner();

            // Hide optional fields (labels and inputs)
            document.querySelectorAll('.optional-field').forEach(field => {
                field.style.display = 'none';
            });

            // Clear validation messages (remove inline display so CSS classes can show later)
            document.querySelectorAll('.validation-message').forEach(msg => {
                msg.textContent = '';
                msg.innerHTML = '';
                msg.className = 'validation-message';
                msg.style.removeProperty('display');
            });
            const summary = document.getElementById('form-validation-summary');
            const list = document.getElementById('validation-list');
            if (summary) summary.style.display = 'none';
            if (list) list.innerHTML = '';

            // Re-enable submit button
            const submitButton = document.getElementById('createButton');
            if (submitButton) {
                submitButton.disabled = false;
                submitButton.textContent = 'Create Book';
            }

            // Clear any persisted form data (both keys used across modules)
            localStorage.removeItem('formData');
            localStorage.removeItem('newbook-form-data');

            // Reset re-submit bypass so normal validation applies again
            allowedResubmitBookId = null;

            // Reset back to search mode
            const searchRadio = document.querySelector('input[name="import_mode"][value="search"]');
            if (searchRadio) {
                searchRadio.checked = true;
                switchImportMode('search');
            }

            // Reset URL preview
            updateBookUrlPreview('');
        }, { passive: false });
    }
}

// Form persistence setup
function setupFormPersistence() {
    const form = document.getElementById('cite-form');
    if (form) {
        form.addEventListener('input', saveFormData);
    }
}

// Enhanced real-time validation
function setupRealTimeValidation() {
    // Validation functions
    const validators = {
        validateBookId: async (value) => {
            if (!value) return { valid: true, message: 'Custom url key recommended' };
            if (!/^[a-zA-Z0-9_-]+$/.test(value)) return { valid: false, message: 'Only letters, numbers, underscores, and hyphens allowed' };
            if (value.length < 3) return { valid: false, message: 'Book ID must be at least 3 characters' };

            // Re-submitting to same book ID after footnote audit — skip server check
            if (value === allowedResubmitBookId) {
                return { valid: true, message: 'Re-submitting to same book ID' };
            }

            // Check database for existing book ID
            try {
                const response = await fetch('/api/validate-book-id', {
                    method: 'POST',
                    credentials: 'same-origin',
                    headers: {
                        'Accept': 'application/json',
                        'Content-Type': 'application/json',
                        'X-CSRF-TOKEN': document.querySelector('meta[name="csrf-token"]')?.content
                    },
                    body: JSON.stringify({ book: value })
                });
                
                let data;
                try {
                    data = await response.json();
                } catch (parseErr) {
                    console.warn('Citation ID check: non-JSON response', parseErr);
                    // Non-blocking: do not show an error state here; enforce on submit
                    return { valid: true, message: '' };
                }
                
                if (!data.success) {
                    // Non-blocking warning; treat as neutral so UI isn't alarming
                    return { valid: true, message: '' };
                }
                
                if (data.exists) {
                    const linkHtml = `<a href="${data.book_url}" target="_blank" style="color: #EF8D34; text-decoration: underline;">View existing book</a>`;
                    return { 
                        valid: false, 
                        message: `Citation ID "${value}" is already taken by "${data.book_title}". ${linkHtml}`,
                        isHtml: true
                    };
                }
                
                return { valid: true, message: 'Citation ID is available' };
                
            } catch (error) {
                console.warn('Citation ID validation error (non-blocking):', error);
                // Non-blocking: avoid showing an error; submit-time check will catch duplicates
                return { valid: true, message: '' };
            }
        },
        
        validateTitle: (value) => {
            if (value && value.length > 255) return { valid: false, message: 'Title must be less than 255 characters' };
            return { valid: true, message: '' };
        },
        
        validateFile: (fileInput) => {
            if (!fileInput.files || fileInput.files.length === 0) {
                return { valid: false, message: 'Please select a file to upload' };
            }

            const file = fileInput.files[0];
            const validExtensions = ['.md', '.epub', '.doc', '.docx', '.html', '.pdf'];
            const fileName = file.name.toLowerCase();
            const isValidType = validExtensions.some(ext => fileName.endsWith(ext));

            if (!isValidType) {
                const extList = validExtensions.join(', ');
                return { valid: false, message: `Please select a valid file (${extList})` };
            }
            
            if (file.size > 50 * 1024 * 1024) { // 50MB
                return { valid: false, message: 'File size must be less than 50MB' };
            }
            
            return { valid: true, message: 'Valid file selected' };
        },
        
        validateYear: (value) => {
            if (!value) return { valid: true, message: '' }; // Optional field
            const year = parseInt(value);
            const currentYear = new Date().getFullYear();
            if (year < 1000 || year > currentYear + 10) {
                return { valid: false, message: `Year must be between 1000 and ${currentYear + 10}` };
            }
            return { valid: true, message: 'Valid year' };
        },

        validateUrl: (value) => {
            if (!value) return { valid: true, message: '' }; // Optional field
            
            // Auto-format URL if it doesn't have a protocol
            let formattedUrl = value.trim();
            if (formattedUrl && !formattedUrl.match(/^https?:\/\//i)) {
                formattedUrl = `https://${formattedUrl}`;
            }
            
            try {
                new URL(formattedUrl);
                return { valid: true, message: 'Valid URL', formattedValue: formattedUrl };
            } catch (e) {
                return { valid: false, message: 'Please enter a valid URL (e.g., example.com or https://example.com)' };
            }
        }
    };
    
    // Show validation message
    const showValidationMessage = (elementId, result) => {
        const msgElement = document.getElementById(`${elementId}-validation`);
        if (msgElement) {
            if (result.isHtml) {
                msgElement.innerHTML = result.message;
                // Prevent validation message links from closing the form
                const links = msgElement.querySelectorAll('a');
                links.forEach(link => {
                    link.addEventListener('click', (e) => {
                        e.stopPropagation(); // Prevent event bubbling to overlay
                        
                        // Mark that we clicked an external link (for mobile handling)
                        if (window.newBookManager) {
                            window.newBookManager.recentExternalLinkClick = true;
                            console.log('🔥 MOBILE: External link clicked - flagged to preserve form state');
                        }
                    });
                });
            } else {
                msgElement.textContent = result.message;
            }
            msgElement.className = `validation-message ${result.valid ? 'success' : 'error'}`;
        }
    };
    
    // Validate form and update messages (do not disable the submit button pre-emptively)
    const validateForm = async () => {
        const bookField = document.getElementById('book');
        const title = document.getElementById('title');
        const fileInput = document.getElementById('markdown_file');
        const submitButton = document.getElementById('createButton');

        if (!bookField || !title || !fileInput || !submitButton) return;
        
        // Do not disable the button here to avoid Safari double-tap issues
        // Avoid hitting the server here; handle citation ID via its own listeners
        const titleResult = validators.validateTitle(title.value);
        const fileResult = validators.validateFile(fileInput);
        
        const isFormValid = titleResult.valid && fileResult.valid;
        // Show individual field messages
        showValidationMessage('title', titleResult);
        showValidationMessage('file', fileResult);
        // Keep the submit button enabled; the submit handler will guard and show errors if needed
        submitButton.textContent = 'Create Book';
        
        // Update validation summary
        updateValidationSummary([
            { field: 'Title', result: titleResult }
        ]);

        return isFormValid;
    };
    
    // Update validation summary
    const updateValidationSummary = (validations) => {
        const summary = document.getElementById('form-validation-summary');
        const list = document.getElementById('validation-list');
        
        if (!summary || !list) return;
        
        const errors = validations.filter(v => !v.result.valid && v.result.message);
        
        if (errors.length > 0) {
            list.innerHTML = errors.map(e => `<li>${escapeHtml(e.field)}: ${escapeHtml(e.result.message)}</li>`).join('');
            summary.style.display = 'block';
        } else {
            summary.style.display = 'none';
        }
    };
    
    // Set up individual field validators
    const bookField = document.getElementById('book');
    if (bookField) {
        let validationTimeout;

        bookField.addEventListener('input', function() {
            clearTimeout(validationTimeout);
            // Debounce the database check to avoid too many requests
            validationTimeout = setTimeout(async () => {
                const result = await validators.validateBookId(this.value);
                showValidationMessage('book', result);
                // Also refresh summary with current local field states
                const titleResult = validators.validateTitle(document.getElementById('title')?.value || '');
                updateValidationSummary([
                    { field: 'Book ID', result },
                    { field: 'Title', result: titleResult }
                ]);
            }, 500);
        });

        bookField.addEventListener('blur', async function() {
            clearTimeout(validationTimeout);
            const result = await validators.validateBookId(this.value);
            showValidationMessage('book', result);
            const titleResult = validators.validateTitle(document.getElementById('title')?.value || '');
            updateValidationSummary([
                { field: 'Citation ID', result },
                { field: 'Title', result: titleResult }
            ]);
        });
    }
    
    const titleField = document.getElementById('title');
    if (titleField) {
        titleField.addEventListener('input', function() {
            const result = validators.validateTitle(this.value);
            showValidationMessage('title', result);
            setTimeout(validateForm, 100);
        });
        titleField.addEventListener('blur', function() {
            const result = validators.validateTitle(this.value);
            showValidationMessage('title', result);
            validateForm();
        });
    }
    
    const fileField = document.getElementById('markdown_file');
    if (fileField) {
        fileField.addEventListener('change', function() {
            hideInsufficientBalanceBanner();
            const result = validators.validateFile(this);
            // Pass field base id 'file' so showValidationMessage targets #file-validation
            showValidationMessage('file', result);
            validateForm();
            handleFileMetadataExtraction(this);
        });
    }
    
    const yearField = document.getElementById('year');
    if (yearField) {
        yearField.addEventListener('input', function() {
            const result = validators.validateYear(this.value);
            if (result.message) {
                // Only show year validation if there's an actual message (error or success)
                const msgElement = document.querySelector('#year').parentNode.querySelector('.validation-message');
                if (!msgElement) {
                    const newMsgElement = document.createElement('div');
                    newMsgElement.className = `validation-message ${result.valid ? 'success' : 'error'}`;
                    newMsgElement.textContent = result.message;
                    yearField.parentNode.appendChild(newMsgElement);
                } else {
                    msgElement.className = `validation-message ${result.valid ? 'success' : 'error'}`;
                    msgElement.textContent = result.message;
                }
            }
        });
    }

    const urlField = document.getElementById('url');
    if (urlField) {
        urlField.addEventListener('blur', function() {
            const result = validators.validateUrl(this.value);
            
            // Auto-format the URL in the input field if validation succeeded
            if (result.valid && result.formattedValue && result.formattedValue !== this.value) {
                this.value = result.formattedValue;
            }
            
            if (result.message) {
                // Only show URL validation if there's an actual message (error or success)
                const msgElement = document.querySelector('#url').parentNode.querySelector('.validation-message');
                if (!msgElement) {
                    const newMsgElement = document.createElement('div');
                    newMsgElement.className = `validation-message ${result.valid ? 'success' : 'error'}`;
                    newMsgElement.textContent = result.message;
                    urlField.parentNode.appendChild(newMsgElement);
                } else {
                    msgElement.className = `validation-message ${result.valid ? 'success' : 'error'}`;
                    msgElement.textContent = result.message;
                }
            }
        });
        
        urlField.addEventListener('input', function() {
            const result = validators.validateUrl(this.value);
            if (result.message) {
                // Show validation during typing (but don't auto-format until blur)
                const msgElement = document.querySelector('#url').parentNode.querySelector('.validation-message');
                if (!msgElement) {
                    const newMsgElement = document.createElement('div');
                    newMsgElement.className = `validation-message ${result.valid ? 'success' : 'error'}`;
                    newMsgElement.textContent = result.message;
                    urlField.parentNode.appendChild(newMsgElement);
                } else {
                    msgElement.className = `validation-message ${result.valid ? 'success' : 'error'}`;
                    msgElement.textContent = result.message;
                }
            }
        });
    }
    
    // Initial validation
    setTimeout(validateForm, 500);
}

// Display saved citations
async function displaySavedCitations() {
    try {
        const db = await openDatabase();
        const tx = db.transaction("library", "readonly");
        const store = tx.objectStore("library");
        const citations = await store.getAll();
        console.log("Saved citations:", citations);
    } catch (error) {
        console.error("Error retrieving citations:", error);
    }
}

// Initialize everything when DOM is loaded
document.addEventListener('DOMContentLoaded', function() {
    initializeCitationFormListeners();
    setupFormSubmission();
    setupClearButton();
    setupFormPersistence();
    setupRealTimeValidation();
    loadFormData();
    
    setTimeout(displaySavedCitations, 1000);
});



// Keep setupFormSubmissionHandler as alias for backward compatibility
export function setupFormSubmissionHandler() {
    setupFormSubmission();
}
