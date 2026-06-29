// Inject the cite-form into #newbook-container and wire only the container-level controls
// (cancel / close → revert to the buttons view). All form behaviour — type→fields toggling,
// draft persistence, the clear button, URL auto-format, validation — is owned by ./citeForm,
// which is lazy-loaded by the import-book handler after this injects the markup. (Pre-refactor
// this method duplicated those concerns; they were merged away into citeForm.)
import { getCiteFormHTML } from './citeForm/template';
import type { ContainerHost } from './host';

export function showImportForm(host: ContainerHost): void {
  host.container.innerHTML = getCiteFormHTML();

  // openContainer owns positioning/display; drop any flex layout left from the buttons view.
  host.container.style.flexDirection = '';
  host.container.style.justifyContent = '';
  host.container.style.alignItems = '';
  host.container.style.gap = '';

  // Container-level revert controls (the form's own clear/submit are wired by citeForm).
  host.container.querySelector('.close-button')?.addEventListener('click', () => {
    host.restoreOriginalContent();
  });
  document.getElementById('cancelImport')?.addEventListener('click', () => {
    host.restoreOriginalContent();
  });
}
