// Renders the archive panel's inner HTML from the server's panel JSON: the
// whole-archive citation (formatted through the same bibtex pipeline as the
// per-book source panel, for typographic parity) + counts + the two export
// download buttons that exportDownload.ts drives.

import { formatBibtexToCitation } from '../../utilities/bibtexProcessor';

export interface ArchivePanelData {
  displayName: string;
  /** 'library' (user pages) or 'archive' (journal/scrape corpora). */
  noun: string;
  pageUrl: string;
  bibtex: string;
  /** Book-panel-parity attribution: who keeps this collection. */
  librarian: { label: string; name: string; url: string | null };
  audience: 'public' | 'owner';
  /** The PUBLIC shelf behind a journal/archive corpus (what Like likes); null for a user library. */
  shelfId?: string | null;
  /** The viewer keeps this collection (library owner / the shelf's creator): show the plus. */
  canAdd?: boolean;
  /** The shelf a book made from the plus joins; null for a user library. */
  addShelfId?: string | null;
  /** The viewer owns the shelf behind this archive: the URL of its hypercite workbench. */
  curateUrl?: string | null;
  counts: {
    public_books: number;
    export_books: number;
    e2ee_skipped: number;
  };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function countsLine(data: ArchivePanelData): string {
  const { counts, audience } = data;
  const parts: string[] = [];
  parts.push(`${counts.public_books} public text${counts.public_books === 1 ? '' : 's'}`);
  if (audience === 'owner') {
    parts.push(`${counts.export_books} in your export (private included)`);
  }
  if (counts.e2ee_skipped > 0) {
    parts.push(`${counts.e2ee_skipped} encrypted (not exportable server-side)`);
  }

  return parts.join(' · ');
}

function librarianSection(data: ArchivePanelData): string {
  const { label, name, url } = data.librarian ?? { label: 'Kept by', name: '', url: null };
  if (!name) return '';
  const who = url
    ? `<a href="${escapeHtml(url)}" style="color: var(--hyperlit-aqua); text-decoration: underline;">${escapeHtml(name)}</a>`
    : escapeHtml(name);

  return `
      <div class="archive-librarian" style="margin-top: 15px;">
        <h3>Librarian</h3>
        <p style="font-size: var(--sc-12); color: var(--color-text-secondary); margin: 0;">${escapeHtml(label)} ${who}</p>
      </div>`;
}

/**
 * The book panel's action bar (buildSourceHtml's #source-action-bar) for a
 * whole corpus: Like (only when the corpus is a shelf — journals and archives)
 * and the Share popover (Link / Citation). Same ids/classes on purpose — the
 * bar's CSS (sourceContainer.css) and the share wiring (readerActions'
 * wireShareControl) are shared; lookups are container-scoped.
 */
function actionBar(data: ArchivePanelData): string {
  const what = escapeHtml(data.noun || 'archive');
  const like = data.shelfId ? `
        <button type="button" id="like-book" aria-pressed="false" aria-label="Like this ${what}" title="Like">
          <svg viewBox="0 0 24 24" fill="none" stroke="var(--icon-stroke-primary)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="pointer-events: none;">
            <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"></path>
          </svg>
        </button>` : '';
  const check = '<span class="share-option-check"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg></span>';

  return `
    <div id="source-action-bar">
      <div class="source-action-group">${like}
        <div id="share-control" class="share-control">
          <button type="button" id="share-book" aria-haspopup="true" aria-expanded="false" aria-label="Share this ${what}" title="Share">
            <svg viewBox="0 0 24 24" fill="none" stroke="var(--icon-stroke-primary)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="pointer-events: none;">
              <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"></path>
              <polyline points="16 6 12 2 8 6"></polyline>
              <line x1="12" y1="2" x2="12" y2="15"></line>
            </svg>
          </button>
          <div class="share-panel" style="display: none;">
            <button type="button" class="share-option" data-share="link">
              <span class="share-option-icon">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path>
                  <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>
                </svg>
              </span>
              <span class="share-option-label">Link</span>
              ${check}
            </button>
            <button type="button" class="share-option" data-share="citation">
              <span class="share-option-icon">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M6 17h3l2-4V7H5v6h3z"></path>
                  <path d="M15 17h3l2-4V7h-6v6h3z"></path>
                </svg>
              </span>
              <span class="share-option-label">Citation</span>
              ${check}
            </button>
          </div>
        </div>
      </div>
      <div class="source-action-group">${data.canAdd ? `
        <div id="add-control" class="share-control add-control">
          <button type="button" id="archive-add-book" aria-haspopup="true" aria-expanded="false" aria-label="Add a new book to this ${what}" title="New book">
            <svg viewBox="0 0 24 24" fill="none" stroke="var(--icon-stroke-primary)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="pointer-events: none;">
              <path d="M12 5v14M5 12h14"></path>
            </svg>
          </button>
          <div class="share-panel" style="display: none;">
            <button type="button" class="share-option" data-add="blank">
              <span class="share-option-icon">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                  <polyline points="14 2 14 8 20 8"></polyline>
                </svg>
              </span>
              <span class="share-option-label">Blank</span>
            </button>
            <button type="button" class="share-option" data-add="import">
              <span class="share-option-icon">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                  <polyline points="7 10 12 15 17 10"></polyline>
                  <line x1="12" y1="15" x2="12" y2="3"></line>
                </svg>
              </span>
              <span class="share-option-label">Import</span>
            </button>
          </div>
        </div>` : ''}</div>
    </div>`;
}

/**
 * Creator Tools — the same collapsible section (same ids, same toggle style) the
 * book panel carries, for whoever keeps the shelf behind this archive. Rendered
 * only when the server grants `curateUrl` (ShelfWorkbenchAccess). One tool today:
 * the hypercite workbench. A standalone page, so the row opens it in a new tab.
 */
function creatorToolsSection(data: ArchivePanelData): string {
  if (!data.curateUrl) return '';

  return `
      <div id="creator-tools-section" style="margin-top: 15px; padding-top: 15px;">
        <button type="button" id="creator-tools-toggle" aria-expanded="false" aria-controls="creator-tools-content">
          <span>Creator Tools</span>
          <svg class="creator-tools-chevron" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="6 9 12 15 18 9"></polyline>
          </svg>
        </button>
        <div id="creator-tools-content" style="display: none;">
          <button type="button" id="archive-hypercite-workbench" class="download-btn archive-export-btn" data-href="${escapeHtml(data.curateUrl)}">
            <div class="icon-wrapper">
              <svg class="download-icon" viewBox="0 0 122.88 122.44" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                <path fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" d="M50.14,42.06l39.38,37.6C107.96,56.04,88.92,15.88,61.27,0c41.32,9.42,65.89,58.63,42.23,92.52l17.75,16.87 c5.75,6.5-5.04,17.12-12.41,11.44l-16.7-18.12c-22.17,10-41.35,5.93-55.09-10.11c-0.34,2.18-2.33,3.69-4.92,5.31 c-6.12,3.84-8.02,7.07-9.27,9.99c-0.84,1.96-1.38,3.78-2.7,5.55c-4.09,5.46-8.33,9.51-15.44,8.54c-2.8,0.85-5.06-0.76-4.45-3.48 c-1.51-6.83,3.42-14.05,10.86-17.91c2.33-1.21,4.47-1.75,6.74-3.21c0.87-0.56,1.67-1.17,2.37-1.88c5.01-5.11,3.75-6.61,6.51-9.04 c0.96-0.85,2.08-1.36,3.39-1.42c0.95-1.46,3.13-2.47,5.62-1.6l3.36-2.86c11.66,11.96,25.97,12.95,39.02,7.77L41.68,50.65 L27.29,64.77L11.98,49.44l30.59-30.29l26.76,3.86L50.14,42.06L50.14,42.06z"></path>
              </svg>
            </div>
            <span class="export-name">Hypercite workbench</span>
            <span class="export-desc">Find the citations between these texts and link them — opens in a new tab</span>
          </button>
        </div>
      </div>`;
}

export async function buildArchiveHtml(data: ArchivePanelData): Promise<string> {
  const citation = await formatBibtexToCitation(data.bibtex);

  return `
    <div class="resize-edge resize-left" title="Resize width"></div>
    <div class="scroller" id="archive-content">
      <p class="citation" style="padding-bottom: 5px">${citation}</p>
      <p class="archive-counts">${escapeHtml(countsLine(data))}</p>
      ${librarianSection(data)}

      <div class="archive-downloads">
        <h3>Download</h3>

        <button type="button" id="download-archive-md" class="download-btn archive-export-btn" hidden>
          <div class="icon-wrapper">
            <svg class="download-icon" viewBox="0 0 24 24" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
              <path fill="currentColor" d="M14.481 14.015c-.238 0-.393.021-.483.042v3.089c.091.021.237.021.371.021.966.007 1.597-.525 1.597-1.653.007-.981-.568-1.499-1.485-1.499z"/>
              <path fill="currentColor" d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm-2.934 15.951-.07-1.807a53.142 53.142 0 0 1-.042-1.94h-.021a26.098 26.098 0 0 1-.525 1.828l-.574 1.842H9l-.504-1.828a21.996 21.996 0 0 1-.428-1.842h-.013c-.028.638-.049 1.366-.084 1.954l-.084 1.793h-.988L7.2 13.23h1.422l.462 1.576c.147.546.295 1.135.399 1.688h.021a39.87 39.87 0 0 1 .448-1.694l.504-1.569h1.394l.26 4.721h-1.044zm5.25-.56c-.498.413-1.253.609-2.178.609a9.27 9.27 0 0 1-1.212-.07v-4.636a9.535 9.535 0 0 1 1.443-.099c.896 0 1.478.161 1.933.505.49.364.799.945.799 1.778 0 .904-.33 1.528-.785 1.913zM14 9h-1V4l5 5h-4z"/>
            </svg>
            <span class="export-progress" aria-hidden="true"></span>
          </div>
          <span class="export-name">Markdown vault</span>
          <span class="export-desc">.zip — one .md per text, drop into Obsidian</span>
        </button>

        <button type="button" id="download-archive-sqlite" class="download-btn archive-export-btn" hidden>
          <div class="icon-wrapper">
            <svg class="download-icon" viewBox="0 0 24 24" preserveAspectRatio="xMidYMid meet" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
              <ellipse cx="12" cy="5" rx="9" ry="3"/>
              <path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5"/>
              <path d="M3 12c0 1.66 4.03 3 9 3s9-1.34 9-3"/>
            </svg>
            <span class="export-progress" aria-hidden="true"></span>
          </div>
          <span class="export-name">Data file</span>
          <span class="export-desc">.sqlite — texts, annotations and vector embeddings for offline work</span>
        </button>
      </div>
      ${creatorToolsSection(data)}
    </div>
    ${actionBar(data)}
  `;
}
