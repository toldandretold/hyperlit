/**
 * VibeCSS storage + <style> injection (leaf). localStorage read/write + the
 * DIRECT_KEYS → selector mapping that turns a saved overrides object into a
 * <style id="vibe-css-overrides"> block, plus the canvas start/stop hook. Was
 * the storage half of components/vibeCSS.js.
 */
import { clearPreference } from '../../../utilities/preferences.js';

export const VIBE_STORAGE_KEY = 'hyperlit_vibe_css';
export const VIBE_PROMPT_KEY = 'hyperlit_vibe_prompt';
export const VIBE_META_KEY = 'hyperlit_vibe_meta';
const STYLE_ELEMENT_ID = 'vibe-css-overrides';

// Glass panel selector — all containers that use --container-glass-bg
const GLASS_PANELS = '#toc-container, #source-container, #hyperlit-container, #newbook-container, .hyperlit-container-stacked, #user-container';

// Keys applied as direct CSS on specific selectors instead of :root variables.
// Each entry: { selector, property, compound? (extra declarations auto-added) }
const DIRECT_KEYS: any = {
  // Body background
  '--vibe-body-background':            { selector: 'body.theme-vibe', property: 'background' },
  '--vibe-body-background-size':       { selector: 'body.theme-vibe', property: 'background-size' },
  '--vibe-body-background-attachment': { selector: 'body.theme-vibe', property: 'background-attachment' },
  '--vibe-body-animation':             { selector: 'body.theme-vibe', property: 'animation' },

  // Readability strip on text column + header (uniform)
  '--vibe-content-background':         { selector: '.main-content, body.theme-vibe .fixed-header', property: 'background' },
  '--vibe-content-border-radius':      { selector: '.main-content, body.theme-vibe .fixed-header', property: 'border-radius' },
  '--vibe-content-backdrop-filter':    { selector: '.main-content, body.theme-vibe .fixed-header', property: 'backdrop-filter', compound: ['-webkit-backdrop-filter'] },
  '--vibe-content-box-shadow':         { selector: '.main-content, body.theme-vibe .fixed-header', property: 'box-shadow' },

  // Heading effects — gradient text via compound
  '--vibe-heading-background':         { selector: 'body.theme-vibe h1, body.theme-vibe h2, body.theme-vibe h3', property: 'background', compound: ['background-clip: text', '-webkit-background-clip: text', '-webkit-text-fill-color: transparent'] },
  '--vibe-heading-text-shadow':        { selector: 'body.theme-vibe h1, body.theme-vibe h2, body.theme-vibe h3', property: 'text-shadow' },

  // Text and link glow
  '--vibe-text-shadow':                { selector: 'body.theme-vibe .main-content', property: 'text-shadow' },
  '--vibe-link-text-shadow':           { selector: 'body.theme-vibe .main-content a', property: 'text-shadow' },

  // Container glow — borders and shadows on glass panels
  '--vibe-container-border':           { selector: `body.theme-vibe :is(${GLASS_PANELS})`, property: 'border' },
  '--vibe-container-box-shadow':       { selector: `body.theme-vibe :is(${GLASS_PANELS})`, property: 'box-shadow' },
};

/**
 * Read stored overrides from localStorage and inject them into a <style> element.
 */
export function applyVibeCSS() {
  const overrides = getVibeCSS();
  if (!overrides) return;

  // Separate canvas params from CSS overrides
  const canvasParams: any = {};
  const cssOverrides: any = {};
  const CANVAS_PREFIX = '--vibe-canvas-';

  for (const [prop, val] of Object.entries(overrides)) {
    if (prop.startsWith(CANVAS_PREFIX)) {
      canvasParams[prop.slice(CANVAS_PREFIX.length)] = val;
    } else {
      cssOverrides[prop] = val;
    }
  }

  let styleEl = document.getElementById(STYLE_ELEMENT_ID);
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = STYLE_ELEMENT_ID;
    document.head.appendChild(styleEl);
  }

  const varRules: string[] = [];
  // Map of selector → array of CSS declarations
  const selectorMap: any = {};

  for (const [prop, val] of Object.entries(cssOverrides)) {
    const direct = DIRECT_KEYS[prop];
    if (direct) {
      const { selector, property, compound } = direct;
      if (!selectorMap[selector]) selectorMap[selector] = [];
      selectorMap[selector].push(`  ${property}: ${val};`);

      // Compound: extra declarations auto-added when the key is set
      if (compound) {
        for (const extra of compound) {
          if (extra.includes(':')) {
            // Full declaration like "background-clip: text"
            selectorMap[selector].push(`  ${extra};`);
          } else {
            // Property name only — mirror the same value (e.g. -webkit-backdrop-filter)
            selectorMap[selector].push(`  ${extra}: ${val};`);
          }
        }
      }
    } else {
      varRules.push(`  ${prop}: ${val};`);
    }
  }

  let css = '';
  if (varRules.length) {
    css += `:root {\n${varRules.join('\n')}\n}\n`;
  }
  for (const [selector, declarations] of Object.entries(selectorMap)) {
    css += `${selector} {\n${(declarations as string[]).join('\n')}\n}\n`;
  }

  styleEl.textContent = css;

  // Start or stop canvas feedback loop
  if (canvasParams.enabled === '1') {
    import('../vibeCanvas').then(m => m.startVibeCanvas(canvasParams));
  } else {
    import('../vibeCanvas').then(m => m.stopVibeCanvas());
  }
}

/**
 * Remove vibe overrides from the DOM (keeps localStorage).
 */
export function removeVibeCSS() {
  const styleEl = document.getElementById(STYLE_ELEMENT_ID);
  if (styleEl) styleEl.textContent = '';
  import('../vibeCanvas').then(m => m.stopVibeCanvas());
}

/**
 * Clear vibe from both localStorage and DOM. Switches theme to dark.
 */
export function clearVibeCSS() {
  localStorage.removeItem(VIBE_STORAGE_KEY);
  localStorage.removeItem(VIBE_PROMPT_KEY);
  localStorage.removeItem(VIBE_META_KEY);
  clearPreference('vibe_css');
  removeVibeCSS();
  import('../../../utilities/themeSwitcher.js').then(m => m.switchTheme(m.THEMES.DARK));
}

/**
 * Returns stored overrides object or null.
 */
export function getVibeCSS(): any {
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
export function hasVibeCSS(): boolean {
  return getVibeCSS() !== null;
}

/**
 * Returns the stored generation prompt or null.
 */
export function getVibePrompt(): string | null {
  return localStorage.getItem(VIBE_PROMPT_KEY);
}
