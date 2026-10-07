/**
 * A flyout opened by CODE brings its nav column with it.
 *
 * Off the homepage the Account button lives inside #logoNavMenu, which is
 * hidden until the reader clicks the logo. So when something else opens the
 * login panel — a "log in to translate" link, the AI Archivist's auth gate,
 * an access guard — the panel used to appear beside a nav that wasn't showing:
 * no column, no highlighted Account row, and no sign of the path the reader
 * would have taken themselves (logo → Account). openLogoNavMenu() raises the
 * column first; a real click on the row finds it open already and no-ops.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Everything UserContainerManager pulls in for its auth concerns — none of it
// is under test here, and app.ts would drag the whole bootstrap graph in.
vi.mock('../../../resources/js/app', () => ({ book: null }));
vi.mock('../../../resources/js/SPA/navigation/navigationRegistry', () => ({
  navigateByStructure: vi.fn(),
}));
vi.mock('../../../resources/js/utilities/auth/index', () => ({
  getCurrentUser: vi.fn().mockResolvedValue(null),
  getCsrfTokenFromCookie: vi.fn(() => 'test-token'),
}));
vi.mock('../../../resources/js/indexedDB/serverSync/index', () => ({
  syncBookDataFromDatabase: vi.fn(),
}));
vi.mock('../../../resources/js/components/userContainer/forms', () => ({ getErrorHTML: vi.fn(() => '') }));
vi.mock('../../../resources/js/components/userContainer/auth', () => ({
  showLoginForm: vi.fn(), showRegisterForm: vi.fn(), handleLogin: vi.fn(), handleRegister: vi.fn(),
  handleLogout: vi.fn(), performLogoutCleanup: vi.fn(), showLoginError: vi.fn(), showRegisterError: vi.fn(),
}));
vi.mock('../../../resources/js/components/userContainer/email', () => ({
  showVerifyEmailScreen: vi.fn(), showChangeEmailForm: vi.fn(), handleChangeEmail: vi.fn(), handleResendVerification: vi.fn(),
}));
vi.mock('../../../resources/js/components/userContainer/forgotPassword', () => ({
  showForgotPasswordForm: vi.fn(), handleForgotPassword: vi.fn(),
}));
vi.mock('../../../resources/js/components/userContainer/profile', () => ({
  showUserProfile: vi.fn(), attachProfileButtonListeners: vi.fn(),
}));
vi.mock('../../../resources/js/components/userContainer/anonymousTransfer', () => ({
  showAnonymousContentTransfer: vi.fn(),
}));

import { UserContainerManager } from '../../../resources/js/components/userContainer/index';
import { openLogoNavMenu, destroyLogoNav } from '../../../resources/js/components/logoNav/logoNav';

/** The reader-page chrome: Account is a row inside the collapsed nav column. */
function renderNavPage() {
  document.body.innerHTML = `
    <div id="logoNavWrapper">
      <button type="button" id="logoContainer"></button>
      <div id="logoNavMenu" class="logo-nav-menu hidden">
        <div id="userButtonContainer">
          <button type="button" class="menu-row-btn" id="userButton" aria-label="Account"></button>
        </div>
      </div>
    </div>
    <div id="user-container"></div>`;
}

/** The homepage chrome: the Account button stands on its own. */
function renderLooseButtonPage() {
  document.body.innerHTML = '<button id="userButton"></button><div id="user-container"></div>';
}

/** A stand-in with exactly the surface openContainer touches. */
function makeSelf() {
  const container = document.getElementById('user-container');
  const button = document.getElementById('userButton');
  button.getBoundingClientRect = () => ({ top: 90, bottom: 126, left: 10, right: 220 });
  container.getBoundingClientRect = () => ({ top: 90, left: 240, width: 280, height: 310 });

  return {
    container,
    button,
    containerId: 'user-container',
    isAnimating: false,
    isOpen: false,
    updateState: vi.fn(),
    _engageFocusTrap: vi.fn(),
    openContainer: UserContainerManager.prototype.openContainer,
    _clampAnchorToViewport: UserContainerManager.prototype._clampAnchorToViewport,
    _clampIntoViewport: UserContainerManager.prototype._clampIntoViewport,
  };
}

const menu = () => document.getElementById('logoNavMenu');

beforeEach(() => {
  destroyLogoNav(); // the module keeps open/closed state across tests
  document.body.innerHTML = '';
  vi.stubGlobal('innerWidth', 1280);
  vi.stubGlobal('innerHeight', 720);
  vi.stubGlobal('requestAnimationFrame', () => 0); // the open animation is not under test
});

describe('openLogoNavMenu', () => {
  it('raises the column and rotates the logo', () => {
    renderNavPage();

    openLogoNavMenu();

    expect(menu().classList.contains('hidden')).toBe(false);
    expect(document.getElementById('logoContainer').classList.contains('rotated')).toBe(true);
  });

  it('is a no-op when the menu is already open, and when there is no menu at all', () => {
    renderNavPage();
    openLogoNavMenu();
    openLogoNavMenu(); // a second caller must not re-run the open
    expect(menu().classList.contains('hidden')).toBe(false);

    renderLooseButtonPage(); // the homepage: nothing to open, nothing to throw
    expect(() => openLogoNavMenu()).not.toThrow();
  });
});

describe('the login panel brings its nav column with it', () => {
  it('opens the menu and highlights Account when opened from code', () => {
    renderNavPage();
    const self = makeSelf();

    self.openContainer('login');

    expect(menu().classList.contains('hidden')).toBe(false);
    expect(self.button.classList.contains('logo-nav-active')).toBe(true);
    // Anchored out to the right of the column, top-aligned with its row.
    expect(parseFloat(self.container.style.top)).toBe(90);
  });

  it('leaves a loose Account button alone (the homepage has no nav column)', () => {
    renderLooseButtonPage();
    const self = makeSelf();

    self.openContainer('login');

    expect(document.getElementById('logoNavMenu')).toBeNull();
    expect(self.button.classList.contains('logo-nav-active')).toBe(true);
    expect(parseFloat(self.container.style.top)).toBe(134); // rect.bottom + 8
  });
});
