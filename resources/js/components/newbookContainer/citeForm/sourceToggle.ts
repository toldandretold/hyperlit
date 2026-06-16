// Top-level "Import from URL" vs "Import a file" toggle for the cite-form.
// Was setupSourceToggle() of newBookForm.js.
import { $ } from './dom';

export function setupSourceToggle() {
  const urlBtn = $('source-toggle-url');
  const fileBtn = $('source-toggle-file');
  const urlPanel = $('import-source-url');
  const filePanel = $('import-source-file');
  if (!urlBtn || !fileBtn || !urlPanel || !filePanel) return;

  const setMode = (mode: string) => {
    const isUrl = mode === 'url';
    urlPanel.style.display = isUrl ? '' : 'none';
    filePanel.style.display = isUrl ? 'none' : '';
    urlBtn.classList.toggle('active', isUrl);
    fileBtn.classList.toggle('active', !isUrl);
    urlBtn.setAttribute('aria-selected', isUrl ? 'true' : 'false');
    fileBtn.setAttribute('aria-selected', isUrl ? 'false' : 'true');
    if (isUrl) {
      $('import-url-input')?.focus();
    }
  };

  urlBtn.addEventListener('click', () => setMode('url'));
  fileBtn.addEventListener('click', () => setMode('file'));
}
