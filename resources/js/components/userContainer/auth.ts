// auth.ts - Login / register / logout for the user container, plus the
// show-login/show-register form switches and inline error rendering. Each
// function takes the UserContainerManager as `self`; peer calls (open/close,
// updateButtonColor, showVerifyEmailScreen, proceedAfterLogin, showError, …)
// route through `self`.
import { getLoginFormHTML, getRegisterFormHTML } from './forms';
import { attachValidationListeners, validateForm } from './validation';
import { clearAllCachedData } from './cache';
import {
  setCurrentUser,
  clearCurrentUser,
  broadcastAuthChange,
  refreshAuth,
} from '../../utilities/auth/index';
import { flushAllPendingEdits } from '../../indexedDB/serverSync/index';

export function showLoginForm(self: any) {
  const container = document.querySelector(".custom-alert") || self.container;
  container.innerHTML = getLoginFormHTML();

  // Attach validation listeners
  attachValidationListeners('login');

  if (!self.isOpen && container === self.container) {
    self.openContainer("login");
  }
}

export function showRegisterForm(self: any) {
  const container = document.querySelector(".custom-alert") || self.container;
  container.innerHTML = getRegisterFormHTML();

  // Attach validation listeners
  attachValidationListeners('register');

  if (!self.isOpen && container === self.container) {
    self.openContainer("register");
  }
}

export async function handleLogin(self: any) {
  // Validate form before submission
  const validation = validateForm('login');
  if (!validation.valid) {
    return;
  }

  const email = (document.getElementById("loginEmail") as any).value;
  const password = (document.getElementById("loginPassword") as any).value;

  try {
    await fetch("/sanctum/csrf-cookie", { credentials: "include" });
    const csrfToken = self.getCsrfTokenFromCookie();

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
      self.user = data.user;
      broadcastAuthChange('login', data.user);
      await refreshAuth();

      self.updateButtonColor();

      if (data.anonymous_content) {
        self.showAnonymousContentTransfer(data.anonymous_content);
      } else if (data.email_verified === false) {
        await clearAllCachedData();
        self.showVerifyEmailScreen();
      } else {
        await clearAllCachedData();
        const pageType = document.body.getAttribute('data-page');
        if (pageType === 'reader' || pageType === 'user') {
          window.location.reload();
          return;
        }
        self.proceedAfterLogin();
      }
    } else {
      console.error("❌ Login failed:", data);
      self.showLoginError(data.errors || data.message || "Login failed");
    }
  } catch (error) {
    console.error("❌ Login error:", error);
    self.showLoginError("Network error occurred");
  }
}

export async function handleRegister(self: any) {
  // Validate form before submission
  const validation = validateForm('register');
  if (!validation.valid) {
    return;
  }

  const name = (document.getElementById("registerName") as any).value;
  const email = (document.getElementById("registerEmail") as any).value;
  const password = (document.getElementById("registerPassword") as any).value;

  try {
    await fetch("/sanctum/csrf-cookie", { credentials: "include" });
    const csrfToken = self.getCsrfTokenFromCookie();

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
      self.user = data.user;
      broadcastAuthChange('login', data.user);
      await refreshAuth();
      self.updateButtonColor();

      if (data.anonymous_content) {
        self.showAnonymousContentTransfer(data.anonymous_content);
      } else if (data.email_verified === false) {
        await clearAllCachedData();
        self.showVerifyEmailScreen();
      } else {
        await clearAllCachedData();
        const pageType = document.body.getAttribute('data-page');
        if (pageType === 'reader' || pageType === 'user') {
          window.location.reload();
          return;
        }
        self.showUserProfile();
      }
    } else {
      self.showRegisterError(data.errors || data.message || "Registration failed");
    }
  } catch (error) {
    console.error("Register error:", error);
    self.showRegisterError("Network error occurred");
  }
}

export async function handleLogout(self: any) {
  // Flush any in-progress edits (typing → IndexedDB → server) BEFORE we end
  // the session and wipe local data. Must run while still authenticated — the
  // /logout POST below destroys the server session and clearCurrentUser()
  // resets the token. Fast-path no-ops when there's nothing pending.
  try {
    await flushAllPendingEdits();
  } catch (error) {
    console.error("⚠️ Failed to flush pending edits before logout:", error);
  }

  try {
    await fetch("/sanctum/csrf-cookie", { credentials: "include" });
    const csrfToken = self.getCsrfTokenFromCookie();

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
      self.user = null;
      self.updateButtonColor();

      try {
        await clearAllCachedData();
      } catch (error) {
        console.error("❌ Error clearing cached data after logout:", error);
      }

      self.closeContainer();
    } else {
      console.error("Logout failed:", response.status);
      self.performLogoutCleanup();
    }
  } catch (error) {
    console.error("Logout error:", error);
    self.performLogoutCleanup();
  }
}

export function performLogoutCleanup(self: any) {
  broadcastAuthChange('logout');
  clearCurrentUser();
  self.user = null;
  self.updateButtonColor();
  self.closeContainer();
}

export function showLoginError(self: any, errors: any) {
  self.showError(errors, 'login-form-embedded');
}

export function showRegisterError(self: any, errors: any) {
  self.showError(errors, 'register-form-embedded');
}
