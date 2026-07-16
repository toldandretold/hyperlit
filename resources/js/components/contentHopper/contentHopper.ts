/**
 * contentHopper — keyboard navigation for in-text interactables (WCAG 2.1.1).
 *
 * The reader's Tab order is deliberately a short chrome loop (content links
 * are tabindex="-1", see lazyLoader/chunkRender). This module is the keyboard
 * way INTO the content: letter shortcuts hop between annotations in DOM
 * order, Enter activates the current one. Arrow keys / Space / PageUp/Down
 * are never touched — native scrolling stays native (the user decision behind
 * this design; see docs/a11y-findings.md "Keyboard model").
 *
 *   n / j   next annotation (hyperlight, hypercite, footnote ref, citation, link)
 *   p / k   previous annotation
 *   Enter   activate the focused annotation (open container / follow link)
 *   ?       list the shortcuts (app dialog)
 *
 * Inert while: typing (inputs / contenteditable), edit mode, any modal open
 * (utilities/modalState), or a modifier key is held.
 *
 * Runs on ALL pages (reader book text, home/user card feeds, homepage copy):
 * ONE keyboard model everywhere — Tab never enters content, n/p always does.
 * ButtonRegistry lifecycle: document-delegated singleton — init is
 * create-once + reset, destroy detaches (survives SPA nav per the gate).
 */

import { isAnyModalOpen } from '../../utilities/modalState';
import { verbose } from '../../utilities/logger';
import { maybePaginatorReveal } from '../../scrolling/paginator';

// One entry per interactable kind. Footnote sups match before their inner <a>
// (the dedupe below skips anchors already inside a matched sup).
const HOP_SELECTOR = [
  'mark[data-highlight-count]',
  'u.couple',
  'u.poly',
  'sup[fn-count-id]',
  'a.in-text-citation',
  'a[href]:not(.in-text-citation):not(.footnote-ref)',
].join(', ');

let attached = false;
let keydownHandler: ((e: KeyboardEvent) => void) | null = null;

/** Content territories the hop layer covers, in DOM order.
 *
 *  When a hyperlit container (footnote/highlight/hypercite panel) is open,
 *  IT is the active territory — hop within the TOP layer only (a stacked
 *  layer covers the ones beneath; Escape pops back out). Otherwise: the
 *  page's main-content (reader book, home/user card feeds) plus the
 *  homepage welcome copy. */
function contentRoots(): HTMLElement[] {
  const stacked = document.querySelectorAll<HTMLElement>('.hyperlit-container-stacked.open');
  const topStacked = stacked[stacked.length - 1];
  if (topStacked) return [topStacked];
  const base = document.querySelector<HTMLElement>('#hyperlit-container.open');
  if (base) return [base];
  return Array.from(document.querySelectorAll<HTMLElement>('.main-content, .welcome-copy'));
}

function hopTargets(): HTMLElement[] {
  const all: HTMLElement[] = [];
  for (const root of contentRoots()) {
    all.push(...Array.from(root.querySelectorAll<HTMLElement>(HOP_SELECTOR)));
  }
  return all.filter((el) => {
    // Dedupe: an <a> living inside a matched footnote <sup> — hop to the sup.
    if (el.tagName === 'A' && el.closest('sup[fn-count-id]') !== el && el.closest('sup[fn-count-id]')) return false;
    return el.getClientRects().length > 0;
  });
}

function isTypingContext(e: KeyboardEvent): boolean {
  const target = e.target instanceof HTMLElement ? e.target : null;
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const el = target || active;
  return !!el?.closest('input, textarea, select, [contenteditable="true"]');
}

function hop(direction: 1 | -1): void {
  const targets = hopTargets();
  if (targets.length === 0) return;

  const active = document.activeElement;
  let index: number;
  const currentIdx = active instanceof HTMLElement ? targets.indexOf(active) : -1;
  if (currentIdx >= 0) {
    index = (currentIdx + direction + targets.length) % targets.length;
  } else {
    // No current annotation: start from the first one at/after the viewport
    // top (backwards: the last one before it) so hopping picks up mid-book.
    const fromTop = targets.findIndex((el) => el.getBoundingClientRect().bottom >= 0);
    if (direction === 1) index = fromTop >= 0 ? fromTop : 0;
    else index = fromTop > 0 ? fromTop - 1 : targets.length - 1;
  }

  const target = targets[index];
  if (!target) return;
  if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
  target.focus({ preventScroll: true });
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
  // Paginated mode: flip to the annotation's page instead of scrolling.
  if (!maybePaginatorReveal(target)) {
    target.scrollIntoView({ block: 'center', behavior: reduced ? 'auto' : 'smooth' });
  }
}

function activateCurrent(): boolean {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return false;
  if (!contentRoots().some((root) => root.contains(active))) return false;
  if (!active.matches(HOP_SELECTOR)) return false;
  // Links activate natively on Enter; marks/underlines/sups need the click.
  if (active.tagName !== 'A') {
    active.click();
    return true;
  }
  return false;
}

async function showShortcutsHelp(): Promise<void> {
  const { alertDialog } = await import('../dialog/dialog');
  await alertDialog({
    title: 'Keyboard shortcuts',
    message:
      'n or j — next annotation (highlight, hypercite, footnote, citation, link) · ' +
      'p or k — previous annotation · Enter — open it · Tab — cycle the page controls · ' +
      'Escape — close panels. Arrows, Space and PageUp/Down scroll as usual.',
  });
}

export function initContentHopper(): void {
  if (attached) return; // create-once; re-init after SPA nav is a no-op reset
  keydownHandler = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (isAnyModalOpen()) return;
    if ((window as any).isEditing) return;
    if (isTypingContext(e)) return;

    switch (e.key) {
      case 'n':
      case 'j':
        e.preventDefault();
        hop(1);
        break;
      case 'p':
      case 'k':
        e.preventDefault();
        hop(-1);
        break;
      case 'Enter':
        if (activateCurrent()) e.preventDefault();
        break;
      case '?':
        e.preventDefault();
        void showShortcutsHelp();
        break;
    }
  };
  document.addEventListener('keydown', keydownHandler);
  attached = true;
  verbose.init('contentHopper attached', '/components/contentHopper/contentHopper.ts');
}

export function destroyContentHopper(): void {
  if (keydownHandler) {
    document.removeEventListener('keydown', keydownHandler);
    keydownHandler = null;
  }
  attached = false;
  verbose.init('contentHopper destroyed', '/components/contentHopper/contentHopper.ts');
}
