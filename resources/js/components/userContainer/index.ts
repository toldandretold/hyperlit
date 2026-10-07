// UserContainerManager — coordinator for the #user-container auth panel opened
// by #userButton. Owns the lifecycle (open/close/animation), the
// document-delegated click router, and small helpers inline; delegates each
// auth concern (login/register/logout, email, forgot-password, profile,
// anonymous-transfer) to its sibling module via the self-as-first-arg pattern.
// The class is the single dispatch hub, so peer calls (self.*) resolve back
// here. The #userButton CLICK is wired by the base ContainerManager
// (rebindElements), not here. Registry lifecycle + the default-export singleton
// live in ../userButton/userButton.
import { ContainerManager } from "../utilities/containerManager";
import { openLogoNavMenu } from "../logoNav/logoNav";
import { navigateByStructure } from '../../SPA/navigation/navigationRegistry';
import { book } from "../../app";
import { getCurrentUser, getCsrfTokenFromCookie } from "../../utilities/auth/index";
import { syncBookDataFromDatabase } from "../../indexedDB/serverSync/index";
import { getErrorHTML } from "./forms";
import { showLoginForm, showRegisterForm, handleLogin, handleRegister, handleLogout, performLogoutCleanup, showLoginError, showRegisterError } from "./auth";
import { showVerifyEmailScreen, showChangeEmailForm, handleChangeEmail, handleResendVerification } from "./email";
import { showForgotPasswordForm, handleForgotPassword } from "./forgotPassword";
import { showUserProfile, attachProfileButtonListeners } from "./profile";
import { showAnonymousContentTransfer } from "./anonymousTransfer";

export class UserContainerManager extends (ContainerManager as any) {
  constructor(containerId: any, overlayId: any, buttonId: any, frozenContainerIds: any = []) {
    super(containerId, overlayId, buttonId, frozenContainerIds);

    this.setupUserContainerStyles();
    this.isAnimating = false;
    this.button = document.getElementById(buttonId);
    this.boundClickHandler = this.handleDocumentClick.bind(this);
    this.setupUserListeners();
    this.user = null;

    this.initializeUser();
  }

  setPostLoginAction(action: any) {
    this.postLoginAction = action;
  }

  async initializeUser() {
    const user = await getCurrentUser();
    if (user) {
      this.user = user;
      this.updateButtonColor();
    }

    // Check for email verification success redirect
    const params = new URLSearchParams(window.location.search);
    if (params.get('verified') === '1') {
      window.history.replaceState({}, '', window.location.pathname);
      this.showVerifiedToast();
    }
  }

