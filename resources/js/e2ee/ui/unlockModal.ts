/**
 * Unlock modal (docs/e2ee.md): blocks an encrypted book's open until the
 * vault is unlocked with a passkey (or the recovery code). Created on demand
 * by the reader open-gate — no top-level listeners, so no registry entry.
 */

import { unlockVaultWithPasskey, unlockVaultWithRecoveryCode, PasskeyError } from '../passkey';

const BTN =
  'width: 100%; padding: 10px; border-radius: 6px; cursor: pointer; box-sizing: border-box; font-family: inherit; font-size: 14px; margin-bottom: 10px;';

let activeModal: Promise<void> | null = null;

/** Resolves when the vault unlocks; rejects if the user dismisses. Singleton per page. */
export function showUnlockModal(): Promise<void> {
  if (activeModal) return activeModal;

  activeModal = new Promise<void>((resolve, reject) => {
    const overlay = document.createElement('div');
    overlay.id = 'e2ee-unlock-overlay';
    overlay.style.cssText =
      'position: fixed; inset: 0; z-index: 10000; background: rgba(0,0,0,0.8); display: flex; align-items: center; justify-content: center;';
    overlay.innerHTML = `
      <div style="background: var(--color-background, #111); color: var(--color-text, #eee); max-width: 380px; width: 90%; padding: 24px; border-radius: 10px; font-family: inherit; text-align: center;">
        <div style="font-size: 34px; margin-bottom: 8px;">🔐</div>
        <h3 style="color: var(--color-secondary); margin: 0 0 8px;">This book is encrypted</h3>
        <p style="font-size: 13px; line-height: 1.5; margin-bottom: 16px;">
          Unlock with your passkey to read and edit it on this device.
        </p>
        <button id="e2eeUnlockPasskey" style="${BTN} background: var(--color-accent); color: var(--color-background); border: 1px solid var(--color-accent);">
          Unlock with passkey
        </button>
        <button id="e2eeUnlockRecovery" style="${BTN} background: transparent; color: var(--color-text); border: 1px solid var(--color-text);">
          Use recovery code
        </button>
        <button id="e2eeUnlockCancel" style="${BTN} background: transparent; color: var(--color-text); border: none; margin-bottom: 0;">
          Cancel
        </button>
        <p id="e2eeUnlockError" style="color: #e06c75; font-size: 12px; min-height: 1em; margin: 8px 0 0;"></p>
      </div>`;

    const errorLine = () => overlay.querySelector('#e2eeUnlockError') as HTMLElement;
    const finish = (ok: boolean, error?: unknown) => {
      overlay.remove();
      activeModal = null;
      if (ok) resolve();
      else reject(error instanceof Error ? error : new Error('Unlock cancelled'));
    };

    overlay.querySelector('#e2eeUnlockPasskey')?.addEventListener('click', async () => {
      errorLine().textContent = '';
      try {
        await unlockVaultWithPasskey();
        finish(true);
      } catch (error) {
        errorLine().textContent =
          error instanceof PasskeyError ? error.message : 'Unlock failed — try again.';
      }
    });

    overlay.querySelector('#e2eeUnlockRecovery')?.addEventListener('click', async () => {
      const code = window.prompt('Enter your recovery code (XXXX-XXXX-…):');
      if (!code) return;
      errorLine().textContent = '';
      try {
        await unlockVaultWithRecoveryCode(code.trim());
        finish(true);
      } catch {
        errorLine().textContent = 'That recovery code didn’t work.';
      }
    });

    overlay.querySelector('#e2eeUnlockCancel')?.addEventListener('click', () => finish(false));

    document.body.appendChild(overlay);
  });

  return activeModal;
}
