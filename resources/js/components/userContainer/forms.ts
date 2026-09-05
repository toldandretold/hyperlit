// forms.ts - HTML templates for the user-container authentication forms
// (login / register / profile / transfer / forgot-password / verify-email /
// change-email / error). Pure string builders — no DOM side effects. Leaf
// module (was userContainer/formTemplates.js).

/** Generates login form HTML with validation message placeholders */
export function getLoginFormHTML(): string {
  return `
    <div class="user-form">
      <h3 style="color: var(--color-secondary); margin-bottom: 15px;">Login</h3>
      <form id="login-form-embedded" action="/login" method="post" autocomplete="on">
        <div style="margin-bottom: 10px;">
          <input type="email" id="loginEmail" name="email" placeholder="Email" required autocomplete="email"
                 style="width: 100%; padding: 8px; border-radius: 4px; border: none; background: var(--container-solid-bg); color: var(--color-text); box-sizing: border-box;">
          <div id="loginEmailError" style="font-size: 11px; color: var(--color-primary); margin-top: 4px; display: none;"></div>
        </div>
        <div style="margin-bottom: 15px;">
          <input type="password" id="loginPassword" name="password" placeholder="Password" required autocomplete="current-password"
                 style="width: 100%; padding: 8px; border-radius: 4px; border: none; background: var(--container-solid-bg); color: var(--color-text); box-sizing: border-box;">
          <div id="loginPasswordError" style="font-size: 11px; color: var(--color-primary); margin-top: 4px; display: none;"></div>
        </div>
        <button type="submit" id="loginSubmit"
                style="width: 100%; padding: 10px; background: var(--color-accent); color: var(--color-background); border: none; border-radius: 4px; cursor: pointer; margin-bottom: 10px;">
          Login
        </button>
        <button type="button" id="showRegister"
                style="width: 100%; padding: 8px; background: transparent; color: var(--color-text); border: 1px solid var(--color-text); border-radius: 4px; cursor: pointer; margin-bottom: 8px;">
          Switch to Register
        </button>
        <button type="button" id="showForgotPassword"
                style="width: 100%; padding: 6px; background: transparent; color: var(--color-text); opacity: 0.6; border: none; border-radius: 4px; cursor: pointer; font-size: 12px;">
          Forgot password?
        </button>
      </form>
    </div>
  `;
}

/** Generates registration form HTML with validation message placeholders */
export function getRegisterFormHTML(): string {
  return `
    <div class="user-form">
      <h3 style="color: var(--color-secondary); margin-bottom: 15px;">Register</h3>
      <form id="register-form-embedded" action="/register" method="post" autocomplete="on">
        <div style="margin-bottom: 10px;">
          <input type="text" id="registerName" name="nickname" placeholder="Username" required autocomplete="nickname"
                 style="width: 100%; padding: 8px; border-radius: 4px; border: none; background: var(--container-solid-bg); color: var(--color-text); box-sizing: border-box;">
          <div style="font-size: 11px; color: var(--color-text); opacity: 0.6; margin-top: 4px; line-height: 1.3;">
            Used publicly when sharing hypertext (e.g., /u/username)
          </div>
          <div id="registerNameError" style="font-size: 11px; color: var(--color-primary); margin-top: 4px; display: none;"></div>
        </div>
        <div style="margin-bottom: 10px;">
          <input type="email" id="registerEmail" name="email" placeholder="Email" required autocomplete="email"
                 style="width: 100%; padding: 8px; border-radius: 4px; border: none; background: var(--container-solid-bg); color: var(--color-text); box-sizing: border-box;">
          <div id="registerEmailError" style="font-size: 11px; color: var(--color-primary); margin-top: 4px; display: none;"></div>
        </div>
        <div style="margin-bottom: 15px;">
          <input type="password" id="registerPassword" name="password" placeholder="Password" required autocomplete="new-password"
                 style="width: 100%; padding: 8px; border-radius: 4px; border: none; background: var(--container-solid-bg); color: var(--color-text); box-sizing: border-box;">
          <div id="registerPasswordError" style="font-size: 11px; color: var(--color-primary); margin-top: 4px; display: none;"></div>
        </div>
        <button type="submit" id="registerSubmit"
                style="width: 100%; padding: 10px; background: var(--color-accent); color: var(--color-background); border: none; border-radius: 4px; cursor: pointer; margin-bottom: 10px;">
          Register
        </button>
        <button type="button" id="showLogin"
                style="width: 100%; padding: 8px; background: transparent; color: var(--color-text); border: 1px solid var(--color-text); border-radius: 4px; cursor: pointer;">
          Switch to Login
        </button>
      </form>
    </div>
  `;
}

