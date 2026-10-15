// The "download the original PDF" button in the source container's Download
// row ("PDF phile"). A book imported from a PDF keeps its upload at
// resources/markdown/{book}/original.pdf — this button hands the reader that
// file, OCR warts and all. PDF only, deliberately: an original epub/docx
// would read as a confusing duplicate of our epub/docx EXPORTS (those
// originals stay in the owner's download-all zip).
//
// The button is rendered hidden and revealed by ONE HEAD probe against the
// download route itself — /{book}/original.pdf answers existence AND access
// in a single bodyless request (Laravel serves HEAD for GET routes
// automatically), so there is no separate status endpoint. 403/404/offline
// all mean the same thing to the reader: no button.
import { drainResponse } from '../../utilities/drainResponse';
import { verbose } from '../../utilities/logger';
import { isSyntheticBook } from './helpers';

const BUTTON_ID = 'download-original-pdf';

export interface OriginalPdfDownloadHandle {
  destroy(): void;
}

export function initOriginalPdfDownload(
  container: HTMLElement,
  bookId: string,
): OriginalPdfDownloadHandle | null {
  const button = container.querySelector<HTMLButtonElement>(`#${BUTTON_ID}`);
  if (!button) return null;

  // Synthetic shelf books and sub-books (footnotes/hyperlights) have no
  // original.pdf by construction — don't probe, just leave the button hidden.
  if (isSyntheticBook(bookId) || bookId.includes('/')) return null;

  let destroyed = false;
  const url = `/${encodeURIComponent(bookId)}/original.pdf`;

  const onClick = (event: Event): void => {
    event.preventDefault();
    event.stopPropagation();
    const a = document.createElement('a');
    a.href = url;
    a.download = ''; // the server's Content-Disposition supplies the real name
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  button.addEventListener('click', onClick);

  void (async () => {
    try {
      const resp = await drainResponse(
        await fetch(url, { method: 'HEAD', credentials: 'include' }),
      );
      if (destroyed || !resp.ok) return; // 403/404: stay hidden

      button.hidden = false;
      const label = 'Download the original PDF this book was imported from';
      button.title = label;
      button.setAttribute('aria-label', label);
      verbose.init('original-pdf download button revealed', '/components/sourceContainer/originalPdfDownload');
    } catch {
      // offline / aborted — the button simply stays hidden
    }
  })();

  return {
    destroy(): void {
      destroyed = true;
      button.removeEventListener('click', onClick);
    },
  };
}