  showVerifiedToast() {
    const toast = document.createElement('div');
    toast.textContent = 'Email verified successfully!';
    toast.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);background:#4EACAE;color:#fff;padding:12px 24px;border-radius:8px;font-family:inherit;font-size:14px;font-weight:600;z-index:10000;opacity:0;transition:opacity 0.3s;';
    document.body.appendChild(toast);
    requestAnimationFrame(() => { toast.style.opacity = '1'; });
    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 300);
    }, 4000);
  }

  updateButtonColor() {
    const userLogo = document.getElementById('userLogo') as any;
    if (!userLogo) return;
    userLogo.style.fill = '';
    // Logged-in (re)bind is also when the Account button can carry the unread
    // pink dot — refresh it here so rebinds stay correct (lazy: keeps the
    // notifications module out of the eager path).
    void import('../notificationsOverlay/notificationsOverlay')
      .then(({ refreshNotificationsBadge }) => refreshNotificationsBadge())
      .catch(() => {});
  }

  setupUserContainerStyles() {
    const container = this.container;
    if (!container) return;

    container.style.position = "fixed";
    container.style.transition =
      "width 0.3s ease-out, height 0.3s ease-out, opacity 0.3s ease-out, padding 0.3s ease-out";
    // Above the logo nav (1002): when a narrow viewport clamps this flyout
    // left over the nav column, the panel is the TOP of the stack.
    container.style.zIndex = "1003";
    // Subtle edge drop-shadow only. The old page-dimming "spotlight" (0 0 0 250vmax) is gone:
    // this panel is now a start-menu-style glass flyout beside the logo nav, and the page
    // behind it stays live and undimmed. Inline (not CSS) because this panel sets all its
    // visual state inline, and an inline box-shadow overrides the stylesheet.
    container.style.boxShadow = "0 0 15px rgba(0, 0, 0, 0.2)";
    container.style.borderRadius = "10px"; /* match the logo-nav glass pill */
    container.style.opacity = "0";
    container.style.padding = "12px";
    container.style.width = "0";
    container.style.height = "0";
  }

  setupUserListeners() {
    document.addEventListener("click", this.boundClickHandler);
  }

  destroy() {
    document.removeEventListener("click", this.boundClickHandler);
  }

  handleDocumentClick(e: any) {
    const isInUserContainer = e.target.closest('#user-container');
    const isUserOverlay = e.target.closest('#user-overlay');
    const isInCustomAlert = e.target.closest('.custom-alert');

    if (!isInUserContainer && !isUserOverlay && !isInCustomAlert) {
      return;
    }

    // Click handler mapping for cleaner code
    const handlers: any = {
      '#loginSubmit': () => this.handleLogin(),
      '#registerSubmit': () => this.handleRegister(),
      '#showRegister': () => this.showRegisterForm(),
      '#showLogin': () => this.showLoginForm(),
      '#showForgotPassword': () => this.showForgotPasswordForm(),
      '#forgotPasswordSubmit': () => this.handleForgotPassword(),
      '#backToLogin': () => this.showLoginForm(),
      '#logout': () => this.handleLogout(),
      '#myBooksBtn': () => this.handleMyBooksClick(),
      '#verifyEmailBtn': () => this.showVerifyEmailScreen(),
      '#resendVerification': () => this.handleResendVerification(),
      '#changeEmailBtn': () => this.showChangeEmailForm(),
      '#changeEmailSubmit': () => this.handleChangeEmail(),
      '#backToVerify': () => this.showVerifyEmailScreen(),
      '#dismissVerification': () => this.proceedAfterLogin(),
    };

    for (const [selector, handler] of Object.entries(handlers)) {
      if (e.target.closest(selector)) {
        e.preventDefault();
        (handler as any)();
        return;
      }
    }

    if (e.target.closest("#user-overlay") && this.isOpen) {
      this.closeContainer();
    }
  }

  handleMyBooksClick() {
    if (this.user && this.user.name) {
      this.navigateToUserBooks(this.user.name);
    } else {
      this.setPostLoginAction(() => {
        if (this.user && this.user.name) {
          this.navigateToUserBooks(this.user.name);
        }
      });
      this.showLoginForm();
    }
  }

  getCsrfTokenFromCookie() {
    return getCsrfTokenFromCookie();
  }

  toggleContainer() {
    if (this.isAnimating) {
      return;
    }

    if (this.isOpen) {
      this.closeContainer();
    } else {
      // 📡 OFFLINE MODE: Show offline-specific UI
      if (!navigator.onLine) {
        this.showOfflineStatus();
        return;
      }

      if (this.user) {
        this.showUserProfile();
      } else {
        this.showLoginForm();
      }
    }
  }

  showOfflineStatus() {
    // Check for cached user in localStorage if this.user is not set
    let displayUser = this.user;
    if (!displayUser) {
      try {
        const cachedUser = localStorage.getItem('hyperlit_user_cache');
        if (cachedUser) {
          displayUser = JSON.parse(cachedUser);
          this.user = displayUser; // Update instance
        }
      } catch (e) {
        // Ignore parse errors
      }
    }

    // Show offline mode indicator
    const offlineHTML = `
      <div class="user-form" style="text-align: center;">
        <p style="color: var(--hyperlit-orange, #EF8D34); font-style: italic; margin-bottom: 15px;">
          📡 Offline Mode
        </p>
        <p style="font-size: 0.9em; color: var(--color-text-secondary, #999); margin-bottom: 15px;">
          ${displayUser ? `Logged in as <strong>${displayUser.name || displayUser.email}</strong>` : 'Session cached locally'}
        </p>
        <p style="font-size: 0.85em; color: var(--color-text-secondary, #888);">
          Your edits are saved locally and will sync when you're back online.
        </p>
      </div>
    `;

    this.container.innerHTML = offlineHTML;

    if (!this.isOpen) {
      this.openContainer("profile");
    }
  }

  openContainer(mode = "login") {
    if (this.isAnimating) return;

    // Opened by CODE (an auth gate, a "log in to do this" link) rather than by
    // a click on the Account row: bring its nav column up with it, so the panel
    // reads as the end of the path the user would have taken — logo → Account,
    // the row highlighted below — instead of floating beside a hidden menu.
    // A real click has the menu open already, so this is a no-op there, and on
    // the homepage (no logo nav) there is nothing to open.
    if (this.button?.closest("#logoNavMenu")) openLogoNavMenu();

    // One flyout at a time: opening this panel swaps out an open new-book /
    // open-book panel (level-1 nav rows stay clickable while a flyout is open).
    const newBookMgr = (window as any).newBookManager;
    if (newBookMgr?.isOpen) newBookMgr.closeContainer();
    const openBookMgr = (window as any).openBookManager;
    if (openBookMgr?.isOpen) openBookMgr.closeContainer();

    this.isAnimating = true;
    this.animationType = "open";

    const dimensions: any = {
      login: { width: "280px", height: "auto" },
      register: { width: "280px", height: "auto" },
      "forgot-password": { width: "280px", height: "auto" },
      "verify-email": { width: "280px", height: "auto" },
      "change-email": { width: "280px", height: "auto" },
      profile: { width: "160px", height: "auto" }, /* fits "Verify Email" + icon on one line (12px panel padding) */
      "transfer-prompt": { width: "320px", height: "auto" },
    };

    const { width, height } = dimensions[mode] || dimensions.login;

    if (this.button) {
      const rect = this.button.getBoundingClientRect();
      const panelW = parseInt(width, 10) || 280;
      const navWrapper = this.button.closest("#logoNavMenu")
        ? document.getElementById("logoNavWrapper")
        : null;
      if (navWrapper) {
        // Start-menu-style flyout: out to the RIGHT of the logo-nav glass
        // column, top-aligned with the trigger row (matches newbookContainer).
        // Clamped to the viewport: on narrow screens the panel slides left just
        // enough to fit, overlapping the nav slightly — the same "stacked and
        // shifted right" idiom as stacked hyperlit-containers.
        // +4 = flush against the nav's glass pill (it extends 4px past the
        // wrapper) so the two surfaces read as one connected thing.
        const desired = navWrapper.getBoundingClientRect().right + 4;
        const maxLeft = window.innerWidth - panelW - 10;
        this.container.style.top = `${rect.top}px`;
        this.container.style.left = `${Math.max(16, Math.min(desired, maxLeft))}px`;
      } else {
        this.container.style.top = `${rect.bottom + 8}px`;
        this.container.style.left = `${rect.left}px`;
      }
      this.container.style.transform = "";
      // The anchor is read ONCE, from a trigger whose rect is only trustworthy
      // once the page's CSS has applied — pre-CSS the corner buttons are still
      // in normal flow, and a rect read in that window parks the panel off the
      // bottom of the screen. Nothing repositions it afterwards, so the panel
      // stays there: visible, focus-trapped, and completely unreachable (the
      // e2e signup sat clicking a "Switch to Register" button that was 1200px
      // down the page until the test timeout, 2026-09-30). Clamp now so the
      // panel always starts on screen; _clampIntoViewport re-runs below with
      // the real measured box.
      this._clampAnchorToViewport(panelW);
    } else {
      this.container.style.top = "50%";
      this.container.style.left = "50%";
      this.container.style.transform = "translate(-50%, -50%)";
    }

    // FULL SIZE IMMEDIATELY, fade opacity only (same pattern as
    // newbookContainer/openClose.ts). The old width/height 0→N grow left a
    // ~300ms window where the panel's hit-box was still tiny, so a click
    // aimed at a menu row landed on the transparent full-screen #user-overlay
    // — which silently CLOSED the menu, and the user's retry click then hit
    // whatever content (footnote/citation/link) sat beneath the vanished
    // panel. Coming from `.hidden` (display:none) these synchronous size
    // writes don't transition, so the panel renders at its final box on the
    // first frame and every row is clickable immediately.
    this.container.style.opacity = "0";
    this.container.style.width = width;
    this.container.style.height = height;

    this.container.classList.remove("hidden");
    this.container.style.visibility = "visible";
    this.container.style.display = "";

    // Keep the triggering nav row highlighted while this flyout is open.
    this.button?.classList.add("logo-nav-active");

    // Profile is a menu of .menu-row-btn rows (like the nav column beside it)
    // and looks bloated with form-sized padding; the form modes keep 20px.
    this.container.style.padding = mode === "profile" ? "12px" : "20px";

    // State flips SYNCHRONOUSLY (not in the rAF): the sibling flyouts'
    // one-flyout-at-a-time cross-close checks `isOpen` the moment they open —
    // a state flip deferred to the rAF left a ~1-frame window where this
    // panel was "not open yet", dodged the cross-close, and then its rAF
    // re-activated the shared overlay OVER the new panel (the stale
    // #user-overlay that swallowed every click on the page).
    this.isOpen = true;
    (window as any).activeContainer = this.container.id;
    this.updateState();
    this._engageFocusTrap(); // base ContainerManager: Tab trap + Escape + focus restore

    requestAnimationFrame(() => {
      if (this.animationType !== "open") return; // a close interrupted before this frame
      this.container.style.opacity = "1";
      // The box is already final-size (set synchronously above), so the
      // viewport fit can be answered NOW instead of after the fade.
      this._clampIntoViewport();

      this.container.addEventListener("transitionend", () => {
        this.isAnimating = false;
        this._clampIntoViewport();
      }, { once: true });

      // Fallback timeout
      setTimeout(() => {
        if (this.isAnimating) {
          this.isAnimating = false;
        }
        this._clampIntoViewport(); // transitionend can be skipped (no property changed)
      }, 1000);
    });
  }

  /**
   * Cheap pre-measurement guard: whatever the trigger's rect said, the panel's
   * top-left corner starts inside the viewport with room for a row of content.
   * Runs BEFORE the panel has a height (it is still `.hidden`/zero-sized here),
   * so it can only bound the anchor — _clampIntoViewport does the real fit.
   */
  _clampAnchorToViewport(panelW: number) {
    const margin = 8;
    const maxTop = Math.max(margin, window.innerHeight - 120);
    const maxLeft = Math.max(margin, window.innerWidth - panelW - margin);
    const top = parseFloat(this.container.style.top) || 0;
    const left = parseFloat(this.container.style.left) || 0;
    this.container.style.top = `${Math.min(Math.max(top, margin), maxTop)}px`;
    this.container.style.left = `${Math.min(Math.max(left, margin), maxLeft)}px`;
  }

  /**
   * Keep the WHOLE panel on screen once it has a measurable box: a panel that
   * doesn't fit below its trigger is lifted so its bottom edge sits inside the
   * viewport (never above the top edge — a tall panel clips at the bottom
   * rather than losing its heading). Same for the right edge. No-op when the
   * panel is closed or centred (transform-positioned).
   */
  _clampIntoViewport() {
    if (!this.isOpen || !this.container || this.container.style.transform) return;
    const margin = 8;
    const rect = this.container.getBoundingClientRect();
    if (!rect.height || !rect.width) return; // nothing measurable yet
    const top = parseFloat(this.container.style.top);
    const left = parseFloat(this.container.style.left);
    if (!Number.isFinite(top) || !Number.isFinite(left)) return;

    const maxTop = window.innerHeight - rect.height - margin;
    const maxLeft = window.innerWidth - rect.width - margin;
    const nextTop = Math.max(margin, Math.min(top, maxTop));
    const nextLeft = Math.max(margin, Math.min(left, maxLeft));
    if (nextTop !== top) this.container.style.top = `${nextTop}px`;
    if (nextLeft !== left) this.container.style.left = `${nextLeft}px`;
  }

  closeContainer() {
    // A running CLOSE is left to finish; an in-flight OPEN is interrupted so
    // the close takes over (same semantics as newbookContainer/openClose.ts —
    // without this, Escape during the ~1s open window was silently dropped).
    if (this.isAnimating && this.animationType === "close") return;
    this.isAnimating = true;
    this.animationType = "close";

    this.container.style.padding = "0";
    this.container.style.width = "0";
    this.container.style.height = "0";
    this.container.style.opacity = "0";

    this.button?.classList.remove("logo-nav-active");

    this.isOpen = false;
    (window as any).activeContainer = "main-content";
    this.updateState();
    this._releaseFocusTrap();

    this.container.addEventListener("transitionend", () => {
      this.container.classList.add("hidden");
      this.container.style.visibility = "hidden";
      this.isAnimating = false;
    }, { once: true });
  }

  async forceServerDataRefresh() {
    try {
      if (book && (book as any).id) {
        await syncBookDataFromDatabase((book as any).id);
        await this.triggerContentRefresh((book as any).id);
      } else if (book) {
        await syncBookDataFromDatabase(book);
        await this.triggerContentRefresh(book);
      }
    } catch (error) {
      console.error("❌ Error during server data refresh:", error);
      window.location.reload();
    }
  }

  async triggerContentRefresh(bookId: any) {
    try {
      const { currentLazyLoader }: any = await import('../../pageLoad/index');
      if (currentLazyLoader && typeof currentLazyLoader.refresh === 'function') {
        await currentLazyLoader.refresh();
      } else {
        window.location.reload();
      }
    } catch (error) {
      console.error("❌ Error during content refresh:", error);
      window.location.reload();
    }
  }

  proceedAfterLogin() {
    // Clean up alert boxes
    const customAlert = document.querySelector(".custom-alert");
    if (customAlert) {
      const overlay = document.querySelector(".custom-alert-overlay");
      if (overlay) overlay.remove();
      customAlert.remove();
    }

    if (typeof this.postLoginAction === "function") {
      this.postLoginAction();
      this.postLoginAction = null;
    } else {
      this.showUserProfile();
    }
  }

  sanitizeUsername(username: any) {
    return username.replace(/\s+/g, '');
  }

  async navigateToUserBooks(username: any) {
    const sanitizedUsername = this.sanitizeUsername(username);

    try {
      this.closeContainer();

      await navigateByStructure({
        toBook: encodeURIComponent(sanitizedUsername),
        targetUrl: `/u/${encodeURIComponent(sanitizedUsername)}`,
        targetStructure: 'user',
        hash: ''
      });
    } catch (error) {
      console.error('❌ SPA navigation failed, falling back to page reload:', error);
      window.location.href = "/u/" + encodeURIComponent(sanitizedUsername);
    }
  }

  showError(errors: any, formId: any) {
    const form = document.getElementById(formId);
    if (form) {
      const existingError = form.querySelector('.error-message');
      if (existingError) existingError.remove();

      form.insertAdjacentHTML('beforeend', getErrorHTML(errors));
    }
  }

  // ── Delegators ──────────────────────────────────────────────────────────
  // auth
  showLoginForm() { return showLoginForm(this); }
  showRegisterForm() { return showRegisterForm(this); }
  handleLogin() { return handleLogin(this); }
  handleRegister() { return handleRegister(this); }
  handleLogout() { return handleLogout(this); }
  performLogoutCleanup() { return performLogoutCleanup(this); }
  showLoginError(errors: any) { return showLoginError(this, errors); }
  showRegisterError(errors: any) { return showRegisterError(this, errors); }

  // email
  showVerifyEmailScreen() { return showVerifyEmailScreen(this); }
  showChangeEmailForm() { return showChangeEmailForm(this); }
  handleChangeEmail() { return handleChangeEmail(this); }
  handleResendVerification() { return handleResendVerification(this); }

  // forgotPassword
  showForgotPasswordForm() { return showForgotPasswordForm(this); }
  handleForgotPassword() { return handleForgotPassword(this); }

  // profile
  showUserProfile() { return showUserProfile(this); }
  attachProfileButtonListeners() { return attachProfileButtonListeners(this); }

  // anonymousTransfer
  showAnonymousContentTransfer(anonymousContent: any) { return showAnonymousContentTransfer(this, anonymousContent); }
}
