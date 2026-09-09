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
    </div>
  `;
}
