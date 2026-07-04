/**
 * Passkey / encrypted-books settings panel, rendered inside the user
 * container's profile dropdown (lazy-imported from profile.ts so the eager
 * bundle stays clean). No top-level listeners — everything binds on render
 * inside the container, which is ButtonRegistry-managed.
 */

import { log } from '../../utilities/logger';
import { isVaultUnlocked } from '../keys';
import {
  isPasskeySupported,
  listPasskeys,
  registerPasskey,
  unlockVaultWithPasskey,
  unlockVaultWithRecoveryCode,
  rotateRecoveryCode,
  PrfUnsupportedError,
} from '../passkey';

const BTN =
  'width: 100%; padding: 8px; border-radius: 4px; cursor: pointer; box-sizing: border-box; font-family: inherit; font-size: 12px; margin-bottom: 8px;';
const BTN_PRIMARY = `${BTN} background: var(--color-accent); color: var(--color-background); border: 1px solid var(--color-accent);`;
const BTN_GHOST = `${BTN} background: transparent; color: var(--color-text); border: 1px solid var(--color-text);`;

interface PasskeyPanelHost {
  container: HTMLElement;
  /** Re-render the profile view (back navigation). */
  onBack: () => void;
}

export async function showPasskeySettings(host: PasskeyPanelHost): Promise<void> {
  const { container } = host;

  if (!isPasskeySupported()) {
    container.innerHTML = `
      <div class="user-form">
        <p style="color: var(--color-text); font-size: 13px; line-height: 1.4;">
          This browser doesn't support passkeys, which are required for encrypted books.
        </p>
        <button id="passkeysBack" style="${BTN_GHOST}">Back</button>
      </div>`;
    bindBack(host);
    return;
  }

  container.innerHTML = `
    <div class="user-form">
      <h3 style="color: var(--color-secondary); margin-bottom: 10px; font-size: 14px;">Passkeys &amp; encrypted books</h3>
      <div id="passkeyList" style="margin-bottom: 10px; font-size: 12px; color: var(--color-text);">Loading…</div>
      <div id="passkeyStatus" style="margin-bottom: 10px; font-size: 12px; color: var(--color-secondary);"></div>
      <button id="addPasskeyBtn" style="${BTN_PRIMARY}">Add passkey</button>
      <button id="unlockVaultBtn" style="${BTN_GHOST}; display: none;">Unlock encrypted books</button>
      <button id="recoveryUnlockBtn" style="${BTN_GHOST}; display: none;">Use recovery code</button>
      <button id="rotateRecoveryBtn" style="${BTN_GHOST}; display: none;">New recovery code</button>
      <button id="passkeysBack" style="${BTN_GHOST}">Back</button>
    </div>`;

  bindBack(host);

  const list = container.querySelector('#passkeyList') as HTMLElement;
  const status = container.querySelector('#passkeyStatus') as HTMLElement;
  const addBtn = container.querySelector('#addPasskeyBtn') as HTMLButtonElement;
  const unlockBtn = container.querySelector('#unlockVaultBtn') as HTMLButtonElement;
  const recoveryBtn = container.querySelector('#recoveryUnlockBtn') as HTMLButtonElement;
  const rotateBtn = container.querySelector('#rotateRecoveryBtn') as HTMLButtonElement;

  async function refresh(): Promise<void> {
    try {
      const { passkeys, hasVault } = await listPasskeys();
      list.innerHTML = passkeys.length
        ? passkeys
            .map(
              (p) =>
                `<div style="padding: 4px 0; border-bottom: 1px solid var(--color-border, #333);">
                   ${escapeHtml(p.name || 'Unnamed passkey')}${p.has_vault_key ? ' 🔐' : ''}
                 </div>`,
            )
            .join('')
        : '<em>No passkeys yet. Add one to enable encrypted books.</em>';

      const unlocked = await isVaultUnlocked();
      if (hasVault) {
        status.textContent = unlocked
          ? 'Encrypted books are unlocked on this device.'
          : 'Encrypted books are locked on this device.';
        unlockBtn.style.display = unlocked ? 'none' : 'block';
        recoveryBtn.style.display = unlocked ? 'none' : 'block';
        rotateBtn.style.display = 'block';
      } else {
        status.textContent = passkeys.length
          ? 'Add your first vault-capable passkey to enable encrypted books.'
          : '';
      }
    } catch (error) {
      list.textContent = 'Could not load passkeys.';
      log.error('Failed to load passkeys', '/e2ee/ui/passkeySettings.ts', error);
    }
  }

  addBtn.addEventListener('click', async () => {
    addBtn.disabled = true;
    status.textContent = 'Follow your browser’s passkey prompt…';
    try {
      const result = await registerPasskey();
      if (result.recoveryCode) {
        showRecoveryCodeModal(result.recoveryCode);
        status.textContent = 'Passkey added — encrypted books are now available.';
      } else if (result.needsExistingUnlock) {
        status.textContent =
          'Passkey added. Unlock with an existing passkey once to let this one open your encrypted books.';
      } else {
        status.textContent = 'Passkey added.';
      }
    } catch (error) {
      status.textContent =
        error instanceof PrfUnsupportedError
          ? 'That authenticator can’t power encrypted books (no PRF support). Try a platform passkey (Touch ID, Windows Hello, phone).'
          : error instanceof Error
            ? error.message
            : 'Passkey registration failed.';
    } finally {
      addBtn.disabled = false;
      void refresh();
    }
  });

  unlockBtn.addEventListener('click', async () => {
    unlockBtn.disabled = true;
    try {
      await unlockVaultWithPasskey();
      status.textContent = 'Unlocked.';
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : 'Unlock failed.';
    } finally {
      unlockBtn.disabled = false;
      void refresh();
    }
  });

  recoveryBtn.addEventListener('click', async () => {
    const code = window.prompt('Enter your recovery code (XXXX-XXXX-…):');
    if (!code) return;
    try {
      await unlockVaultWithRecoveryCode(code.trim());
      status.textContent = 'Unlocked with recovery code. Consider adding a new passkey now.';
    } catch {
      status.textContent = 'That recovery code didn’t work.';
    }
    void refresh();
  });

  rotateBtn.addEventListener('click', async () => {
    if (!window.confirm('Generate a NEW recovery code? The old one stops working immediately.')) return;
    rotateBtn.disabled = true;
    status.textContent = 'Confirm with your passkey…';
    try {
      const newCode = await rotateRecoveryCode();
      showRecoveryCodeModal(newCode);
      status.textContent = 'Recovery code replaced — save the new one.';
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : 'Rotation failed.';
    } finally {
      rotateBtn.disabled = false;
    }
  });

  void refresh();
}

