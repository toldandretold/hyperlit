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
  }

  setupUserContainerStyles() {
    const container = this.container;
    if (!container) return;

    container.style.position = "fixed";
    container.style.transition =
      "width 0.3s ease-out, height 0.3s ease-out, opacity 0.3s ease-out, padding 0.3s ease-out";
    container.style.zIndex = "1000";
    // Subtle edge drop-shadow + the page-dimming "spotlight" (250vmax). This is set inline
    // (not in CSS) because this panel sets ALL its visual state inline, and an inline box-shadow
    // overrides the stylesheet — so the CSS spotlight on #user-container never won. Combining both
    // here is the fix. Safe when closed: the panel is opacity:0 / display:none (.hidden), so it
    // renders no shadow; openContainer animates opacity 0→1, fading the dim in/out with the panel.
    container.style.boxShadow =
      "0 0 15px rgba(0, 0, 0, 0.2), 0 0 0 250vmax rgba(0, 0, 0, 0.5)";
    container.style.borderRadius = "0.75em";
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
    this.isAnimating = true;
    this.animationType = "open";

    if (this.button) {
      const rect = this.button.getBoundingClientRect();
      this.container.style.top = `${rect.bottom + 8}px`;
      this.container.style.left = `${rect.left}px`;
      this.container.style.transform = "";
    } else {
      this.container.style.top = "50%";
      this.container.style.left = "50%";
      this.container.style.transform = "translate(-50%, -50%)";
    }

    this.container.classList.remove("hidden");
    this.container.style.visibility = "visible";
    this.container.style.display = "";

    const dimensions: any = {
      login: { width: "280px", height: "auto" },
      register: { width: "280px", height: "auto" },
      "forgot-password": { width: "280px", height: "auto" },
      "verify-email": { width: "280px", height: "auto" },
      "change-email": { width: "280px", height: "auto" },
      profile: { width: "160px", height: "auto" },
      "transfer-prompt": { width: "320px", height: "auto" },
    };

    const { width, height } = dimensions[mode] || dimensions.login;
    this.container.style.padding = "20px";

    requestAnimationFrame(() => {
      this.container.style.width = width;
      this.container.style.height = height;
      this.container.style.opacity = "1";

      this.isOpen = true;
      (window as any).activeContainer = this.container.id;
      this.updateState();
      this._engageFocusTrap(); // base ContainerManager: Tab trap + Escape + focus restore

      this.container.addEventListener("transitionend", () => {
        this.isAnimating = false;
      }, { once: true });

      // Fallback timeout
      setTimeout(() => {
        if (this.isAnimating) {
          this.isAnimating = false;
        }
      }, 1000);
    });
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
