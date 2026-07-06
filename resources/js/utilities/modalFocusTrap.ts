/**
 * modalFocusTrap — leaf (imports only the modalState leaf). Keyboard focus
 * management for ad-hoc modal dialogs (WCAG 2.1.2 / 2.4.3): on trap, focus
 * moves into the dialog; Tab/Shift+Tab cycle its focusables; Escape invokes
 * onEscape; release() detaches the listener and restores focus to the
 * previously-focused element.
 *
 * Stacking: each trap registers on the global modal stack (utilities/
 * modalState.ts) and only the TOP trap acts on keydown — a dialog opened above
 * another trapped surface takes over Tab/Escape, and the surface below
 * resumes when it closes.
 *
 * Robustness notes (learned from the E2EE unlock modal opening during reader
 * boot, before layout settles):
 *   - visibility is checked with getClientRects() (offsetParent is null for
 *     position:fixed subtrees and mid-boot layouts), and when EVERY candidate
 *     reports no rects we fall back to the unfiltered list rather than
 *     dead-trapping Tab;
 *   - the initial focus seat retries on the next animation frame in case the
 *     dialog wasn't laid out yet when the trap engaged.
 *
 * ContainerManager has its own instance-method trap for registry-managed
 * containers (user/newbook/settings/source/toc) — this leaf serves standalone
 * dialogs built outside that system (unlock modal, floating menu, alerts…).
 */

import { pushModal, popModal, isTopModal } from './modalState';

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function trapModalFocus(
  root: HTMLElement,
  { onEscape }: { onEscape?: () => void } = {}
): () => void {
  const returnEl = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const token = pushModal();

  const focusables = (): HTMLElement[] => {
    const all = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
    const visible = all.filter((el) => el.getClientRects().length > 0);
    // Mid-boot / mid-animation layouts can report zero rects for everything;
    // an unfiltered fallback beats a dead trap that cancels Tab silently.
    return visible.length > 0 ? visible : all;
  };

  const seat = () => {
    const initial = focusables()[0];
    if (initial) {
      initial.focus();
    } else {
      if (!root.hasAttribute('tabindex')) root.setAttribute('tabindex', '-1');
      root.focus();
    }
  };
  seat();
  requestAnimationFrame(() => {
    if (!root.contains(document.activeElement)) seat();
  });

  const onKeydown = (e: KeyboardEvent) => {
    if (!isTopModal(token)) return; // a modal stacked above us owns the keys

    if (e.key === 'Escape') {
      // stopImmediatePropagation: other document-capture listeners (incl. a
      // trap below us in the stack, legacy Escape handlers) must not also act.
      e.stopImmediatePropagation();
      onEscape?.();
      return;
    }
    if (e.key !== 'Tab') return;

    const els = focusables();
    const first = els[0];
    const last = els[els.length - 1];
    if (!first || !last) {
      e.preventDefault();
      return;
    }
    const active = document.activeElement;
    const inside = root.contains(active);

    if (e.shiftKey) {
      if (!inside || active === first || active === root) {
        e.preventDefault();
        last.focus();
      }
    } else if (!inside || active === last || active === root) {
      e.preventDefault();
      first.focus();
    }
  };
  document.addEventListener('keydown', onKeydown, true);

  return () => {
    popModal(token);
    document.removeEventListener('keydown', onKeydown, true);
    if (returnEl && returnEl.isConnected) {
      try { returnEl.focus(); } catch { /* non-fatal */ }
    }
  };
}
