// forgotPassword.ts - Forgot-password flow for the user container: the request
// form and its submit (always shows success to prevent email enumeration).
// Takes the UserContainerManager as `self`.
import { getForgotPasswordFormHTML, getForgotPasswordSentHTML } from './forms';

export function showForgotPasswordForm(self: any) {
  const container = document.querySelector(".custom-alert") || self.container;
  container.innerHTML = getForgotPasswordFormHTML();

  if (!self.isOpen && container === self.container) {
    self.openContainer("forgot-password");
  }
}

export async function handleForgotPassword(self: any) {
  const emailInput = document.getElementById('forgotEmail') as any;
  const email = emailInput?.value?.trim();
  const errorEl = document.getElementById('forgotEmailError') as any;
  const btn = document.getElementById('forgotPasswordSubmit') as any;

  if (errorEl) { errorEl.style.display = 'none'; errorEl.textContent = ''; }

  if (!email) {
    if (errorEl) { errorEl.textContent = 'Email is required.'; errorEl.style.display = 'block'; }
    return;
  }

  if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }

  try {
    await fetch('/sanctum/csrf-cookie', { credentials: 'include' });
    const csrfToken = self.getCsrfTokenFromCookie();

    await fetch('/api/password/forgot', {
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

    // Always show success (prevents email enumeration)
    const container = document.querySelector('.custom-alert') || self.container;
    container.innerHTML = getForgotPasswordSentHTML(email);
  } catch (error) {
    if (btn) { btn.disabled = false; btn.textContent = 'Send Reset Link'; }
    if (errorEl) { errorEl.textContent = 'Network error. Please try again.'; errorEl.style.display = 'block'; }
  }
}
