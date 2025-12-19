// formValidation.js - Authentication form validation utilities

/**
 * Validates username for URL safety and UX constraints
 * @param {string} username
 * @returns {{ valid: boolean, error: string|null }}
 */
export function validateUsername(username) {
  if (!username || username.trim() === '') {
    return { valid: false, error: 'Username is required' };
  }

  if (/\s/.test(username)) {
    return { valid: false, error: 'Username cannot contain spaces' };
  }

  if (username.length < 3) {
    return { valid: false, error: 'Username must be at least 3 characters' };
  }

  if (username.length > 30) {
    return { valid: false, error: 'Username must be 30 characters or less' };
  }

  if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
    return { valid: false, error: 'Username can only contain letters, numbers, hyphens, and underscores' };
  }

  if (/^[-_]|[-_]$/.test(username)) {
    return { valid: false, error: 'Username cannot start or end with - or _' };
  }

  return { valid: true, error: null };
}

/**
 * Validates email format
 * @param {string} email
 * @returns {{ valid: boolean, error: string|null }}
 */
export function validateEmail(email) {
  if (!email || email.trim() === '') {
    return { valid: false, error: 'Email is required' };
  }

  // Basic format: something@something.something, no multiple @
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return { valid: false, error: 'Please enter a valid email address' };
  }

  if (email.length > 255) {
    return { valid: false, error: 'Email must be less than 255 characters' };
  }

  return { valid: true, error: null };
}

/**
 * Validates password
 * @param {string} password
 * @param {boolean} isRegistration - If true, enforces minimum length
 * @returns {{ valid: boolean, error: string|null }}
 */
export function validatePassword(password, isRegistration = false) {
  if (!password) {
    return { valid: false, error: 'Password is required' };
  }

  if (isRegistration && password.length < 8) {
    return { valid: false, error: 'Password must be at least 8 characters' };
  }

  return { valid: true, error: null };
}

/**
 * Displays validation message for a form field
 * @param {string} elementId - The ID of the error display element (without 'Error' suffix)
 * @param {{ valid: boolean, error: string|null }} result - Validation result
 */
export function showValidationMessage(elementId, result) {
  const errorDiv = document.getElementById(`${elementId}Error`);
  if (!errorDiv) return;

  if (!result.valid && result.error) {
    errorDiv.textContent = result.error;
    errorDiv.style.display = 'block';

    // Also style the input field
    const input = document.getElementById(elementId);
    if (input) {
      input.style.outline = '2px solid var(--color-primary)';
    }
  } else {
    errorDiv.textContent = '';
    errorDiv.style.display = 'none';

    // Remove error styling from input
    const input = document.getElementById(elementId);
    if (input) {
      input.style.outline = 'none';
    }
  }
}

/**
 * Attaches real-time validation listeners to form inputs
 * @param {string} formType - 'login' or 'register'
 */
export function attachValidationListeners(formType) {
  const isRegistration = formType === 'register';

  // Email validation
  const emailId = isRegistration ? 'registerEmail' : 'loginEmail';
  const emailInput = document.getElementById(emailId);
  if (emailInput) {
    emailInput.addEventListener('input', () => {
      const result = validateEmail(emailInput.value);
      showValidationMessage(emailId, result);
    });
    emailInput.addEventListener('blur', () => {
      const result = validateEmail(emailInput.value);
      showValidationMessage(emailId, result);
    });
  }

  // Password validation
  const passwordId = isRegistration ? 'registerPassword' : 'loginPassword';
  const passwordInput = document.getElementById(passwordId);
  if (passwordInput) {
    passwordInput.addEventListener('input', () => {
      const result = validatePassword(passwordInput.value, isRegistration);
      showValidationMessage(passwordId, result);
    });
    passwordInput.addEventListener('blur', () => {
      const result = validatePassword(passwordInput.value, isRegistration);
      showValidationMessage(passwordId, result);
    });
  }

  // Username validation (registration only)
  if (isRegistration) {
    const usernameInput = document.getElementById('registerName');
    if (usernameInput) {
      usernameInput.addEventListener('input', () => {
        const result = validateUsername(usernameInput.value);
        showValidationMessage('registerName', result);
      });
      usernameInput.addEventListener('blur', () => {
        const result = validateUsername(usernameInput.value);
        showValidationMessage('registerName', result);
      });
    }
  }
}

/**
 * Validates all fields in a form before submission
 * @param {string} formType - 'login' or 'register'
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateForm(formType) {
  const errors = [];
  const isRegistration = formType === 'register';

  // Validate email
  const emailId = isRegistration ? 'registerEmail' : 'loginEmail';
  const emailInput = document.getElementById(emailId);
  if (emailInput) {
    const result = validateEmail(emailInput.value);
    showValidationMessage(emailId, result);
    if (!result.valid) errors.push(result.error);
  }

  // Validate password
  const passwordId = isRegistration ? 'registerPassword' : 'loginPassword';
  const passwordInput = document.getElementById(passwordId);
  if (passwordInput) {
    const result = validatePassword(passwordInput.value, isRegistration);
    showValidationMessage(passwordId, result);
    if (!result.valid) errors.push(result.error);
  }

  // Validate username (registration only)
  if (isRegistration) {
    const usernameInput = document.getElementById('registerName');
    if (usernameInput) {
      const result = validateUsername(usernameInput.value);
      showValidationMessage('registerName', result);
      if (!result.valid) errors.push(result.error);
    }
  }

  return { valid: errors.length === 0, errors };
}
