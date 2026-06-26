/**
 * Source-access button helpers (zero-import leaf).
 *
 * Shared presentation for the "open the cited source" buttons across the three citation
 * surfaces — plain citations (`buildCitationContent`), inbound hypercite citations
 * (`buildHyperciteCitationContent`), and the cited-by list (`buildHyperciteContent`).
 *
 * Centralises the red lock / trash icons, the muted "pending" button styling used while
 * an access check is in flight, and the post-open DOM mutations that either lock or enable
 * the button once visibility/access is known. NO imports — keeps it cycle-safe.
 */

/** Red padlock SVG for private/inaccessible sources. `extraStyle` appends inline style. */
export function privateLockIcon(extraStyle: string = ''): string {
  return `<svg class="private-lock-icon" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#d73a49" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display: inline-block; vertical-align: text-bottom; margin-right: 4px; transition: transform 0.2s ease;${extraStyle ? ' ' + extraStyle : ''}"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>`;
}

/** Red trash SVG for deleted sources. */
export function deletedTrashIcon(extraStyle: string = ''): string {
  return `<svg class="deleted-icon" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#d73a49" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display: inline-block; vertical-align: text-bottom; margin-right: 4px;${extraStyle ? ' ' + extraStyle : ''}"><path d="M3 6h18"></path><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>`;
}

/** Inline-style suffix for a button muted while its access check is pending. */
export const MUTED_BTN_STYLE = ' opacity: 0.5; pointer-events: none;';

/** Spinner appended to a pending button's label. */
export const BTN_SPINNER_HTML = ' <span class="btn-spinner"></span>';

/**
 * Lock a button post-open: dim it, block clicks, mark denied, swap its visible text, and
 * prepend an icon (lock/trash) immediately before the button so the marker sits with it.
 */
export function lockButtonEl(btn: any, text: string, iconHtml: string = ''): void {
  if (!btn) return;
  btn.style.opacity = '0.6';
  btn.style.cursor = 'not-allowed';
  btn.style.pointerEvents = 'none';
  btn.setAttribute('data-access', 'denied');

  const spinner = btn.querySelector('.btn-spinner');
  if (spinner) spinner.remove();

  // Replace the first non-empty text node (preserves trailing icons like the ↗ open-icon).
  let replaced = false;
  btn.childNodes.forEach((node: any) => {
    if (!replaced && node.nodeType === Node.TEXT_NODE && node.textContent.trim()) {
      node.textContent = text;
      replaced = true;
    }
  });
  if (!replaced) btn.insertBefore(document.createTextNode(text), btn.firstChild);

  if (iconHtml && !btn.parentElement?.querySelector('.private-lock-icon, .deleted-icon')) {
    btn.insertAdjacentHTML('beforebegin', iconHtml);
  }
}

/** Enable a previously-muted button post-open: restore interactivity, drop the spinner. */
export function enableButtonEl(btn: any): void {
  if (!btn) return;
  btn.style.opacity = '';
  btn.style.pointerEvents = '';
  btn.style.cursor = '';
  const spinner = btn.querySelector('.btn-spinner');
  if (spinner) spinner.remove();
}
