// userContainer.js - User authentication container manager
import { ContainerManager } from "../containerManager.js";
import { book } from "../app.js";
import { log, verbose } from "../utilities/logger.js";
import {
  setCurrentUser,
  clearCurrentUser,
  getCurrentUser,
  getAnonymousToken,
  refreshAuth,
  broadcastAuthChange,
} from "../utilities/auth.js";
import { syncBookDataFromDatabase } from "../postgreSQL.js";

// Import extracted modules
import {
  getLoginFormHTML,
  getRegisterFormHTML,
  getProfileHTML,
  getTransferPromptHTML,
  getErrorHTML,
} from './userContainer/formTemplates.js';
import {
  validateUsername,
  validateEmail,
  validatePassword,
  attachValidationListeners,
  validateForm,
} from './userContainer/formValidation.js';
import {
  transferAnonymousContent,
  buildContentSummary,
} from './userContainer/anonymousContentManager.js';
import {
  clearAllCachedData,
} from './userContainer/cacheManager.js';

export class UserContainerManager extends ContainerManager {
  constructor(containerId, overlayId, buttonId, frozenContainerIds = []) {
    super(containerId, overlayId, buttonId, frozenContainerIds);

    this.setupUserContainerStyles();
    this.isAnimating = false;
    this.button = document.getElementById(buttonId);
    this.boundClickHandler = this.handleDocumentClick.bind(this);
    this.setupUserListeners();
    this.user = null;

    this.initializeUser();
  }

  setPostLoginAction(action) {
    this.postLoginAction = action;
  }

  async initializeUser() {
    const user = await getCurrentUser();
    if (user) {
      this.user = user;
      this.updateButtonColor();
      log.init("User container initialized (logged in)", "/components/userContainer.js");
    } else {
      // 📡 OFFLINE: Check if we have cached user info in memory
      // getCurrentUser returns null when offline and not initialized, but we might
      // have user info from a previous session
      log.init("User container initialized (anonymous or offline)", "/components/userContainer.js");
    }
  }