/** Generates user profile HTML with My Library and Logout buttons */
// Profile rows are .menu-row-btn — the ONE shared row contract
// (resources/css/components/menuRow.css) also used by the logo-nav rows and
// the new-book panel. Look, hover, and selected state come from the class;
// only per-row exceptions (Verify Email's secondary color) are inline.
// Row spacing: .user-profile is a flex column with gap (referenceOverlay.css).

// Stroke icon family (matches the nav "+" and the Blank/Import glyphs).
// currentColor, so each row's text color (accent-inverse, secondary…) carries
// through to its icon.
const profileIcon = (paths: string): string =>
  `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex-shrink: 0;">${paths}</svg>`;

const ICON_LIBRARY = profileIcon('<path d="M4 4v16"/><path d="M8 8v12"/><path d="M12 6v14"/><path d="m16 6 4 14"/>');
const ICON_MAIL = profileIcon('<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/>');
const ICON_KEY = profileIcon('<path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z"/><circle cx="16.5" cy="7.5" r=".5" fill="currentColor"/>');
const ICON_LOGOUT = profileIcon('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>');

export function getProfileHTML(emailVerified = true): string {
  const verifyBanner = emailVerified ? '' : `
      <button id="verifyEmailBtn" class="menu-row-btn" style="color: var(--color-secondary);">
        ${ICON_MAIL}
        Verify Email
      </button>`;
  return `
    <div class="user-profile">
      <button id="myBooksBtn" class="menu-row-btn">
        ${ICON_LIBRARY}
        My Library
      </button>${verifyBanner}
      <button id="passkeysBtn" class="menu-row-btn">
        ${ICON_KEY}
        Passkeys
      </button>
      <button id="logout" class="menu-row-btn">
        ${ICON_LOGOUT}
        Logout
      </button>
    </div>
  `;
}

/** Generates anonymous content transfer prompt HTML */
export function getTransferPromptHTML(contentSummary: string[]): string {
  return `
    <div class="user-form">
      <h3 style="color: var(--color-secondary); margin-bottom: 15px;">Welcome back!</h3>
      <p style="margin-bottom: 20px; line-height: 1.4; color: var(--color-text);">
        You created ${contentSummary.join(', ')} while logged out. Would you like to bring them into your account?
      </p>
      <button id="confirmContentTransfer"
              style="width: 100%; padding: 10px; background: var(--color-accent); color: var(--color-background); border: none; border-radius: 4px; cursor: pointer; margin-bottom: 10px;">
        Yes, bring them in
      </button>
      <button id="skipContentTransfer"
              style="width: 100%; padding: 8px; background: transparent; color: var(--color-text); border: 1px solid var(--color-text); border-radius: 4px; cursor: pointer;">
        Skip for now
      </button>
    </div>
  `;
}

/** Generates book transfer confirmation modal HTML */
export function getTransferConfirmationHTML(message: string): string {
  return `
    <div style="background: var(--container-solid-bg); padding: 20px; border-radius: 8px; max-width: 400px; color: var(--color-text);">
      <h3 style="color: var(--color-secondary); margin-bottom: 15px;">Transfer Anonymous Books?</h3>
      <p style="margin-bottom: 20px; line-height: 1.4;">${message}</p>
      <div style="display: flex; gap: 10px; justify-content: flex-end;">
        <button id="cancelTransfer"
                style="padding: 8px 16px; background: transparent; color: var(--color-text); border: 1px solid var(--color-text); border-radius: 4px; cursor: pointer;">
          Cancel
        </button>
        <button id="confirmTransfer"
                style="padding: 8px 16px; background: var(--color-accent); color: var(--color-background); border: none; border-radius: 4px; cursor: pointer;">
          Transfer Books
        </button>
      </div>
    </div>
  `;
}

