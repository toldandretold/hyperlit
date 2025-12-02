/**
 * Theme Switcher Utility
 * Handles theme switching via body class instead of CSS imports
 */

const THEME_STORAGE_KEY = 'hyperlit_theme_preference';
const THEMES = {
  DARK: 'dark',
  LIGHT: 'light',
  SEPIA: 'sepia'
};

// Single source of truth for current theme
let currentTheme = THEMES.DARK;

/**
 * Get the current active theme
 * @returns {string} Current theme name
 */
export function getCurrentTheme() {
  return currentTheme;
}

/**
 * Apply theme by setting body class
 * @param {string} themeName - Theme name ('dark', 'light', or 'sepia')
 */
function applyThemeClass(themeName) {
  const body = document.body;

  // Remove all theme classes
  body.classList.remove('theme-dark', 'theme-light', 'theme-sepia');

  // Add the new theme class
  body.classList.add(`theme-${themeName}`);

  console.log(`🎨 Applied theme class: theme-${themeName}`);
}

/**
 * Switch to a specific theme
 * @param {string} theme - Theme to switch to ('dark', 'light', or 'sepia')
 */
export function switchTheme(theme) {
  console.log(`🎨 Switching to ${theme} theme`);

  // Validate theme
  if (!Object.values(THEMES).includes(theme)) {
    console.warn(`Unknown theme: ${theme}`);
    return;
  }

  // Update state
  currentTheme = theme;

  // Apply theme class to body
  applyThemeClass(theme);

  // Save preference to localStorage
  localStorage.setItem(THEME_STORAGE_KEY, theme);

  // Dispatch custom event so other components can react
  window.dispatchEvent(new CustomEvent('themechange', { detail: { theme } }));
}

/**
 * Initialize theme from localStorage on page load
 */
export function initializeTheme() {
  const savedTheme = localStorage.getItem(THEME_STORAGE_KEY);

  if (savedTheme && Object.values(THEMES).includes(savedTheme)) {
    console.log(`🎨 Restoring saved theme: ${savedTheme}`);
    currentTheme = savedTheme;
    applyThemeClass(savedTheme);
  } else {
    console.log(`🎨 Using default dark theme`);
    currentTheme = THEMES.DARK;
    applyThemeClass(THEMES.DARK);
  }

  return currentTheme;
}

export { THEMES };
