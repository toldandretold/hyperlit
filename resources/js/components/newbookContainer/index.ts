// NewBookContainerManager — the #newbook-container panel opened by #newBookButton. It owns the
// open/close animation lifecycle, the two in-panel buttons (#createNewBook → SPA create,
// #importBook → inject the cite-form), and the resize listener. The heavy logic lives in focused
// sibling modules; this class is the thin stateful orchestrator that holds the state and
// delegates. The cite-form markup comes from ./citeForm/template and its behaviour is lazy-loaded
// from ./citeForm. Registry lifecycle + the default-export singleton live in
// ../newBookButton/newBookButton.
import { ContainerManager } from '../utilities/containerManager';
import { verbose } from '../../utilities/logger';
import { setupContainerStyles } from './containerStyles';
import { resetAnimationState as resetAnimationStateImpl } from './animation';
import { setupButtonListeners as setupButtonListenersImpl, restoreOriginalContent as restoreOriginalContentImpl } from './buttonView';
import { openContainer as openContainerImpl, closeContainer as closeContainerImpl, setResponsiveFormSize as setResponsiveFormSizeImpl } from './openClose';
import { showImportForm as showImportFormImpl } from './importForm';
import type { ContainerHost, ButtonRect } from './host';

export class NewBookContainerManager extends (ContainerManager as any) implements ContainerHost {
  // Resolved by the base ContainerManager (declare → typed here without re-initializing).
  declare container: HTMLElement;
  declare overlay: HTMLElement | null;
  declare button: HTMLElement;
  declare isOpen: boolean;

  // Animation + view state.
  isAnimating = false;
  animationType = '';
  animationTimeout: ReturnType<typeof setTimeout> | null = null;
  transitionEndHandler: ((ev?: Event) => void) | null = null;
  originalButtonRect: ButtonRect | null = null;
  originalContent: string | null = null;
  recentExternalLinkClick = false;
  resizeHandler: (() => void) | null = null;
  createBookHandler: ((ev?: Event) => void) | null = null;
  importBookHandler: ((ev?: Event) => void) | null = null;

  private boundVisibilityChangeHandler: () => void;
  private boundFocusHandler: () => void;

  constructor(containerId: string, overlayId: string, buttonId: string, frozenContainerIds: string[] = []) {
    super(containerId, overlayId, buttonId, frozenContainerIds);

    setupContainerStyles(this.container);
    this.button = document.getElementById(buttonId) as HTMLElement;

    this.setupButtonListeners();

    this.boundVisibilityChangeHandler = this.handleVisibilityChange.bind(this);
    this.boundFocusHandler = this.handleFocus.bind(this);
    document.addEventListener('visibilitychange', this.boundVisibilityChangeHandler);
    window.addEventListener('focus', this.boundFocusHandler);
  }

  // The form-open flow flips this when an external link is clicked; visibility/focus returning
  // must not be treated as a reason to close the form.
  handleVisibilityChange(): void {
    if (!document.hidden && this.recentExternalLinkClick) {
      verbose.init('Page visible again after external link click - preserving form state', 'newBookButton.js');
      this.recentExternalLinkClick = false;
    }
  }

  handleFocus(): void {
    if (this.recentExternalLinkClick) {
      verbose.init('Page focused after external link click - preserving form state', 'newBookButton.js');
      this.recentExternalLinkClick = false;
    }
  }

  destroy(): void {
    document.removeEventListener('visibilitychange', this.boundVisibilityChangeHandler);
    window.removeEventListener('focus', this.boundFocusHandler);
    this.cleanupResizeListener();
    this.resetAnimationState();
    verbose.init('All global listeners removed', 'newBookButton.js');
  }

  // Lazy: the resize listener is only created when the import form is opened.
  setupResizeListener(): void {
    if (!this.resizeHandler) {
      this.resizeHandler = () => {
        if (this.isOpen && this.container?.querySelector('#cite-form')) {
          this.setResponsiveFormSize();
        }
      };
      window.addEventListener('resize', this.resizeHandler);
    }
  }

  cleanupResizeListener(): void {
    if (this.resizeHandler) {
      window.removeEventListener('resize', this.resizeHandler);
      this.resizeHandler = null;
    }
  }

  // --- Delegations to the extracted helper modules --------------------------------------------
  resetAnimationState(): void { resetAnimationStateImpl(this); }
  setupButtonListeners(): void { setupButtonListenersImpl(this); }
  restoreOriginalContent(): void { restoreOriginalContentImpl(this); }
  showImportForm(): void { showImportFormImpl(this); }
  setResponsiveFormSize(): void { setResponsiveFormSizeImpl(this); }
  openContainer(mode = 'buttons'): void { openContainerImpl(this, mode); }
  closeContainer(): void { closeContainerImpl(this); }
}
