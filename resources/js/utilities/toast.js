/**
 * Lightweight, auto-dismissing toast notification.
 * Self-contained — no external CSS dependencies.
 * Pattern follows recoveryToast.js.
 */

const TOAST_ID = 'target-not-found-toast';

/**
 * @param {{ target?: string, fallbackUsed?: string|null }} [context]
 */
export function showTargetNotFoundToast(context = {}) {
  // Prevent duplicates
  const existing = document.getElementById(TOAST_ID);
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.id = TOAST_ID;
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
  });

  toast.textContent = getToastMessage(context);
  document.body.appendChild(toast);

  // Fade in
  requestAnimationFrame(() => { toast.style.opacity = '1'; });

  // Auto-dismiss after 4s
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 250);
  }, 4000);
}

function getToastMessage({ target, fallbackUsed } = {}) {
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

function truncate(str, maxLen) {
  return str.length > maxLen ? str.slice(0, maxLen) + '...' : str;
}
