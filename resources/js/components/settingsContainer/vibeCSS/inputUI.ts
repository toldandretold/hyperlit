/**
 * VibeCSS generation UI: the "describe your vibe" text input + the top-up
 * (insufficient balance) screen. Was showVibeInput / showTopUpUI of
 * components/vibeCSS.js.
 */
import { savePreference } from '../../../utilities/preferences.js';
import { submitVibeRequest } from './api';
import {
  applyVibeCSS, clearVibeCSS, hasVibeCSS,
  VIBE_STORAGE_KEY, VIBE_PROMPT_KEY, VIBE_META_KEY,
} from './storage';

/**
 * Show the Top Up UI in a container (insufficient funds).
 * Mirrors brainQuery.js 402 handler pattern.
 */
export function showTopUpUI(container: any, onCancel: any) {
  container.innerHTML = `
    <div class="vibe-query-section">
      <div class="vibe-title">Insufficient Balance</div>
      <p class="vibe-status">Top up your balance to generate a custom theme.</p>
      <div class="vibe-action-row">
        <a href="#" class="vibe-submit-btn vibe-topup-btn">Top Up Balance</a>
        <button type="button" class="vibe-cancel-btn">Cancel</button>
      </div>
    </div>
  `;

  const topUpBtn = container.querySelector('.vibe-topup-btn');
  const cancelBtn = container.querySelector('.vibe-cancel-btn');

  topUpBtn.addEventListener('click', async (e: any) => {
    e.preventDefault();
    try {
      const resp = await fetch('/api/billing/checkout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'X-XSRF-TOKEN': decodeURIComponent(document.cookie.match(/XSRF-TOKEN=([^;]+)/)?.[1] || ''),
        },
        credentials: 'include',
        body: JSON.stringify({ amount: 5, return_url: window.location.href }),
      });
      const d = await resp.json();
      if (d.checkout_url) window.location.href = d.checkout_url;
    } catch (err) {
      console.warn('Vibe: Top-up checkout failed:', err);
    }
  });

  cancelBtn.addEventListener('click', () => onCancel());
}

/**
 * Show the vibe text input UI.
 * @param container - The element to inject UI into
 * @param onComplete - Called after successful generation
 * @param onCancel - Called when user cancels
 */
export function showVibeInput(container: any, onComplete: any, onCancel: any) {
  const hasSaved = hasVibeCSS();

  container.innerHTML = `
    <div class="vibe-query-section">
      <div class="vibe-title">Describe your vibe</div>
      <div class="vibe-text-input" contenteditable="true" data-placeholder="e.g. neon green cyberpunk, warm sunset, ocean breeze..."></div>
      <div class="vibe-action-row">
        <button type="button" class="vibe-submit-btn">Generate</button>
        <button type="button" class="vibe-cancel-btn">Cancel</button>
        ${hasSaved ? '<button type="button" class="vibe-reset-btn">Reset</button>' : ''}
      </div>
      <div class="vibe-status" style="display:none;"></div>
    </div>
  `;

  const section = container.querySelector('.vibe-query-section');
  const textInput = section.querySelector('.vibe-text-input');
  const submitBtn = section.querySelector('.vibe-submit-btn');
  const cancelBtn = section.querySelector('.vibe-cancel-btn');
  const resetBtn = section.querySelector('.vibe-reset-btn');
  const statusEl = section.querySelector('.vibe-status');

  // Placeholder behaviour for contenteditable
  const updatePlaceholder = () => {
    if (!textInput.textContent.trim()) {
      textInput.classList.add('empty');
    } else {
      textInput.classList.remove('empty');
    }
  };
  textInput.classList.add('empty');
  textInput.addEventListener('input', updatePlaceholder);
  textInput.addEventListener('focus', updatePlaceholder);
  textInput.addEventListener('blur', updatePlaceholder);

  // Autofocus (desktop only)
  const isMobile = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  if (!isMobile) {
    setTimeout(() => textInput.focus(), 150);
  }

  // Submit
  submitBtn.addEventListener('click', async () => {
    const promptText = textInput.textContent.trim();
    if (!promptText) return;

    // Disable inputs
    textInput.contentEditable = 'false';
    submitBtn.disabled = true;
    cancelBtn.style.display = 'none';
    if (resetBtn) resetBtn.style.display = 'none';

    // Progressive status
    statusEl.style.display = 'block';
    statusEl.textContent = 'Generating your vibe...';
    const timers: any[] = [];
    timers.push(setTimeout(() => { statusEl.textContent = 'Crafting colour palette...'; }, 2000));
    timers.push(setTimeout(() => { statusEl.textContent = 'Almost there...'; }, 5000));

    try {
      const overrides = await submitVibeRequest(promptText);
      timers.forEach(t => clearTimeout(t));

      // Save to localStorage and backend
      localStorage.setItem(VIBE_STORAGE_KEY, JSON.stringify(overrides));
      localStorage.setItem(VIBE_PROMPT_KEY, promptText);
      localStorage.removeItem(VIBE_META_KEY);
      savePreference('vibe_css', overrides);

      // Apply immediately
      applyVibeCSS();

      onComplete();
    } catch (err: any) {
      timers.forEach(t => clearTimeout(t));

      if (err.status === 401) {
        statusEl.textContent = 'Session expired — please refresh the page.';
      } else if (err.status === 402) {
        // Switch to top-up UI
        showTopUpUI(container, onCancel);
        return;
      } else if (err.status === 504) {
        statusEl.textContent = 'The AI took too long. Please try again.';
      } else {
        statusEl.textContent = err.message || 'Something went wrong. Try again.';
      }

      // Re-enable inputs
      textInput.contentEditable = 'true';
      submitBtn.disabled = false;
      cancelBtn.style.display = '';
      if (resetBtn) resetBtn.style.display = '';
    }
  });

  // Cancel
  cancelBtn.addEventListener('click', () => onCancel());

  // Reset
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      clearVibeCSS();
      onCancel();
    });
  }
}
