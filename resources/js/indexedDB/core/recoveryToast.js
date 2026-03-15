/**
 * Lightweight toast for IDB recovery notifications on iOS bfcache restore.
 * Self-contained — no external CSS dependencies.
 */

const TOAST_ID = 'idb-recovery-toast';

export function showIDBRecoveryToast() {
  // Prevent duplicates
  if (document.getElementById(TOAST_ID)) return;

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
  text.dataset.role = 'message';
  text.textContent = 'Reconnecting database...';

  const btn = document.createElement('button');
  btn.textContent = 'Refresh';
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
  btn.addEventListener('click', () => window.location.reload());

  toast.appendChild(text);
  toast.appendChild(btn);
  document.body.appendChild(toast);

  // Trigger fade-in on next frame
  requestAnimationFrame(() => { toast.style.opacity = '1'; });
}

export function updateIDBRecoveryToast(message) {
  const toast = document.getElementById(TOAST_ID);
  if (!toast) return;
  const text = toast.querySelector('[data-role="message"]');
  if (text) text.textContent = message;
}

export function hideIDBRecoveryToast() {
  const toast = document.getElementById(TOAST_ID);
  if (!toast) return;
  toast.style.opacity = '0';
  setTimeout(() => toast.remove(), 200);
}
