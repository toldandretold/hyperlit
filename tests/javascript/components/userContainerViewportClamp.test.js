/**
 * The #user-container flyout must never open outside the viewport.
 *
 * openContainer() anchors the panel ONCE, from `#userButton`'s rect, and
 * nothing repositions it afterwards. That rect is only trustworthy once the
 * page's CSS has applied — before it, the corner buttons are still in normal
 * document flow, and a rect read in that window puts the panel hundreds of
 * pixels down the page. The panel then stays there: `position: fixed`, so no
 * amount of scrolling reaches it, `visibility: visible`, so it looks perfectly
 * healthy, and focus-trapped, so the keyboard is captured by a surface nobody
 * can see. Real cost: a logged-out visitor whose login panel opens below the
 * fold has no way to sign in; in e2e it was 300 seconds of Playwright retrying
 * "Switch to Register" at y=1217 and then a bare "Test timeout exceeded"
 * (workflows/notifications.spec.js, 2026-09-30).
 *
 * Two clamps, because the panel's height only exists after it has laid out:
 * _clampAnchorToViewport bounds the anchor at open time (pre-measurement), and
 * _clampIntoViewport fits the measured box once the open animation settles.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Everything the module pulls in for its auth concerns — none of it is under
// test here, and app.ts would drag the whole bootstrap graph in.
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

const VIEWPORT = { width: 1280, height: 720 };
const PANEL = { width: 280, height: 310 }; // the login form at its settled size

/** A stand-in with exactly the surface openContainer touches. */
function makeSelf({ buttonRect }) {
  document.body.innerHTML = '<button id="userButton"></button><div id="user-container"></div>';
  const container = document.getElementById('user-container');
  const button = document.getElementById('userButton');

  button.getBoundingClientRect = () => buttonRect;
  // The panel only has a box once it is open and laid out; before that the
  // measuring clamp must decline to act rather than clamp against zeros.
  container.getBoundingClientRect = () => ({
    x: parseFloat(container.style.left) || 0,
    y: parseFloat(container.style.top) || 0,
    left: parseFloat(container.style.left) || 0,
    top: parseFloat(container.style.top) || 0,
    width: self.laidOut ? PANEL.width : 0,
    height: self.laidOut ? PANEL.height : 0,
  });

  const self = {
    container,
    button,
    containerId: 'user-container',
    isAnimating: false,
    isOpen: false,
    laidOut: false,
    updateState: vi.fn(),
    _engageFocusTrap: vi.fn(),
    openContainer: UserContainerManager.prototype.openContainer,
    _clampAnchorToViewport: UserContainerManager.prototype._clampAnchorToViewport,
    _clampIntoViewport: UserContainerManager.prototype._clampIntoViewport,
  };
  return self;
}

/** Open, then let the panel settle at its real size and re-clamp (transitionend). */
function openAndSettle(self, mode = 'login') {
  self.openContainer(mode);
  self.laidOut = true;
  self._clampIntoViewport();
  return {
    top: parseFloat(self.container.style.top),
    left: parseFloat(self.container.style.left),
  };
}

beforeEach(() => {
  vi.stubGlobal('innerWidth', VIEWPORT.width);
  vi.stubGlobal('innerHeight', VIEWPORT.height);
  vi.stubGlobal('requestAnimationFrame', () => 0); // the open animation is not under test
});

describe('#user-container opens inside the viewport', () => {
  it('anchors under the trigger when the trigger is where CSS puts it', () => {
    // The corner button: fixed, 10px from the top. Nothing to clamp.
    const self = makeSelf({ buttonRect: { top: 10, bottom: 46, left: 234, right: 270 } });

    const { top, left } = openAndSettle(self);

    expect(top).toBe(54); // rect.bottom + 8
    expect(left).toBe(234);
  });

  it('pulls the panel back on screen when the trigger rect is below the fold', () => {
    // The pre-CSS layout: #userButtonContainer still in normal flow, far down
    // the unstyled page. Unclamped this produced top: 1208px.
    const self = makeSelf({ buttonRect: { top: 1164, bottom: 1200, left: 8, right: 44 } });

    const { top } = openAndSettle(self);

    expect(top).toBeGreaterThanOrEqual(8);
    expect(top + PANEL.height).toBeLessThanOrEqual(VIEWPORT.height);
  });

  it('keeps the whole panel on screen when it does not fit below its trigger', () => {
    // A legitimately-placed trigger low in a short viewport: the panel has to
    // rise, or its lower half (Switch to Register / Forgot password) is lost.
    const self = makeSelf({ buttonRect: { top: 600, bottom: 636, left: 20, right: 56 } });

    const { top } = openAndSettle(self);

    expect(top + PANEL.height).toBeLessThanOrEqual(VIEWPORT.height);
    expect(top).toBeGreaterThanOrEqual(8);
  });

  it('keeps the panel inside the right edge when the trigger is in the corner', () => {
    const self = makeSelf({ buttonRect: { top: 10, bottom: 46, left: 1240, right: 1276 } });

    const { left } = openAndSettle(self);

    expect(left + PANEL.width).toBeLessThanOrEqual(VIEWPORT.width);
    expect(left).toBeGreaterThanOrEqual(8);
  });

  it('never clamps the panel off the TOP — a tall panel clips at the bottom instead', () => {
    // Taller than the viewport: there is no fit, and losing the heading/inputs
    // at the top is worse than losing the tail.
    const self = makeSelf({ buttonRect: { top: 400, bottom: 436, left: 40, right: 76 } });
    self.openContainer('login');
    self.laidOut = true;
    self.container.getBoundingClientRect = () => ({
      top: parseFloat(self.container.style.top) || 0,
      left: parseFloat(self.container.style.left) || 0,
      width: PANEL.width,
      height: VIEWPORT.height + 200,
    });
    self._clampIntoViewport();

    expect(parseFloat(self.container.style.top)).toBe(8);
  });

  it('does not touch a panel that has no trigger (centred with a transform)', () => {
    const self = makeSelf({ buttonRect: { top: 0, bottom: 0, left: 0, right: 0 } });
    self.button = null;

    self.openContainer('login');
    self.laidOut = true;
    self._clampIntoViewport();

    expect(self.container.style.top).toBe('50%');
    expect(self.container.style.left).toBe('50%');
    expect(self.container.style.transform).toBe('translate(-50%, -50%)');
  });
});
