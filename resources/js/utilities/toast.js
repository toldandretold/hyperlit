/**
 * Lightweight, auto-dismissing toast notification.
 * Self-contained — no external CSS dependencies.
 * Pattern follows recoveryToast.js.
 */

const TOAST_ID = 'target-not-found-toast';

export function showTargetNotFoundToast() {
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

  toast.textContent = 'Citation not found';
  document.body.appendChild(toast);

  // Fade in
  requestAnimationFrame(() => { toast.style.opacity = '1'; });

  // Auto-dismiss after 4s
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 250);
  }, 4000);
}
