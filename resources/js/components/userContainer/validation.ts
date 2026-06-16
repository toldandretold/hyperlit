// validation.ts - Authentication form validation utilities (username / email /
// password), real-time listener attachment, and pre-submit validation. Pure
// leaf module (was userContainer/formValidation.js).

type ValidationResult = { valid: boolean; error: string | null };

/** Validates username for URL safety and UX constraints */
export function validateUsername(username: string): ValidationResult {
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

/** Validates email format */
export function validateEmail(email: string): ValidationResult {
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

/** Validates password (enforces minimum length on registration) */
export function validatePassword(password: string, isRegistration = false): ValidationResult {
  if (!password) {
    return { valid: false, error: 'Password is required' };
  }

  if (isRegistration && password.length < 8) {
    return { valid: false, error: 'Password must be at least 8 characters' };
  }

  return { valid: true, error: null };
}

/** Displays validation message for a form field */
export function showValidationMessage(elementId: string, result: ValidationResult) {
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

/** Attaches real-time validation listeners to form inputs */
export function attachValidationListeners(formType: string) {
  const isRegistration = formType === 'register';

  // Email validation
  const emailId = isRegistration ? 'registerEmail' : 'loginEmail';
  const emailInput = document.getElementById(emailId) as HTMLInputElement | null;
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
  const passwordInput = document.getElementById(passwordId) as HTMLInputElement | null;
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
    const usernameInput = document.getElementById('registerName') as HTMLInputElement | null;
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

/** Validates all fields in a form before submission */
export function validateForm(formType: string): { valid: boolean; errors: (string | null)[] } {
  const errors: (string | null)[] = [];
  const isRegistration = formType === 'register';

  // Validate email
  const emailId = isRegistration ? 'registerEmail' : 'loginEmail';
  const emailInput = document.getElementById(emailId) as HTMLInputElement | null;
  if (emailInput) {
    const result = validateEmail(emailInput.value);
    showValidationMessage(emailId, result);
    if (!result.valid) errors.push(result.error);
  }

  // Validate password
  const passwordId = isRegistration ? 'registerPassword' : 'loginPassword';
  const passwordInput = document.getElementById(passwordId) as HTMLInputElement | null;
  if (passwordInput) {
    const result = validatePassword(passwordInput.value, isRegistration);
    showValidationMessage(passwordId, result);
    if (!result.valid) errors.push(result.error);
  }

  // Validate username (registration only)
  if (isRegistration) {
    const usernameInput = document.getElementById('registerName') as HTMLInputElement | null;
    if (usernameInput) {
      const result = validateUsername(usernameInput.value);
      showValidationMessage('registerName', result);
      if (!result.valid) errors.push(result.error);
    }
  }

  return { valid: errors.length === 0, errors };
}
