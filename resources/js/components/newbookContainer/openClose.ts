// The open/close state machine for #newbook-container. Drives the fade/size animation between
// the closed state, the two-button view, and the import-form view, anchoring to the +button
// (which lives top-right on home/user but in the left logo-nav on the reader). Geometry comes
// from ./geometry (single source); completion wiring from ./animation. Sibling restore-on-close
// is reached via host.setupButtonListeners (inside finishClose) so there's no import cycle.
import { verbose } from '../../utilities/logger';
import { computeFormGeometry, applyFormGeometry } from './geometry';
import { armTransition, resetAnimationState, finishClose } from './animation';
import type { ContainerHost, ButtonRect } from './host';

const MOBILE_MAX_WIDTH = 480;

function snapshotRect(rect: DOMRect): ButtonRect {
  // Spread can miss DOMRect getters in some browsers, so copy right/bottom explicitly (the
  // only fields the geometry reads).
  return { ...rect, right: rect.right, bottom: rect.bottom } as unknown as ButtonRect;
}

export function openContainer(host: ContainerHost, mode = 'buttons'): void {
  // Animation guard: a live animation with a pending timeout blocks a re-open; a stuck one
  // (animating with no timeout) is force-reset.
  if (host.isAnimating && host.animationTimeout) {
    verbose.init('Animation in progress, blocking openContainer', 'newBookButton.js');
    return;
  } else if (host.isAnimating && !host.animationTimeout) {
    verbose.init('Stuck animation state detected, forcing reset', 'newBookButton.js');
    resetAnimationState(host);
  }

  // Fresh open: reset any stuck inline state so mobile doesn't glitch.
  if (!host.isOpen) {
    host.container.style.display = 'none';
    host.container.style.opacity = '0';
    host.container.style.width = '0';
    host.container.style.height = '0';
    host.container.style.visibility = 'hidden';
    host.container.classList.remove('hidden');
    host.container.style.left = '';
    host.container.style.right = '';
    host.container.style.top = '';
    host.container.style.transform = '';
  }

  host.isAnimating = true;
  host.animationType = 'open';

  const isMobile = window.innerWidth <= MOBILE_MAX_WIDTH;
  const rect = host.button.getBoundingClientRect();
  // The reader's +button sits in the left logo-nav, so anchor the popup's LEFT edge to it
  // instead of the right.
  const isLeftAnchored = !!host.button.closest('#logoNavMenu');

  // TRANSITION: already open in the buttons view, growing into the form view.
  if (host.isOpen && mode === 'form') {
    if (!host.originalButtonRect) host.originalButtonRect = snapshotRect(rect);

    host.container.style.display = 'block';
    host.container.style.gap = '';
    host.container.style.alignItems = '';
    host.container.style.justifyContent = '';
    host.container.style.flexDirection = '';

    const geom = computeFormGeometry({
      isMobile, isLeftAnchored, buttonRect: host.originalButtonRect, innerWidth: window.innerWidth,
    });

    requestAnimationFrame(() => {
      // Leave the already-set left/right alone (anchor:false) so the box doesn't jump.
      applyFormGeometry(host.container, geom, { anchor: false });
      armTransition(host, () => resetAnimationState(host));
    });
    return;
  }

  // FIRST open (from closed).
  if (!host.isOpen) {
    // Activate overlay FIRST to mask the button background during the icon rotation.
    if (host.overlay) {
      host.overlay.style.transition = 'none';
      host.overlay.classList.add('active');
      host.overlay.style.display = 'block';
      // Full opacity, matching .active — a fractional value here scales down the
      // overlay's backdrop-filter blur (opacity composites the blurred backdrop too),
      // which made this overlay visibly less blurred than #user-overlay on home.
      host.overlay.style.opacity = '1';
      requestAnimationFrame(() => { if (host.overlay) host.overlay.style.transition = ''; });
    }

    host.button.querySelector('.icon')?.classList.add('tilted');

    if (!host.originalButtonRect) host.originalButtonRect = snapshotRect(rect);

    if (mode === 'form') {
      // Open directly into the form view (skip the buttons layout): start invisible, fade in.
      host.container.style.visibility = 'visible';
      host.container.style.opacity = '0';
      host.container.style.display = 'block';

      const geom = computeFormGeometry({
        isMobile, isLeftAnchored, buttonRect: host.originalButtonRect, innerWidth: window.innerWidth,
      });
      applyFormGeometry(host.container, geom, { anchor: true });

      requestAnimationFrame(() => { host.container.style.opacity = '1'; });
    } else {
      // Buttons view: dock just below the +button, anchored to its left or right edge.
      host.container.style.top = `${rect.bottom + 8}px`;
      if (isLeftAnchored) {
        host.container.style.left = `${rect.left}px`;
        host.container.style.right = '';
      } else {
        host.container.style.right = `${window.innerWidth - rect.right}px`;
        host.container.style.left = '';
      }
      host.container.style.visibility = 'visible';
      host.container.style.opacity = '0';
      host.container.style.width = '160px';
      host.container.style.height = 'auto';
      host.container.style.padding = '20px';
      host.container.style.display = 'block';

      requestAnimationFrame(() => { host.container.style.opacity = '1'; });
    }

    host.isOpen = true;
    (window as any).uiState?.setActiveContainer(host.container.id);
    (host as any)._engageFocusTrap?.(); // base ContainerManager: Tab trap + Escape + focus restore
    armTransition(host, () => resetAnimationState(host));
  }
}

