@extends('layout')

@section('styles')
    @vite(['resources/css/app.css', 'resources/css/containers.css', 'resources/css/buttons.css', 'resources/css/form.css'])
@endsection

@section('content')
<div style="display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 20px; box-sizing: border-box;">
  <div style="width: 100%; max-width: 360px; background: var(--container-solid-bg, #1a1a1a); border-radius: 12px; padding: 30px; box-shadow: 0 0 20px rgba(0,0,0,0.3);">
    <h2 id="reset-heading" style="color: var(--color-secondary); margin: 0 0 8px;">Reset Password</h2>
    <p id="reset-subtitle" style="font-size: 13px; color: var(--color-text); opacity: 0.7; margin: 0 0 24px;">Enter a new password for your account.</p>

    <div id="reset-alert" style="display:none; font-size:12px; padding:10px; border-radius:4px; margin-bottom:16px;"></div>

    <form id="reset-password-form" autocomplete="on" style="display: block;">
      <input type="hidden" id="reset-token" value="{{ $token }}">
      <input type="hidden" id="reset-email-hidden" value="{{ $email }}">

      <div style="margin-bottom: 14px;">
        <input type="email" id="reset-email" name="email" placeholder="Email" required autocomplete="email"
               value="{{ $email }}"
               style="width: 100%; padding: 9px; border-radius: 4px; border: none; background: var(--container-bg, #111); color: var(--color-text); box-sizing: border-box; font-size: 14px; font-family: Inter, Arial, sans-serif;">
        <div id="reset-email-error" style="font-size:11px; color: var(--color-primary); margin-top:4px; display:none;"></div>
      </div>

      <div style="margin-bottom: 14px;">
        <input type="password" id="reset-password" name="password" placeholder="New password (min 8 chars)" required autocomplete="new-password"
               style="width: 100%; padding: 9px; border-radius: 4px; border: none; background: var(--container-bg, #111); color: var(--color-text); box-sizing: border-box; font-size: 14px; font-family: Inter, Arial, sans-serif;">
        <div id="reset-password-error" style="font-size:11px; color: var(--color-primary); margin-top:4px; display:none;"></div>
      </div>

      <div style="margin-bottom: 20px;">
        <input type="password" id="reset-password-confirm" name="password_confirmation" placeholder="Confirm new password" required autocomplete="new-password"
               style="width: 100%; padding: 9px; border-radius: 4px; border: none; background: var(--container-bg, #111); color: var(--color-text); box-sizing: border-box; font-size: 14px; font-family: Inter, Arial, sans-serif;">
        <div id="reset-confirm-error" style="font-size:11px; color: var(--color-primary); margin-top:4px; display:none;"></div>
      </div>

      <button type="submit" id="reset-submit"
              style="width: 100%; padding: 10px; background: var(--color-accent); color: var(--color-background); border: none; border-radius: 4px; cursor: pointer; font-size: 14px; font-family: Inter, Arial, sans-serif; font-weight: 600; margin-bottom: 10px;">
        Set New Password
      </button>
    </form>

    <a href="/" style="display:block; text-align:center; font-size:12px; color: var(--color-text); opacity:0.6; margin-top:12px; text-decoration:none;">
      Back to Hyperlit
    </a>
  </div>
</div>

<script>
document.getElementById('reset-password-form').addEventListener('submit', async function (e) {
  e.preventDefault();

  const token    = document.getElementById('reset-token').value;
  const email    = document.getElementById('reset-email').value.trim();
  const password = document.getElementById('reset-password').value;
  const confirm  = document.getElementById('reset-password-confirm').value;
  const btn      = document.getElementById('reset-submit');
  const alert    = document.getElementById('reset-alert');

  // Clear previous errors
  ['reset-email-error', 'reset-password-error', 'reset-confirm-error'].forEach(id => {
    const el = document.getElementById(id);
    el.style.display = 'none';
    el.textContent = '';
  });
  alert.style.display = 'none';

  // Client-side validation
  if (!email) {
    showFieldError('reset-email-error', 'Email is required.');
    return;
  }
  if (password.length < 8) {
    showFieldError('reset-password-error', 'Password must be at least 8 characters.');
    return;
  }
  if (password !== confirm) {
    showFieldError('reset-confirm-error', 'Passwords do not match.');
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Resetting\u2026';

  try {
    // Get CSRF token
    await fetch('/sanctum/csrf-cookie', { credentials: 'include' });
    const csrfToken = getCsrfFromCookie();

    const response = await fetch('/api/password/reset', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        'X-XSRF-TOKEN': csrfToken,
      },
      credentials: 'include',
      body: JSON.stringify({
        token,
        email,
        password,
        password_confirmation: confirm,
      }),
    });

    const data = await response.json();

    if (response.ok && data.success) {
      document.getElementById('reset-heading').textContent = 'Password updated!';
      document.getElementById('reset-subtitle').textContent = 'Your password has been changed. Redirecting\u2026';
      document.getElementById('reset-password-form').style.display = 'none';
      showAlert('Password reset successfully. Redirecting to login\u2026', 'success');
      setTimeout(() => { window.location.href = '/'; }, 2000);
    } else {
      const msg = data.message || 'Reset failed. The link may have expired.';
      showAlert(msg, 'error');
      btn.disabled = false;
      btn.textContent = 'Set New Password';
    }
  } catch (err) {
    showAlert('A network error occurred. Please try again.', 'error');
    btn.disabled = false;
    btn.textContent = 'Set New Password';
  }
});

function showFieldError(id, msg) {
  const el = document.getElementById(id);
  el.textContent = msg;
  el.style.display = 'block';
}

function showAlert(msg, type) {
  const el = document.getElementById('reset-alert');
  el.textContent = msg;
  el.style.display = 'block';
  el.style.background = type === 'success'
    ? 'rgba(34,197,94,0.15)'
    : 'rgba(238,74,149,0.12)';
  el.style.color = type === 'success' ? '#22c55e' : 'var(--color-primary)';
}

function getCsrfFromCookie() {
  const value = `; ${document.cookie}`;
  const parts = value.split('; XSRF-TOKEN=');
  if (parts.length === 2) return decodeURIComponent(parts.pop().split(';').shift());
  return '';
}
</script>
@endsection
