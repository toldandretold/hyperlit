// The two-button view inside #newbook-container (#createNewBook → SPA create, #importBook →
// inject the cite-form) and reverting to it. Sibling behaviour (open/close/showImportForm/
// resize) is reached via host methods so this module only statically imports leaves + the
// navigation seam — no import cycle. Was NewBookContainerManager.setupButtonListeners /
// restoreOriginalContent.
import { navigate } from '../../SPA/navigation/navigationRegistry';
import { verbose } from '../../utilities/logger';
import { setImportEncryptIntent, getImportEncryptIntent } from './encryptIntent';
import type { ContainerHost } from './host';

const SETUP_FORM_MAX_RETRIES = 200; // 10s @ 50ms/retry — generous; the form normally appears on retry 1–3.

// The "?" info expander next to the Encrypted checkbox. Delegated on the
// container (which survives the innerHTML swaps between buttons view and
// import form), wired once per container element.
function wireEncryptInfoToggle(host: ContainerHost): void {
  if (host.container.dataset.encInfoWired) return;
  host.container.dataset.encInfoWired = '1';

  const toggle = (target: EventTarget | null): void => {
    const btn = (target as HTMLElement | null)?.closest?.('.newbook-encrypt-info-toggle');
    if (!btn) return;
    const info = host.container.querySelector('.newbook-encrypt-info');
    if (!info) return;
    const opening = info.hasAttribute('hidden');
    info.toggleAttribute('hidden');
    btn.setAttribute('aria-expanded', String(opening));
  };

  host.container.addEventListener('click', (e) => toggle(e.target));
  host.container.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    // Native checkboxes only toggle on Space; in this keyboard-trapped popup
    // users expect Enter to toggle the Encrypt checkbox too.
    if (e.key === 'Enter' && (e.target as HTMLElement | null)?.id === 'createEncrypted') {
      e.preventDefault();
      (e.target as HTMLInputElement).click();
      return;
    }
    const btn = (e.target as HTMLElement | null)?.closest?.('.newbook-encrypt-info-toggle');
    if (!btn) return;
    e.preventDefault();
    toggle(btn);
  });
}

export function setupButtonListeners(host: ContainerHost): void {
  // Remove existing handlers before re-binding (the view is re-created on every close).
  if (host.createBookHandler) {
    document.getElementById('createNewBook')?.removeEventListener('click', host.createBookHandler);
  }
  if (host.importBookHandler) {
    document.getElementById('importBook')?.removeEventListener('click', host.importBookHandler);
  }

  host.createBookHandler = async () => {
    verbose.init('Create new book clicked', 'newBookButton.js');

    // E2EE (docs/e2ee.md): the "Encrypted" checkbox opts this book into
    // client-side encryption. Verify the vault is READY before navigating —
    // createNewBook must never silently downgrade to plaintext.
    const encryptedChecked = (document.getElementById('createEncrypted') as HTMLInputElement | null)?.checked;
    sessionStorage.removeItem('pending_new_book_encrypted');
    if (encryptedChecked) {
      try {
        const { isVaultUnlocked } = await import('../../e2ee/keys');
        if (!(await isVaultUnlocked())) {
          const { showUnlockModal } = await import('../../e2ee/ui/unlockModal');
          await showUnlockModal(); // throws if dismissed / no vault yet
        }
        sessionStorage.setItem('pending_new_book_encrypted', '1');
      } catch {
        window.alert('Encrypted books need a passkey vault — set one up under your profile → Passkeys, then try again.');
        return;
      }
    }

    host.closeContainer();
    try {
      // NavigationManager manages the overlay lifecycle correctly.
      await navigate('create-new-book', { createAndTransition: true });
      verbose.init('New book transition completed successfully', 'newBookButton.js');
    } catch (error) {
      console.error('❌ New book creation failed:', error);
    }
  };

  host.importBookHandler = () => {
    verbose.init('Import book clicked', 'newBookButton.js');

    // E2EE: the SAME "Encrypted" checkbox governs Import too. Capture it NOW —
    // showImportForm replaces the container's innerHTML, so the checkbox is
    // gone from the DOM by the time the cite-form submits. citeForm/submission
    // reads the intent from encryptIntent.ts and arms encrypt-after-import.
    setImportEncryptIntent(
      !!(document.getElementById('createEncrypted') as HTMLInputElement | null)?.checked
    );

    // Save the buttons view so close can restore it.
    if (!host.originalContent) host.originalContent = host.container.innerHTML;

    // Lazy-init the resize listener only when the form is opened.
    host.setupResizeListener();

    host.showImportForm();
    host.openContainer('form');

    // Defensive wait for the form to land in the DOM: it should be present the moment
    // showImportForm returns, but during rapid open/close cycles getElementById can briefly
    // miss it. Retry quietly; only error after a generous budget.
    let retryCount = 0;
    const setupForm = () => {
      // Aborted (the container was closed while waiting) — nothing to wire up, not an error.
      if (!host.isOpen) return;
      const form = document.getElementById('cite-form');
      if (!form) {
        if (++retryCount > SETUP_FORM_MAX_RETRIES) {
          console.error(`Import form failed to render after ${SETUP_FORM_MAX_RETRIES} retries`);
          return;
        }
        setTimeout(setupForm, 50);
        return;
      }

      import('./citeForm/index')
        .then((module) => {
          // The container may have been closed during the dynamic import — re-check
          // before wiring, or we set up listeners against a torn-down form.
          if (!host.isOpen || !document.getElementById('cite-form')) return;
          module.initializeCitationFormListeners();
          module.setupFormSubmissionHandler();
        })
        .catch((error) => {
          console.error('Error importing citation form module:', error);
        });
    };

    // Next frame + a small delay so mobile open animations don't interfere.
    requestAnimationFrame(() => {
      setTimeout(setupForm, 100);
    });
  };

  document.getElementById('createNewBook')?.addEventListener('click', host.createBookHandler);
  document.getElementById('importBook')?.addEventListener('click', host.importBookHandler);

  wireEncryptInfoToggle(host);
}

export function restoreOriginalContent(host: ContainerHost): void {
  if (!host.originalContent) return;

  // Restore the two buttons and shrink back to the buttons-view size
  // (matches openContainer's buttons-mode geometry: 160px wide, auto height —
  // auto because the encrypt info expander can grow the view).
  host.container.innerHTML = host.originalContent;
  host.container.style.width = '160px';
  host.container.style.height = 'auto';
  host.container.style.overflow = 'hidden';

  // innerHTML restore loses the checkbox's checked PROPERTY — re-sync it from
  // the captured intent so cancelling the import form doesn't visually
  // uncheck what the user selected.
  const checkbox = document.getElementById('createEncrypted') as HTMLInputElement | null;
  if (checkbox) checkbox.checked = getImportEncryptIntent();

  host.setupButtonListeners();
}
