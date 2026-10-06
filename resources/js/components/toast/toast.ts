/**
 * Lightweight, auto-dismissing toast notification.
 * Self-contained — no external CSS dependencies.
 * Pattern follows recoveryToast.js.
 */

const TOAST_ID = 'target-not-found-toast';
const TRANSLATION_TOAST_ID = 'translation-blocked-toast';

/** Build, show and auto-dismiss one toast. One toast per id at a time. */
function renderToast(id: string, message: string, dismissAfterMs = 4000, maxWidth?: string) {
  // Prevent duplicates
  const existing = document.getElementById(id);
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.id = id;
  Object.assign(toast.style, {
    position: 'fixed',
    bottom: '24px',
    left: '50%',
    transform: 'translateX(-50%)',
    background: '#1a1a2e',
    color: '#e0e0e0',
    padding: '10px 20px',
    borderRadius: '8px',
    fontSize: '14px',
    fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
    zIndex: '99999',
    boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
    opacity: '0',
    transition: 'opacity 0.25s ease',
    ...(maxWidth ? { maxWidth, textAlign: 'center', lineHeight: '1.4' } : {}),
  });

  toast.textContent = message;
  document.body.appendChild(toast);

  // Fade in
  requestAnimationFrame(() => { toast.style.opacity = '1'; });

  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 250);
  }, dismissAfterMs);
}

/**
 * @param {{ target?: string, fallbackUsed?: string|null }} [context]
 */
export function showTargetNotFoundToast(context = {}) {
  renderToast(TOAST_ID, getToastMessage(context));
}

/**
 * An annotation write was refused because a browser translator has rewritten
 * the page's text.
 *
 * Highlights and hypercites are stored as CHARACTER OFFSETS into a node's text,
 * so a selection measured against translated prose points at the wrong span of
 * the real content — the mark would reappear around different words once
 * translation is off. Refusing is the only correct answer, but it has to be
 * explained: the user just dragged a selection and pressed a button, and a
 * silent no-op reads as a broken feature rather than a protected one.
 *
 * Longer dwell than the default toast because there is an instruction in it.
 */
export function showTranslationBlockedToast(action = 'change highlights') {
  renderToast(
    TRANSLATION_TOAST_ID,
    `Your browser is translating this page, so highlight positions wouldn't match the real text. Turn translation off and reload to ${action}.`,
    7000,
    '420px',
  );
}

function getToastMessage({ target, fallbackUsed }: any = {}) {
  if (fallbackUsed === 'saved_position') {
    return target
      ? `Couldn't find '${truncate(target, 30)}' — showing your last reading position`
      : 'Showing your last reading position';
  }
  if (fallbackUsed === 'lowest_chunk') {
    return target
      ? `Couldn't find '${truncate(target, 30)}' — showing start of book`
      : 'Showing start of book';
  }
  return 'Citation not found';
}

function truncate(str: any, maxLen: any) {
  return str.length > maxLen ? str.slice(0, maxLen) + '...' : str;
}
