// The open/close animation completion machinery. CSS transitions can silently fail to fire
// `transitionend` (mobile browsers), so every animation is "armed" with a transitionend
// listener AND a 500ms fallback timeout; whichever fires first runs the completion callback.
// `finishClose` is the shared close-completion (previously duplicated verbatim across the
// transitionend handler and the timeout fallback). Imports only the host type → cycle-free.
import type { ContainerHost } from './host';

// Clear any pending timeout + transitionend listener and drop the animating flag.
export function resetAnimationState(host: ContainerHost): void {
  if (host.animationTimeout) {
    clearTimeout(host.animationTimeout);
    host.animationTimeout = null;
  }
  if (host.transitionEndHandler) {
    host.container.removeEventListener('transitionend', host.transitionEndHandler);
    host.transitionEndHandler = null;
  }
  host.isAnimating = false;
}

// Arm a one-shot completion: transitionend (once) + a 500ms fallback. Both call onFinish,
// which is expected to call resetAnimationState (directly or via finishClose) so the listener
// + timeout are torn down and the second path no-ops.
export function armTransition(host: ContainerHost, onFinish: () => void): void {
  resetAnimationState(host);
  host.isAnimating = true;

  host.transitionEndHandler = () => { onFinish(); };
  host.container.addEventListener('transitionend', host.transitionEndHandler, { once: true });

  host.animationTimeout = setTimeout(() => {
    if (host.isAnimating) onFinish();
  }, 500);
}

// Shared close completion: hide + collapse the container, clear positioning (safe now it's
// hidden — clearing mid-animation would make it glide toward the layout origin), hide the
// overlay, and restore the two-button view so the next open starts clean.
export function finishClose(host: ContainerHost): void {
  host.container.classList.add('hidden');
  host.container.style.display = 'none';

  host.container.style.left = '';
  host.container.style.right = '';
  host.container.style.top = '';
  host.container.style.transform = '';

  resetAnimationState(host);

  if (host.overlay) host.overlay.style.display = 'none';

  if (host.originalContent && host.container.innerHTML !== host.originalContent) {
    host.container.innerHTML = host.originalContent;
    host.setupButtonListeners();
  }
}
