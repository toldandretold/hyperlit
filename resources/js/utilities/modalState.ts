/**
 * modalState — zero-import leaf. A global stack of open modal traps.
 *
 * Two consumers:
 *   1. Focus traps (utilities/modalFocusTrap.ts + ContainerManager's trap):
 *      each pushes a token when it engages; only the TOP trap handles
 *      Tab/Escape, so stacked modals (a confirm dialog over the source
 *      container, the visibility panel over its container trap) compose
 *      instead of fighting over the same keydown.
 *   2. The reader content-hopper shortcuts, which must go inert while any
 *      modal is open (isAnyModalOpen).
 *
 * State lives on globalThis (not module scope): the e2e direct-invoke pattern
 * imports raw .ts modules straight from vite, which creates a second module
 * instance — a module-scoped stack would split-brain between it and the
 * bundle's instance.
 */

type ModalToken = symbol;

function stack(): ModalToken[] {
  const g = globalThis as any;
  if (!g.__hyperlitModalStack) g.__hyperlitModalStack = [];
  return g.__hyperlitModalStack;
}

/** Register an opened modal; keep the token to pop and to check topness. */
export function pushModal(): ModalToken {
  const token = Symbol('modal');
  stack().push(token);
  return token;
}

/** Unregister a modal (order-safe: removes wherever it sits in the stack). */
export function popModal(token: ModalToken): void {
  const s = stack();
  const i = s.indexOf(token);
  if (i >= 0) s.splice(i, 1);
}

/** True when this token is the top-most (active) modal. */
export function isTopModal(token: ModalToken): boolean {
  const s = stack();
  return s.length > 0 && s[s.length - 1] === token;
}

/** True when any modal trap is engaged (content shortcuts must go inert). */
export function isAnyModalOpen(): boolean {
  return stack().length > 0;
}
