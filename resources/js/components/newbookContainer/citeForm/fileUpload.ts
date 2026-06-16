// File-upload concerns for the cite-form: the inline dropzone, single/folder
// file validation, non-PDF metadata extraction (auto-fill), and the PDF page
// count + cost estimate (Mistral OCR pricing by billing tier) + the
// insufficient-balance banner. Was the PDF-cost / file-metadata / dropzone /
// validateFileInput functions of newBookForm.js.
import { $ } from './dom';
import { generateBookIdFromMetadata, findAvailableBookId, updateBookUrlPreview } from './bookId';
import { getCurrentUserInfo } from '../../../utilities/auth/index';
import { showImportFailureModal } from '../../../conversion/bugReportModal.js';
import { attachFilesToInput } from '../../utilities/fileImportHelpers';

// ─── PDF Cost Estimate ───────────────────────────────────────────────
const MISTRAL_OCR_COST_PER_1K_PAGES = 1.00;

const BILLING_TIERS: any = {
  premium:    { multiplier: 1.0, label: 'Premium' },
  budget:     { multiplier: 1.5, label: 'Budget' },
  solidarity: { multiplier: 2.0, label: 'Solidarity' },
  capitalist: { multiplier: 5.0, label: 'Honest Capitalist' },
};

function getUserTier() {
  const status = getCurrentUserInfo()?.status;
  return BILLING_TIERS[status] || BILLING_TIERS.budget;
}

let _pdfjsPromise: any = null;
function loadPdfJs() {
  if (!_pdfjsPromise) {
    _pdfjsPromise = import('https://cdn.jsdelivr.net/npm/pdfjs-dist@4.9.155/+esm')
      .then((mod: any) => {
        const pdfjsLib = mod;
        pdfjsLib.GlobalWorkerOptions.workerSrc =
          'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.9.155/build/pdf.worker.min.mjs';
        return pdfjsLib;
      })
      .catch((err: any) => {
        _pdfjsPromise = null; // allow retry on next call
        throw err;
      });
  }
  return _pdfjsPromise;
}