  updateButtonColor() {
    const userLogo = document.getElementById('userLogo');
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
    container.style.boxShadow = "0 0 15px rgba(0, 0, 0, 0.2)";
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

  handleDocumentClick(e) {
    const isInUserContainer = e.target.closest('#user-container');
    const isUserOverlay = e.target.closest('#user-overlay');
    const isInCustomAlert = e.target.closest('.custom-alert');

    if (!isInUserContainer && !isUserOverlay && !isInCustomAlert) {
      return;
    }

    // Click handler mapping for cleaner code
    const handlers = {
      '#loginSubmit': () => this.handleLogin(),
      '#registerSubmit': () => this.handleRegister(),
      '#showRegister': () => this.showRegisterForm(),
      '#showLogin': () => this.showLoginForm(),
      '#logout': () => this.handleLogout(),
      '#myBooksBtn': () => this.handleMyBooksClick(),
    };

    for (const [selector, handler] of Object.entries(handlers)) {
      if (e.target.closest(selector)) {
        e.preventDefault();
        handler();
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

  showLoginForm() {
    const container = document.querySelector(".custom-alert") || this.container;
    container.innerHTML = getLoginFormHTML();

    // Attach validation listeners
    attachValidationListeners('login');

    if (!this.isOpen && container === this.container) {
      this.openContainer("login");
    }
  }

  showRegisterForm() {
    const container = document.querySelector(".custom-alert") || this.container;
    container.innerHTML = getRegisterFormHTML();

    // Attach validation listeners
    attachValidationListeners('register');

    if (!this.isOpen && container === this.container) {
      this.openContainer("register");
    }
  }

  showUserProfile() {
    this.container.innerHTML = getProfileHTML();

    if (!this.isOpen) {
      this.openContainer("profile");
    } else {
      this.container.style.width = "160px";
    }

    // Attach button listeners
    this.attachProfileButtonListeners();
  }

  attachProfileButtonListeners() {
    const logoutBtn = this.container.querySelector('#logout');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.handleLogout();
      });

      logoutBtn.addEventListener('mouseenter', () => {
        logoutBtn.style.backgroundColor = 'var(--color-accent)';
        logoutBtn.style.color = 'var(--color-background)';
        logoutBtn.style.borderColor = 'var(--color-accent)';
      });
      logoutBtn.addEventListener('mouseleave', () => {
        logoutBtn.style.backgroundColor = 'transparent';
        logoutBtn.style.color = 'var(--color-text)';
        logoutBtn.style.borderColor = 'var(--color-text)';
      });
    }

    const myBooksBtn = this.container.querySelector('#myBooksBtn');
    if (myBooksBtn) {
      myBooksBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.handleMyBooksClick();
      });

      myBooksBtn.addEventListener('mouseenter', () => {
        myBooksBtn.style.backgroundColor = '#5FBCC0';
      });
      myBooksBtn.addEventListener('mouseleave', () => {
        myBooksBtn.style.backgroundColor = 'var(--color-accent)';
      });
    }
  }

  getCsrfTokenFromCookie() {
    const value = `; ${document.cookie}`;
    const parts = value.split(`; XSRF-TOKEN=`);
    if (parts.length === 2) {
      return decodeURIComponent(parts.pop().split(";").shift());
    }
    return null;
  }

  async handleLogin() {
    // Validate form before submission
    const validation = validateForm('login');
    if (!validation.valid) {
      return;
    }

    const email = document.getElementById("loginEmail").value;
    const password = document.getElementById("loginPassword").value;

    try {
      await fetch("/sanctum/csrf-cookie", { credentials: "include" });
      const csrfToken = this.getCsrfTokenFromCookie();

      const response = await fetch("/api/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "X-Requested-With": "XMLHttpRequest",
          "X-XSRF-TOKEN": csrfToken,
        },
        credentials: "include",
        body: JSON.stringify({ email, password }),
      });

      const data = await response.json();

      if (response.ok && data.success) {
        setCurrentUser(data.user);
        this.user = data.user;
        broadcastAuthChange('login', data.user);
        await refreshAuth();

        this.updateButtonColor();

        if (data.anonymous_content) {
          this.showAnonymousContentTransfer(data.anonymous_content);
        } else {
          await clearAllCachedData();
          this.proceedAfterLogin();
        }
      } else {
        console.error("❌ Login failed:", data);
        this.showLoginError(data.errors || data.message || "Login failed");
      }
    } catch (error) {
      console.error("❌ Login error:", error);
      this.showLoginError("Network error occurred");
    }
  }

  async handleRegister() {
    // Validate form before submission
    const validation = validateForm('register');
    if (!validation.valid) {
      return;
    }

    const name = document.getElementById("registerName").value;
    const email = document.getElementById("registerEmail").value;
    const password = document.getElementById("registerPassword").value;

    try {
      await fetch("/sanctum/csrf-cookie", { credentials: "include" });
      const csrfToken = this.getCsrfTokenFromCookie();

      const response = await fetch("/api/register", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "X-Requested-With": "XMLHttpRequest",
          "X-XSRF-TOKEN": csrfToken,
        },
        credentials: "include",
        body: JSON.stringify({ name, email, password }),
      });

      const data = await response.json();

      if (response.ok && data.success) {
        setCurrentUser(data.user);
        this.user = data.user;
        broadcastAuthChange('login', data.user);
        await refreshAuth();
        this.updateButtonColor();

        if (data.anonymous_content) {
          this.showAnonymousContentTransfer(data.anonymous_content);
        } else {
          await clearAllCachedData();
          this.showUserProfile();
        }
      } else {
        this.showRegisterError(data.errors || data.message || "Registration failed");
      }
    } catch (error) {
      console.error("Register error:", error);
      this.showRegisterError("Network error occurred");
    }
  }

  async handleLogout() {
    try {
      await fetch("/sanctum/csrf-cookie", { credentials: "include" });
      const csrfToken = this.getCsrfTokenFromCookie();

      const response = await fetch("/logout", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "X-Requested-With": "XMLHttpRequest",
          "X-XSRF-TOKEN": csrfToken,
        },
        credentials: "include",
      });

      if (response.ok) {
        broadcastAuthChange('logout');
        clearCurrentUser();
        this.user = null;
        this.updateButtonColor();

        try {
          await clearAllCachedData();
        } catch (error) {
          console.error("❌ Error clearing cached data after logout:", error);
        }

        this.closeContainer();
      } else {
        console.error("Logout failed:", response.status);
        this.performLogoutCleanup();
      }
    } catch (error) {
      console.error("Logout error:", error);
      this.performLogoutCleanup();
    }
  }

  performLogoutCleanup() {
    broadcastAuthChange('logout');
    clearCurrentUser();
    this.user = null;
    this.updateButtonColor();
    this.closeContainer();
  }

  showLoginError(errors) {
    this.showError(errors, 'login-form-embedded');
  }

  showRegisterError(errors) {
    this.showError(errors, 'register-form-embedded');
  }

  showError(errors, formId) {
    const form = document.getElementById(formId);
    if (form) {
      const existingError = form.querySelector('.error-message');
      if (existingError) existingError.remove();

      form.insertAdjacentHTML('beforeend', getErrorHTML(errors));
    }
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
    // Show offline mode indicator
    const offlineHTML = `
      <div class="user-form" style="text-align: center;">
        <p style="color: var(--hyperlit-orange, #EF8D34); font-style: italic; margin-bottom: 15px;">
          📡 Offline Mode
        </p>
        <p style="font-size: 0.9em; color: var(--color-text-secondary, #999); margin-bottom: 15px;">
          ${this.user ? `Logged in as <strong>${this.user.name || this.user.email}</strong>` : 'Session cached locally'}
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

    const dimensions = {
      login: { width: "280px", height: "auto" },
      register: { width: "280px", height: "auto" },
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
      window.activeContainer = this.container.id;
      this.updateState();

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
    if (this.isAnimating) return;
    this.isAnimating = true;

    this.container.style.padding = "0";
    this.container.style.width = "0";
    this.container.style.height = "0";
    this.container.style.opacity = "0";

    this.isOpen = false;
    window.activeContainer = "main-content";
    this.updateState();

    this.container.addEventListener("transitionend", () => {
      this.container.classList.add("hidden");
      this.container.style.visibility = "hidden";
      this.isAnimating = false;
    }, { once: true });
  }

  showAnonymousContentTransfer(anonymousContent) {
    // Clean up any existing alert boxes
    const customAlert = document.querySelector(".custom-alert");
    if (customAlert) {
      const overlay = document.querySelector(".custom-alert-overlay");
      if (overlay) overlay.remove();
      customAlert.remove();
    }

    if (!this.isOpen) {
      this.openContainer("transfer-prompt");
    }

    const contentSummary = buildContentSummary(anonymousContent);
    this.container.innerHTML = getTransferPromptHTML(contentSummary);

    // Add event listeners
    const confirmButton = document.getElementById('confirmContentTransfer');
    const skipButton = document.getElementById('skipContentTransfer');

    if (confirmButton) {
      confirmButton.onclick = async () => {
        await transferAnonymousContent(anonymousContent.token);
        await clearAllCachedData();
        setTimeout(() => this.showUserProfile(), 500);
      };
    }

    if (skipButton) {
      skipButton.onclick = async () => {
        try {
          await clearAllCachedData();
          this.showUserProfile();
        } catch (error) {
          console.error("❌ Error during cache clearing:", error);
          window.location.reload(true);
        }
      };
    }
  }

  async forceServerDataRefresh() {
    try {
      if (book && book.id) {
        await syncBookDataFromDatabase(book.id);
        await this.triggerContentRefresh(book.id);
      } else if (book) {
        await syncBookDataFromDatabase(book);
        await this.triggerContentRefresh(book);
      }
    } catch (error) {
      console.error("❌ Error during server data refresh:", error);
      window.location.reload();
    }
  }

  async triggerContentRefresh(bookId) {
    try {
      const { currentLazyLoader } = await import('../initializePage.js');
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

  sanitizeUsername(username) {
    return username.replace(/\s+/g, '');
  }

  async navigateToUserBooks(username) {
    const sanitizedUsername = this.sanitizeUsername(username);

    try {
      this.closeContainer();

      const { NavigationManager } = await import('../navigation/NavigationManager.js');
      await NavigationManager.navigateByStructure({
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
}

// Container manager instance
let userManager = null;

export function initializeUserContainer() {
  if (document.getElementById("userButton")) {
    if (!userManager) {
      userManager = new UserContainerManager(
        "user-container",
        "user-overlay",
        "userButton",
        ["main-content"]
      );
      verbose.init('User container manager created', '/components/userContainer.js');
    } else {
      userManager.button = document.getElementById("userButton");
      userManager.rebindElements();
      userManager.updateButtonColor();
      verbose.init('User container manager updated', '/components/userContainer.js');
    }
    return userManager;
  } else {
    verbose.init('User container button not found', '/components/userContainer.js');
    return null;
  }
}

// Auto-initialize if button exists on initial load
if (document.getElementById("userButton")) {
  userManager = initializeUserContainer();
}

export function destroyUserContainer() {
  if (userManager) {
    if (userManager.isOpen) {
      userManager.closeContainer();
    }
    userManager.destroy();
    userManager = null;
    return true;
  }
  return false;
}

export default userManager;
