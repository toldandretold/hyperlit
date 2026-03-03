// formTemplates.js - HTML templates for authentication forms

/**
 * Generates login form HTML with validation message placeholders
 * @returns {string} HTML string
 */
export function getLoginFormHTML() {
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

/**
 * Generates registration form HTML with validation message placeholders
 * @returns {string} HTML string
 */
export function getRegisterFormHTML() {
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

/**
 * Generates user profile HTML with My Library and Logout buttons
 * @returns {string} HTML string
 */
export function getProfileHTML() {
  return `
    <div class="user-profile">
      <button id="myBooksBtn" class="fucked-buttons"
              style="width: 100%; padding: 10px; background: var(--color-accent); color: var(--color-background); border: 1px solid var(--color-accent); border-radius: 4px; cursor: pointer; margin-bottom: 10px; box-sizing: border-box; transition: background-color 0.3s, color 0.3s; font-family: inherit;">
        My Library
      </button>
      <button id="logout" class="fucked-buttons"
              style="width: 100%; padding: 10px; background: transparent; color: var(--color-text); border: 1px solid var(--color-text); border-radius: 4px; cursor: pointer; box-sizing: border-box; transition: background-color 0.3s, color 0.3s, border-color 0.3s; font-family: inherit;">
        Logout
      </button>
    </div>
  `;
}

/**
 * Generates anonymous content transfer prompt HTML
 * @param {string[]} contentSummary - Array of content descriptions (e.g., ["2 books", "5 highlights"])
 * @returns {string} HTML string
 */
export function getTransferPromptHTML(contentSummary) {
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

/**
 * Generates book transfer confirmation modal HTML
 * @param {string} message - Confirmation message
 * @returns {string} HTML string
 */
export function getTransferConfirmationHTML(message) {
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

/**
 * Escape HTML special characters to prevent XSS
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/**
 * Generates forgot password form HTML
 * @returns {string} HTML string
 */
export function getForgotPasswordFormHTML() {
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

/**
 * Generates forgot password success HTML
 * @param {string} email - The email that was submitted (escaped to prevent XSS)
 * @returns {string} HTML string
 */
export function getForgotPasswordSentHTML(email) {
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

/**
 * Generates error message HTML for form errors
 * @param {string|object} errors - Error message or object with field-specific errors
 * @returns {string} HTML string
 */
export function getErrorHTML(errors) {
  let errorContent;

  if (typeof errors === 'object' && errors !== null) {
    const errorMessages = [];
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
