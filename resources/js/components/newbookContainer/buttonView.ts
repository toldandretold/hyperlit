// The two-button view inside #newbook-container (#createNewBook → SPA create, #importBook →
// inject the cite-form) and reverting to it. Sibling behaviour (open/close/showImportForm/
// resize) is reached via host methods so this module only statically imports leaves + the
// navigation seam — no import cycle. Was NewBookContainerManager.setupButtonListeners /
// restoreOriginalContent.
import { navigate } from '../../SPA/navigation/navigationRegistry';
import { log, verbose } from '../../utilities/logger';
import type { ContainerHost } from './host';

const SETUP_FORM_MAX_RETRIES = 200; // 10s @ 50ms/retry — generous; the form normally appears on retry 1–3.

function addHoverEffect(btn: HTMLElement): void {
  btn.addEventListener('mouseenter', () => {
    btn.style.backgroundColor = 'var(--color-accent)';
    btn.style.color = 'var(--color-background)';
  });
  btn.addEventListener('mouseleave', () => {
    btn.style.backgroundColor = '#4a4a4a';
    btn.style.color = '#CBCCCC';
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
    host.closeContainer();
    try {
      // NavigationManager manages the overlay lifecycle correctly.
      await navigate('create-new-book', { createAndTransition: true });
      log.init('New book transition completed successfully', 'newBookButton.js');
    } catch (error) {
      console.error('❌ New book creation failed:', error);
    }
  };

  host.importBookHandler = () => {
    verbose.init('Import book clicked', 'newBookButton.js');
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

  const createBtn = document.getElementById('createNewBook');
  if (createBtn) addHoverEffect(createBtn);
  const importBtn = document.getElementById('importBook');
  if (importBtn) addHoverEffect(importBtn);
}

export function restoreOriginalContent(host: ContainerHost): void {
  if (!host.originalContent) return;

  // Restore the two buttons and shrink back to the buttons-view size.
  host.container.innerHTML = host.originalContent;
  host.container.style.width = '150px';
  host.container.style.height = '100px';
  host.container.style.overflow = 'hidden';

  host.setupButtonListeners();
}
