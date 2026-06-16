// email.ts - Email verification flow for the user container: the verify-email
// screen, the change-email form + submit, and resend-verification. Takes the
// UserContainerManager as `self`.
import { getVerifyEmailHTML, getChangeEmailHTML } from './forms';
import { setCurrentUser } from '../../utilities/auth.js';

export function showVerifyEmailScreen(self: any) {
  const container = document.querySelector(".custom-alert") || self.container;
  container.innerHTML = getVerifyEmailHTML(self.user?.email || '');

  if (!self.isOpen && container === self.container) {
    self.openContainer("verify-email");
  }
}

export function showChangeEmailForm(self: any) {
  const container = document.querySelector(".custom-alert") || self.container;
  container.innerHTML = getChangeEmailHTML(self.user?.email || '');

  if (!self.isOpen && container === self.container) {
    self.openContainer("change-email");
  }
}

export async function handleResendVerification(self: any) {
  const btn = document.getElementById('resendVerification') as any;
  if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }

  try {
    await fetch('/sanctum/csrf-cookie', { credentials: 'include' });
    const csrfToken = self.getCsrfTokenFromCookie();

    const response = await fetch('/api/email/resend', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        'X-XSRF-TOKEN': csrfToken,
      },
      credentials: 'include',
    });

    if (response.ok) {
      if (btn) { btn.textContent = 'Sent!'; }
      setTimeout(() => { if (btn) { btn.disabled = false; btn.textContent = 'Resend Email'; } }, 3000);
    } else {
      const data = await response.json();
      if (btn) { btn.disabled = false; btn.textContent = 'Resend Email'; }
      if (data.message === 'Email is already verified.') {
        self.showUserProfile();
      }
    }
  } catch (error) {
    if (btn) { btn.disabled = false; btn.textContent = 'Resend Email'; }
  }
}

export async function handleChangeEmail(self: any) {
  const emailInput = document.getElementById('newEmailInput') as any;
  const email = emailInput?.value?.trim();
  const errorEl = document.getElementById('changeEmailError') as any;
  const btn = document.getElementById('changeEmailSubmit') as any;

  if (errorEl) { errorEl.style.display = 'none'; errorEl.textContent = ''; }

  if (!email) {
    if (errorEl) { errorEl.textContent = 'Email is required.'; errorEl.style.display = 'block'; }
    return;
  }

  if (btn) { btn.disabled = true; btn.textContent = 'Updating…'; }

  try {
    await fetch('/sanctum/csrf-cookie', { credentials: 'include' });
    const csrfToken = self.getCsrfTokenFromCookie();

    const response = await fetch('/api/email/change', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        'X-XSRF-TOKEN': csrfToken,
      },
      credentials: 'include',
      body: JSON.stringify({ email }),
    });

    const data = await response.json();

    if (response.ok && data.success) {
      if (data.user) {
        self.user = data.user;
        setCurrentUser(data.user);
      }
      self.showVerifyEmailScreen();
    } else {
      if (btn) { btn.disabled = false; btn.textContent = 'Update & Resend'; }
      if (errorEl && data.errors?.email) {
        errorEl.textContent = data.errors.email[0];
        errorEl.style.display = 'block';
      } else if (errorEl) {
        errorEl.textContent = data.message || 'Failed to update email.';
        errorEl.style.display = 'block';
      }
    }
  } catch (error) {
    if (btn) { btn.disabled = false; btn.textContent = 'Update & Resend'; }
    if (errorEl) { errorEl.textContent = 'Network error. Please try again.'; errorEl.style.display = 'block'; }
  }
}
