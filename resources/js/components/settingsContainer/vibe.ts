// Vibe-theme entry points for the settings panel: the vibe button handler and
// the gallery / generation sub-panels (which replace the settings panel's inner
// HTML, then restore it). Was handleVibeClick / _openVibeGallery / _openVibeUI of
// settingsContainer.js. Takes the SettingsContainerManager as `self`.
import { hasVibeCSS, showVibeGallery, showVibeInput } from './vibeCSS';
import { switchTheme, getCurrentTheme, THEMES } from '../../utilities/themeSwitcher.js';
import { isLoggedIn } from '../../utilities/auth.js';

/**
 * Handle vibe button click.
 * - Saved + not active theme: apply vibe instantly + open gallery
 * - Otherwise: open gallery
 */
export async function handleVibeClick(self: any) {
  const saved = hasVibeCSS();
  const currentTheme = getCurrentTheme();

  if (saved && currentTheme !== THEMES.VIBE) {
    // Apply the saved vibe, then show the gallery
    switchTheme(THEMES.VIBE);
  }

  // Always open the gallery
  self._openVibeGallery();
}

/**
 * Replace settings panel content with vibe gallery.
 */
export async function _openVibeGallery(self: any) {
  const container = document.getElementById('settings-container');
  if (!container) return;

  const savedHTML = container.innerHTML;

  const restorePanel = () => {
    container.innerHTML = savedHTML;
    self.syncSliderUI();
    self.updateButtonStates();
  };

  const loggedIn = await isLoggedIn();

  showVibeGallery(container, loggedIn, {
    onApply: () => {
      restorePanel();
      switchTheme(THEMES.VIBE);
      self.updateButtonStates();
      self.closeContainer();
    },
    onClose: restorePanel,
    onGenerate: () => {
      self._openVibeUI(savedHTML);
    },
  });
}

/**
 * Replace settings panel content with vibe generation input UI.
 * @param fallbackHTML - HTML to restore on cancel (if called from gallery, use gallery's savedHTML)
 */
export async function _openVibeUI(self: any, fallbackHTML?: any) {
  const container = document.getElementById('settings-container');
  if (!container) return;

  const savedHTML = fallbackHTML || container.innerHTML;

  showVibeInput(
    container,
    // onComplete
    () => {
      container.innerHTML = savedHTML;
      self.syncSliderUI();
      switchTheme(THEMES.VIBE);
      self.updateButtonStates();
      self.closeContainer();
    },
    // onCancel — go back to gallery if we came from there, else restore settings
    () => {
      if (fallbackHTML) {
        // Came from gallery — re-open gallery
        self._openVibeGallery();
      } else {
        container.innerHTML = savedHTML;
        self.syncSliderUI();
        self.updateButtonStates();
      }
    }
  );
}
