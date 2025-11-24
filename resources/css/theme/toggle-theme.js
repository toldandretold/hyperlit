/**
 * Theme Toggle Helper
 * Paste this in browser console to test light/dark theme switching
 */

// Toggle between dark and light theme
function toggleTheme() {
  const existingLight = document.querySelector('link[href*="light-theme"]');

  if (existingLight) {
    existingLight.remove();
    console.log('🌙 Switched to DARK theme');
  } else {
    // You'll need to update this path based on your Vite build output
    // Check /build/manifest.json to find the actual hashed filename
    const link = document.createElement('link');
    link.rel = 'stylesheet';

    // Try to load from build assets (production)
    link.href = '/build/assets/light-theme.css';

    // Fallback to direct path (if not hashed)
    link.onerror = () => {
      console.warn('Could not load from /build/assets/, trying direct path');
      link.href = '/css/theme/light-theme.css';
    };

    document.head.appendChild(link);
    console.log('☀️ Switched to LIGHT theme');
  }
}

// Run it
toggleTheme();

// Also expose globally for easy toggling
window.toggleTheme = toggleTheme;
console.log('💡 Theme toggler loaded! Call toggleTheme() to switch themes');