export function closeContainer(host: ContainerHost): void {
  // A close must never be silently dropped. If an animation is in flight: a running CLOSE is
  // left to finish; an OPEN (or stuck) one is interrupted so the close takes over — this is
  // what makes a quick overlay click reliably dismiss the form during the ~500ms open window.
  if (host.isAnimating) {
    if (host.animationType === 'close' && host.animationTimeout) return;
    verbose.init('Interrupting in-flight open animation to close', 'newBookButton.js');
    resetAnimationState(host);
  }

  host.isAnimating = true;
  host.animationType = 'close';
  verbose.init('closeContainer called', 'newBookButton.js');

  // Don't close right after an external-link click (mobile protection).
  if (host.recentExternalLinkClick) {
    verbose.init('Preventing container close due to recent external link click', 'newBookButton.js');
    host.isAnimating = false;
    host.recentExternalLinkClick = false;
    return;
  }

  host.originalButtonRect = null; // Recalculate next open.
  host.cleanupResizeListener();

  const icon = host.button.querySelector('.icon');
  if (icon) icon.classList.remove('tilted');

  // Animate width/height/opacity/padding → 0; leave left/right/top alone (clearing them
  // mid-animation makes the box glide toward the layout origin). Positioning is cleared in
  // finishClose once the container is hidden.
  host.container.style.padding = '0';
  host.container.style.width = '0';
  host.container.style.height = '0';
  host.container.style.opacity = '0';

  if (host.overlay) {
    host.overlay.classList.remove('active');
    host.overlay.style.opacity = '0';
  }

  host.isOpen = false;
  if ((window as any).uiState) {
    (window as any).uiState.setActiveContainer('main-content');
  } else {
    (window as any).activeContainer = 'main-content';
  }
  (host as any)._releaseFocusTrap?.();

  armTransition(host, () => finishClose(host));
}

// Re-apply the form size on window resize (only while the form is open). Single-sources the
// numbers via computeFormGeometry; mobile re-applies the full sheet, desktop only resizes
// (position is owned by openContainer). Was setResponsiveFormSize (which used a stale 500px
// desktop width — now 400px, matching the open path).
export function setResponsiveFormSize(host: ContainerHost): void {
  if (!host.originalButtonRect) return;

  const isMobile = window.innerWidth <= MOBILE_MAX_WIDTH;
  const isLeftAnchored = !!host.button.closest('#logoNavMenu');
  const geom = computeFormGeometry({
    isMobile, isLeftAnchored, buttonRect: host.originalButtonRect, innerWidth: window.innerWidth,
  });

  if (isMobile) {
    applyFormGeometry(host.container, geom, { anchor: true });
  } else {
    host.container.style.width = geom.width;
    host.container.style.height = geom.height;
    host.container.style.maxWidth = geom.maxWidth;
  }
}
