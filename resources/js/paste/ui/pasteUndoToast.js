/**
 * Lightweight toast for large-paste undo.
 * Self-contained — no external CSS dependencies.
 * Follows the recoveryToast.js pattern (dark theme, fixed bottom-center).
 */

const TOAST_ID = 'paste-undo-toast';
let autoDismissTimer = null;

export function showPasteUndoToast(onUndo) {
  // Remove previous toast if any (only one at a time)
  hidePasteUndoToast();

  const toast = document.createElement('div');
  toast.id = TOAST_ID;
  Object.assign(toast.style, {
    position: 'fixed',
    bottom: '16px',
    left: '50%',
    transform: 'translateX(-50%)',
    background: '#1a1a2e',
    color: '#e0e0e0',
    padding: '10px 16px',
    borderRadius: '8px',
    fontSize: '14px',
    fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    zIndex: '99999',
    boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
    opacity: '0',
    transition: 'opacity 0.2s ease',
  });

  const text = document.createElement('span');
  text.textContent = 'Large paste completed.';

  const btn = document.createElement('button');
  btn.textContent = 'Undo';
  Object.assign(btn.style, {
    background: '#4a4a6a',
    color: '#fff',
    border: 'none',
    padding: '4px 12px',
    borderRadius: '4px',
    fontSize: '13px',
    cursor: 'pointer',
    flexShrink: '0',
  });
  btn.addEventListener('click', () => {
    hidePasteUndoToast();
    if (onUndo) onUndo();
  });

  toast.appendChild(text);
  toast.appendChild(btn);
  document.body.appendChild(toast);

  // Trigger fade-in on next frame
  requestAnimationFrame(() => { toast.style.opacity = '1'; });

  // Auto-dismiss after 10 seconds
  autoDismissTimer = setTimeout(() => {
    hidePasteUndoToast();
  }, 10000);
}

export function hidePasteUndoToast() {
  if (autoDismissTimer) {
    clearTimeout(autoDismissTimer);
    autoDismissTimer = null;
  }
  const toast = document.getElementById(TOAST_ID);
  if (!toast) return;
  toast.style.opacity = '0';
  setTimeout(() => toast.remove(), 200);
}