function bindBack(host: PasskeyPanelHost): void {
  host.container.querySelector('#passkeysBack')?.addEventListener('click', (e) => {
    e.preventDefault();
    host.onBack();
  });
}

/**
 * Full-screen recovery-code reveal. Shown exactly once, right after first
 * vault setup — the code is never stored anywhere, so the user MUST save it
 * before dismissing.
 */
export function showRecoveryCodeModal(recoveryCode: string): void {
  const overlay = document.createElement('div');
  overlay.id = 'recovery-code-overlay';
  overlay.style.cssText =
    'position: fixed; inset: 0; z-index: 10000; background: rgba(0,0,0,0.75); display: flex; align-items: center; justify-content: center;';
  overlay.innerHTML = `
    <div style="background: var(--color-background, #111); color: var(--color-text, #eee); max-width: 420px; width: 90%; padding: 24px; border-radius: 8px; font-family: inherit;">
      <h3 style="color: var(--color-secondary); margin: 0 0 12px;">Save your recovery code</h3>
      <p style="font-size: 13px; line-height: 1.5;">
        This is the ONLY way to open your encrypted books if you lose every passkey.
        It is shown once and never stored — not even we can recover your books without it.
      </p>
      <code id="recoveryCodeValue" style="display: block; text-align: center; font-size: 16px; letter-spacing: 1px; padding: 12px; margin: 12px 0; background: rgba(255,255,255,0.08); border-radius: 6px; user-select: all;">${escapeHtml(recoveryCode)}</code>
      <button id="copyRecoveryCode" style="${BTN_GHOST}">Copy to clipboard</button>
      <label style="display: flex; gap: 8px; align-items: center; font-size: 12px; margin: 10px 0;">
        <input type="checkbox" id="recoveryCodeSavedCheck" /> I have saved this code somewhere safe
      </label>
      <button id="recoveryCodeDone" style="${BTN_PRIMARY}" disabled>Done</button>
    </div>`;

  const done = overlay.querySelector('#recoveryCodeDone') as HTMLButtonElement;
  const check = overlay.querySelector('#recoveryCodeSavedCheck') as HTMLInputElement;
  check.addEventListener('change', () => {
    done.disabled = !check.checked;
  });
  overlay.querySelector('#copyRecoveryCode')?.addEventListener('click', () => {
    void navigator.clipboard?.writeText(recoveryCode);
  });
  done.addEventListener('click', () => overlay.remove());

  document.body.appendChild(overlay);
}

function escapeHtml(value: string): string {
  const div = document.createElement('div');
  div.textContent = value;
  return div.innerHTML;
}