async function showPdfCostEstimate(file: any) {
  const el = $('pdf-cost-estimate');
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
    const setIfEmpty = (id: string, val: any) => {
      const elx = $(id);
      if (elx && !elx.value.trim() && val) {
        elx.value = val;
        elx.dispatchEvent(new Event('input', { bubbles: true }));
      }
    };
    setIfEmpty('title', pdfTitle);
    setIfEmpty('author', pdfAuthor);
    setIfEmpty('year', pdfYear);

    // Auto-generate book ID if empty
    const bookField = $('book');
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
      .map(([key, t]: [any, any]) => {
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

export function hidePdfCostEstimate() {
  const el = $('pdf-cost-estimate');
  if (el) {
    el.style.display = 'none';
    el.textContent = '';
  }
}

export function showInsufficientBalanceBanner(errorContext: any = null) {
  // Remove any existing banner
  $('insufficient-balance-banner')?.remove();

  const banner = document.createElement('div');
  banner.id = 'insufficient-balance-banner';
  banner.style.cssText = 'display:block; color:#d63384; font-size:13px; margin-top:8px; padding:10px 12px; border-radius:4px; background:rgba(214,51,132,0.08); border:1px solid rgba(214,51,132,0.3);';
  banner.innerHTML =
    '<strong>Insufficient balance.</strong> PDF import is billed per page. Please top up your credits to continue.' +
    '<br><a href="#" onclick="event.preventDefault(); fetch(\'/api/billing/checkout\', { method: \'POST\', headers: { \'Content-Type\': \'application/json\', \'Accept\': \'application/json\', \'X-XSRF-TOKEN\': decodeURIComponent(document.cookie.match(/XSRF-TOKEN=([^;]+)/)?.[1] || \'\') }, credentials: \'include\', body: JSON.stringify({ amount: 5, return_url: window.location.href }) }).then(r => r.json()).then(d => { if (d.checkout_url) window.location.href = d.checkout_url; })" style="display:inline-block; margin-top:8px; padding:6px 14px; background:#d63384; color:#fff; border-radius:4px; text-decoration:none; font-size:13px; font-weight:500;">Top Up Balance</a>';

  if (errorContext) {
    const reportLine = document.createElement('div');
    reportLine.style.cssText = 'margin-top:8px; font-size:12px; color:#a3506e;';
    const reportLink = document.createElement('a');
    reportLink.href = '#';
    reportLink.textContent = 'Something else wrong? Report it';
    reportLink.style.cssText = 'color:#d63384; text-decoration:underline; cursor:pointer;';
    reportLink.addEventListener('click', (e) => {
      e.preventDefault();
      showImportFailureModal(errorContext);
    });
    reportLine.appendChild(reportLink);
    banner.appendChild(reportLine);
  }

  // Insert after the pdf-cost-estimate div, or after the file validation div
  const anchor = $('pdf-cost-estimate') || $('file-validation');
  if (anchor && anchor.parentNode) {
    anchor.parentNode.insertBefore(banner, anchor.nextSibling);
  }
}

export function hideInsufficientBalanceBanner() {
  $('insufficient-balance-banner')?.remove();
}

export function handlePdfCostEstimate(fileInput: any) {
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

export async function handleFileMetadataExtraction(fileInput: any) {
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
    const { extractFileMetadata } = await import('../../utilities/fileMetadataExtractor');
    const meta = await extractFileMetadata(file);

    const setIfEmpty = (id: string, val: any) => {
      const el = $(id);
      if (el && !el.value.trim() && val) {
        el.value = val;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
    };
    setIfEmpty('title', meta.title);
    setIfEmpty('author', meta.author);
    setIfEmpty('year', meta.year);

    // Auto-generate book ID if empty
    const bookField = $('book');
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

export function validateFileInput(): boolean {
  const fileInput = $('markdown_file');

  let errorMsg = $('file-error-message');
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

  if (file.size > 250 * 1024 * 1024) {
    const mb = (file.size / (1024 * 1024)).toFixed(1);
    errorMsg.textContent = `File is too large (${mb} MB). Maximum size is 250 MB.`;
    errorMsg.style.display = 'block';
    return false;
  }

  errorMsg.style.display = 'none';
  return true;
}

export function setupInlineDropzone() {
  const dz = $('markdown-file-dropzone');
  const fileInput = $('markdown_file');
  if (!dz || !fileInput) return;

  const iconEl = dz.querySelector('.markdown-file-dropzone-icon');
  const textEl = dz.querySelector('.markdown-file-dropzone-text');
  const COLORS = {
    idle: 'rgba(136,136,136,0.4)',
    hover: '#EF8D34',     // accent orange (used for active drag-over)
    ready: '#2ecc71',     // green for "file ready" baseline
  };

  // Visual baseline reflects whether a file is currently attached.
  // Drag-over state (orange) takes precedence while a drag is happening.
  const refreshBaseline = () => {
    const hasFile = fileInput.files && fileInput.files.length > 0;
    dz.style.backgroundColor = '';
    if (hasFile) {
      dz.style.borderColor = COLORS.ready;
      if (iconEl) {
        iconEl.textContent = '✓';
        iconEl.style.color = COLORS.ready;
      }
      if (textEl) {
        const name = fileInput.files[0].name;
        textEl.style.color = COLORS.ready;
        textEl.innerHTML =
          `<strong>File ready:</strong> ${escapeHtmlLocal(name)} ` +
          `<span style="opacity:0.75;">— drop another to swap</span>`;
      }
    } else {
      dz.style.borderColor = COLORS.idle;
      if (iconEl) {
        iconEl.textContent = '⤓';
        iconEl.style.color = '#888';
      }
      if (textEl) {
        textEl.style.color = '#888';
        textEl.innerHTML = '<strong>Drop a file here</strong> or use the button above';
      }
    }
  };

  // Active-drag highlight: orange tint over whatever the baseline is.
  const setDragActive = (on: boolean) => {
    if (on) {
      dz.style.borderColor = COLORS.hover;
      dz.style.backgroundColor = 'rgba(239,141,52,0.06)';
    } else {
      // Clear the drag tint and re-derive from current state.
      refreshBaseline();
    }
  };

  dz.addEventListener('click', () => fileInput.click());
  dz.addEventListener('keydown', (e: any) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fileInput.click();
    }
  });

  ['dragenter', 'dragover'].forEach((ev) => {
    dz.addEventListener(ev, (e: any) => {
      e.preventDefault();
      // Stop the page-level overlay from also triggering for drops landing
      // on the inline dropzone — the inline drop is more specific.
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      setDragActive(true);
    });
  });

  ['dragleave', 'drop'].forEach((ev) => {
    dz.addEventListener(ev, () => setDragActive(false));
  });

  dz.addEventListener('drop', (e: any) => {
    e.preventDefault();
    e.stopPropagation();
    const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
    if (!files.length) return;
    attachFilesToInput(fileInput, files);
    // attachFilesToInput dispatches `change`, which triggers refreshBaseline.
  });

  // Keep the dropzone in sync when the file changes (drop, native picker,
  // programmatic) and when the form is reset (Clear button calls form.reset()).
  fileInput.addEventListener('change', refreshBaseline);
  const form = $('cite-form');
  if (form) form.addEventListener('reset', () => {
    // form.reset() runs after the listener — defer one tick so files is empty.
    setTimeout(refreshBaseline, 0);
  });

  // Initial paint reflects any pre-restored state (rare for files, but safe).
  refreshBaseline();
}

// Local escape (the dropzone "file ready" label). Mirrors paste/utils escapeHtml
// but kept inline to avoid pulling the normalizer into this module.
function escapeHtmlLocal(s: string): string {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}
