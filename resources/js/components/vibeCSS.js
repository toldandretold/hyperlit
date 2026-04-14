/**
 * VibeCSS module — localStorage + <style> injection + API call + vibe UI.
 * Follows containerCustomization.js pattern for style injection.
 */

const VIBE_STORAGE_KEY = 'hyperlit_vibe_css';
const STYLE_ELEMENT_ID = 'vibe-css-overrides';

// Keys that get applied as direct CSS on body.theme-vibe instead of :root variables.
// Allows gradients, animations, etc. that don't work inside CSS variable values.
const BODY_DIRECT_KEYS = {
  '--vibe-body-background': 'background',
  '--vibe-body-background-size': 'background-size',
  '--vibe-body-background-attachment': 'background-attachment',
};

// ─── Storage & injection ───

/**
 * Read stored overrides from localStorage and inject them into a <style> element.
 * Splits overrides into :root variables and direct body.theme-vibe rules.
 */
export function applyVibeCSS() {
  const overrides = getVibeCSS();
  if (!overrides) return;

  let styleEl = document.getElementById(STYLE_ELEMENT_ID);
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = STYLE_ELEMENT_ID;
    document.head.appendChild(styleEl);
  }

  const varRules = [];
  const bodyRules = [];

  for (const [prop, val] of Object.entries(overrides)) {
    if (BODY_DIRECT_KEYS[prop]) {
      bodyRules.push(`  ${BODY_DIRECT_KEYS[prop]}: ${val};`);
    } else {
      varRules.push(`  ${prop}: ${val};`);
    }
  }

  let css = '';
  if (varRules.length) {
    css += `:root {\n${varRules.join('\n')}\n}\n`;
  }
  if (bodyRules.length) {
    css += `body.theme-vibe {\n${bodyRules.join('\n')}\n}\n`;
  }

  styleEl.textContent = css;
}

/**
 * Remove vibe overrides from the DOM (keeps localStorage).
 */
export function removeVibeCSS() {
  const styleEl = document.getElementById(STYLE_ELEMENT_ID);
  if (styleEl) styleEl.textContent = '';
}

/**
 * Clear vibe from both localStorage and DOM. Switches theme to dark.
 */
export function clearVibeCSS() {
  localStorage.removeItem(VIBE_STORAGE_KEY);
  removeVibeCSS();
  import('../utilities/themeSwitcher.js').then(m => m.switchTheme(m.THEMES.DARK));
}

/**
 * Returns stored overrides object or null.
 */
export function getVibeCSS() {
  try {
    const stored = localStorage.getItem(VIBE_STORAGE_KEY);
    return stored ? JSON.parse(stored) : null;
  } catch {
    return null;
  }
}

/**
 * Returns true if a vibe is saved in localStorage.
 */
export function hasVibeCSS() {
  return getVibeCSS() !== null;
}

// ─── API ───

/**
 * POST prompt to backend; returns overrides object on success.
 */
async function submitVibeRequest(prompt) {
  const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content;
  if (!csrfToken) throw new Error('No CSRF token found');

  const response = await fetch('/api/vibe-css/generate', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-TOKEN': csrfToken,
      'Accept': 'application/json',
    },
    body: JSON.stringify({ prompt }),
  });

  const data = await response.json();

  if (!response.ok) {
    const err = new Error(data.message || 'Vibe generation failed');
    err.status = response.status;
    err.data = data;
    throw err;
  }

  return data.overrides;
}

/**
 * Lightweight balance pre-check.
 */
async function checkBalance() {
  const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content;
  try {
    const response = await fetch('/api/vibe-css/can-proceed', {
      headers: {
        'Accept': 'application/json',
        'X-CSRF-TOKEN': csrfToken || '',
      },
    });
    if (!response.ok) return false;
    const data = await response.json();
    return data.canProceed === true;
  } catch {
    return false;
  }
}

// ─── UI ───

/**
 * Show the Top Up UI in a container (insufficient funds).
 * Mirrors brainQuery.js 402 handler pattern.
 */
export function showTopUpUI(container, onCancel) {
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

  topUpBtn.addEventListener('click', async (e) => {
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
 * @param {HTMLElement} container - The element to inject UI into
 * @param {Function} onComplete - Called after successful generation
 * @param {Function} onCancel - Called when user cancels
 */
export function showVibeInput(container, onComplete, onCancel) {
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
    const prompt = textInput.textContent.trim();
    if (!prompt) return;

    // Disable inputs
    textInput.contentEditable = 'false';
    submitBtn.disabled = true;
    cancelBtn.style.display = 'none';
    if (resetBtn) resetBtn.style.display = 'none';

    // Progressive status
    statusEl.style.display = 'block';
    statusEl.textContent = 'Generating your vibe...';
    const timers = [];
    timers.push(setTimeout(() => { statusEl.textContent = 'Crafting colour palette...'; }, 2000));
    timers.push(setTimeout(() => { statusEl.textContent = 'Almost there...'; }, 5000));

    try {
      const overrides = await submitVibeRequest(prompt);
      timers.forEach(t => clearTimeout(t));

      // Save to localStorage
      localStorage.setItem(VIBE_STORAGE_KEY, JSON.stringify(overrides));

      // Apply immediately
      applyVibeCSS();

      onComplete();
    } catch (err) {
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