/** Escape HTML special characters to prevent XSS */
function escapeHtml(str: string): string {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/** Generates forgot password form HTML */
export function getForgotPasswordFormHTML(): string {
  return `
    <div class="user-form">
      <h3 style="color: var(--color-secondary); margin-bottom: 10px;">Reset Password</h3>
      <p style="font-size: 12px; color: var(--color-text); opacity: 0.7; margin-bottom: 16px; line-height: 1.4;">
        Enter your email and we'll send you a reset link.
      </p>
      <form id="forgot-password-form" autocomplete="on">
        <div style="margin-bottom: 15px;">
          <input type="email" id="forgotEmail" name="email" placeholder="Email" required autocomplete="email"
                 style="width: 100%; padding: 8px; border-radius: 4px; border: none; background: var(--container-solid-bg); color: var(--color-text); box-sizing: border-box;">
          <div id="forgotEmailError" style="font-size: 11px; color: var(--color-primary); margin-top: 4px; display: none;"></div>
        </div>
        <button type="submit" id="forgotPasswordSubmit"
                style="width: 100%; padding: 10px; background: var(--color-accent); color: var(--color-background); border: none; border-radius: 4px; cursor: pointer; margin-bottom: 10px;">
          Send Reset Link
        </button>
        <button type="button" id="backToLogin"
                style="width: 100%; padding: 8px; background: transparent; color: var(--color-text); border: 1px solid var(--color-text); border-radius: 4px; cursor: pointer;">
          Back to Login
        </button>
      </form>
    </div>
  `;
}

/** Generates forgot password success HTML (email is escaped to prevent XSS) */
export function getForgotPasswordSentHTML(email: string): string {
  const safeEmail = escapeHtml(email);
  return `
    <div class="user-form">
      <h3 style="color: var(--color-secondary); margin-bottom: 10px;">Check your email</h3>
      <p style="font-size: 13px; color: var(--color-text); line-height: 1.5; margin-bottom: 20px;">
        If <strong>${safeEmail}</strong> is registered, you'll receive a reset link shortly. Check your spam folder too.
      </p>
      <button type="button" id="backToLogin"
              style="width: 100%; padding: 8px; background: transparent; color: var(--color-text); border: 1px solid var(--color-text); border-radius: 4px; cursor: pointer;">
        Back to Login
      </button>
    </div>
  `;
}

/** Generates verify email prompt HTML shown after registration */
export function getVerifyEmailHTML(email: string): string {
  const safeEmail = escapeHtml(email);
  return `
    <div class="user-form">
      <h3 style="color: var(--color-secondary); margin-bottom: 10px;">Verify your email</h3>
      <p style="font-size: 13px; color: var(--color-text); line-height: 1.5; margin-bottom: 20px;">
        We sent a verification link to <strong>${safeEmail}</strong>. Check your inbox (and spam folder).
      </p>
      <button type="button" id="resendVerification"
              style="width: 100%; padding: 10px; background: var(--color-accent); color: var(--color-background); border: none; border-radius: 4px; cursor: pointer; margin-bottom: 10px;">
        Resend Email
      </button>
      <button type="button" id="changeEmailBtn"
              style="width: 100%; padding: 8px; background: transparent; color: var(--color-text); border: 1px solid var(--color-text); border-radius: 4px; cursor: pointer; margin-bottom: 8px;">
        Change Email
      </button>
      <button type="button" id="dismissVerification"
              style="width: 100%; padding: 6px; background: transparent; color: var(--color-text); opacity: 0.6; border: none; border-radius: 4px; cursor: pointer; font-size: 12px;">
        I'll do this later
      </button>
    </div>
  `;
}

/** Generates change email form HTML */
export function getChangeEmailHTML(currentEmail: string): string {
  const safeEmail = escapeHtml(currentEmail);
  return `
    <div class="user-form">
      <h3 style="color: var(--color-secondary); margin-bottom: 10px;">Change Email</h3>
      <p style="font-size: 12px; color: var(--color-text); opacity: 0.7; margin-bottom: 12px; line-height: 1.4;">
        Current: <strong>${safeEmail}</strong>
      </p>
      <form id="change-email-form" autocomplete="on">
        <div style="margin-bottom: 15px;">
          <input type="email" id="newEmailInput" name="email" placeholder="New email address" required autocomplete="email"
                 style="width: 100%; padding: 8px; border-radius: 4px; border: none; background: var(--container-solid-bg); color: var(--color-text); box-sizing: border-box;">
          <div id="changeEmailError" style="font-size: 11px; color: var(--color-primary); margin-top: 4px; display: none;"></div>
        </div>
        <button type="submit" id="changeEmailSubmit"
                style="width: 100%; padding: 10px; background: var(--color-accent); color: var(--color-background); border: none; border-radius: 4px; cursor: pointer; margin-bottom: 10px;">
          Update & Resend
        </button>
        <button type="button" id="backToVerify"
                style="width: 100%; padding: 8px; background: transparent; color: var(--color-text); border: 1px solid var(--color-text); border-radius: 4px; cursor: pointer;">
          Back
        </button>
      </form>
    </div>
  `;
}

/** Generates error message HTML for form errors */
export function getErrorHTML(errors: any): string {
  let errorContent;

  if (typeof errors === 'object' && errors !== null) {
    const errorMessages: any[] = [];
    for (const [field, messages] of Object.entries(errors)) {
      if (Array.isArray(messages)) {
        errorMessages.push(...messages);
      } else {
        errorMessages.push(messages);
      }
    }
    errorContent = errorMessages.join('<br>');
  } else {
    errorContent = errors || 'An error occurred';
  }

  return `
    <div class="error-message" style="
      color: var(--color-primary);
      font-size: 12px;
      margin-top: 10px;
      padding: 8px;
      background: rgba(238, 74, 149, 0.1);
      border-radius: 4px;
    ">${errorContent}</div>
  `;
}
