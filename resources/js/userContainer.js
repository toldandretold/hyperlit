// userContainer.js
import { ContainerManager } from "./container-manager.js";

export class UserContainerManager extends ContainerManager {
  constructor(containerId, overlayId, buttonId, frozenContainerIds = []) {
    super(containerId, overlayId, buttonId, frozenContainerIds);
    
    this.setupUserContainerStyles();
    this.isAnimating = false;
    this.button = document.getElementById(buttonId);
    this.setupUserListeners();
    this.user = null;
    
    // Initialize CSRF protection and then check auth
    this.initializeSanctum().then(() => {
      this.checkAuthStatus();
    });
  }

  async initializeSanctum() {
    try {
      await fetch('/sanctum/csrf-cookie', {
        credentials: 'include'
      });
    } catch (error) {
      console.error('Failed to initialize Sanctum:', error);
    }
  }

  async checkAuthStatus() {
    try {
      const response = await fetch('/auth-check', {
        credentials: 'include',
        headers: {
          'Accept': 'application/json',
          'X-Requested-With': 'XMLHttpRequest'
        }
      });
      
      if (response.ok) {
        const data = await response.json();
        this.user = data.authenticated ? data.user : null;
      } else {
        this.user = null;
      }
    } catch (error) {
      console.error('Auth check failed:', error);
      this.user = null;
    }
  }

  setupUserContainerStyles() {
    const container = this.container;
    if (!container) return;

    container.style.position = "fixed";
    container.style.transition = 
      "width 0.3s ease-out, height 0.3s ease-out, opacity 0.3s ease-out, padding 0.3s ease-out";
    container.style.zIndex = "1000";
    container.style.backgroundColor = "#221F20";
    container.style.boxShadow = "0 0 15px rgba(0, 0, 0, 0.2)";
    container.style.borderRadius = "0.75em";
    container.style.opacity = "0";
    container.style.padding = "12px";
    container.style.width = "0";
    container.style.height = "0";
  }

  setupUserListeners() {
    document.addEventListener('click', (e) => {
      if (e.target.id === 'loginSubmit') {
        e.preventDefault();
        this.handleLogin();
      }
      if (e.target.id === 'registerSubmit') {
        e.preventDefault();
        this.handleRegister();
      }
      if (e.target.id === 'showRegister') {
        e.preventDefault();
        this.showRegisterForm();
      }
      if (e.target.id === 'showLogin') {
        e.preventDefault();
        this.showLoginForm();
      }
      if (e.target.id === 'logout') {
        e.preventDefault();
        this.handleLogout();
      }
      
      if (e.target.id === 'user-overlay' && this.isOpen) {
        this.closeContainer();
      }
    });
  }

  showLoginForm() {
    const loginHTML = `
      <div class="user-form">
        <h3 style="color: #EF8D34; margin-bottom: 15px;">Login</h3>
        <form id="login-form">
          <input type="email" id="loginEmail" placeholder="Email" required 
                 style="width: 100%; padding: 8px; margin-bottom: 10px; border-radius: 4px; border: 1px solid #444; background: #333; color: white; box-sizing: border-box;">
          <input type="password" id="loginPassword" placeholder="Password" required 
                 style="width: 100%; padding: 8px; margin-bottom: 15px; border-radius: 4px; border: 1px solid #444; background: #333; color: white; box-sizing: border-box;">
          <button type="submit" id="loginSubmit" 
                  style="width: 100%; padding: 10px; background: #4EACAE; color: #221F20; border: none; border-radius: 4px; cursor: pointer; margin-bottom: 10px;">
            Login
          </button>
          <button type="button" id="showRegister" 
                  style="width: 100%; padding: 8px; background: transparent; color: #CBCCCC; border: 1px solid #444; border-radius: 4px; cursor: pointer;">
            Switch to Register
          </button>
        </form>
      </div>
    `;
    
    if (!this.isOpen) {
      this.container.innerHTML = loginHTML;
      this.openContainer("login");
    } else {
      this.container.innerHTML = loginHTML;
    }
  }

  showRegisterForm() {
    const registerHTML = `
      <div class="user-form">
        <h3 style="color: #EF8D34; margin-bottom: 15px;">Register</h3>
        <form id="register-form">
          <input type="text" id="registerName" placeholder="Name" required 
                 style="width: 100%; padding: 8px; margin-bottom: 10px; border-radius: 4px; border: 1px solid #444; background: #333; color: white; box-sizing: border-box;">
          <input type="email" id="registerEmail" placeholder="Email" required 
                 style="width: 100%; padding: 8px; margin-bottom: 10px; border-radius: 4px; border: 1px solid #444; background: #333; color: white; box-sizing: border-box;">
          <input type="password" id="registerPassword" placeholder="Password" required 
                 style="width: 100%; padding: 8px; margin-bottom: 15px; border-radius: 4px; border: 1px solid #444; background: #333; color: white; box-sizing: border-box;">
          <button type="submit" id="registerSubmit"
                  style="width: 100%; padding: 10px; background: #4EACAE; color: #221F20; border: none; border-radius: 4px; cursor: pointer; margin-bottom: 10px;">
            Register
          </button>
          <button type="button" id="showLogin" 
                  style="width: 100%; padding: 8px; background: transparent; color: #CBCCCC; border: 1px solid #444; border-radius: 4px; cursor: pointer;">
            Switch to Login
          </button>
        </form>
      </div>
    `;
    
    if (!this.isOpen) {
      this.container.innerHTML = registerHTML;
      this.openContainer("register");
    } else {
      this.container.innerHTML = registerHTML;
    }
  }

  showUserProfile() {
    const profileHTML = `
      <div class="user-profile">
        <h3 style="color: #EF8D34; margin-bottom: 15px;">Welcome, ${this.user.name}!</h3>
        <div style="margin-bottom: 15px;">
          <div style="border-top: 1px solid #444; padding-top: 15px;">
            <button style="width: 100%; padding: 8px; background: transparent; color: #CBCCCC; border: 1px solid #444; border-radius: 4px; cursor: pointer; margin-bottom: 8px;">
              Account Settings
            </button>
            <button style="width: 100%; padding: 8px; background: transparent; color: #CBCCCC; border: 1px solid #444; border-radius: 4px; cursor: pointer; margin-bottom: 8px;">
              My Books
            </button>
            <button id="logout" 
                    style="width: 100%; padding: 8px; background: #EE4A95; color: white; border: none; border-radius: 4px; cursor: pointer;">
              Logout
            </button>
          </div>
        </div>
      </div>
    `;
    
    if (!this.isOpen) {
      this.container.innerHTML = profileHTML;
      this.openContainer("profile");
    } else {
      this.container.innerHTML = profileHTML;
    }
  }

  // Add this helper function to extract CSRF token from cookie
  getCsrfTokenFromCookie() {
    const value = `; ${document.cookie}`;
    const parts = value.split(`; XSRF-TOKEN=`);
    if (parts.length === 2) {
      return decodeURIComponent(parts.pop().split(';').shift());
    }
    return null;
  }

  async handleLogin() {
    const email = document.getElementById('loginEmail').value;
    const password = document.getElementById('loginPassword').value;
    
    try {
      // First, get the CSRF cookie
      console.log('Getting CSRF cookie...');
      await fetch('/sanctum/csrf-cookie', {
        credentials: 'include'
      });
      
      // Get the CSRF token from the cookie
      const csrfToken = this.getCsrfTokenFromCookie();
      console.log('CSRF token from cookie:', csrfToken);
      
      console.log('Making login request...');
      const response = await fetch('/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
          'X-XSRF-TOKEN': csrfToken  // Add this header
        },
        credentials: 'include',
        body: JSON.stringify({ email, password })
      });

      console.log('Response status:', response.status);
      const data = await response.json();
      console.log('Response data:', data);
      
      if (response.ok && data.success) {
        this.user = data.user;
        this.showUserProfile();
      } else {
        this.showLoginError(data.errors || data.message || 'Login failed');
      }
      
    } catch (error) {
      console.error('Login error:', error);
      this.showLoginError('Network error occurred');
    }
  }

  // Update handleRegister similarly
  async handleRegister() {
    const name = document.getElementById('registerName').value;
    const email = document.getElementById('registerEmail').value;
    const password = document.getElementById('registerPassword').value;
    
    try {
      await fetch('/sanctum/csrf-cookie', {
        credentials: 'include'
      });
      
      const csrfToken = this.getCsrfTokenFromCookie();
      
      const response = await fetch('/register', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
          'X-XSRF-TOKEN': csrfToken  // Add this header
        },
        credentials: 'include',
        body: JSON.stringify({ name, email, password })
      });

      const data = await response.json();
      
      if (response.ok && data.success) {
        this.user = data.user;
        this.showUserProfile();
      } else {
        this.showRegisterError(data.errors || data.message || 'Registration failed');
      }
      
    } catch (error) {
      console.error('Register error:', error);
      this.showRegisterError('Network error occurred');
    }
  }

  async handleLogout() {
    try {
      // Get fresh CSRF token for logout
      await fetch('/sanctum/csrf-cookie', {
        credentials: 'include'
      });
      
      const csrfToken = this.getCsrfTokenFromCookie();
      console.log('Logout CSRF token:', csrfToken);
      
      const response = await fetch('/logout', {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
          'X-XSRF-TOKEN': csrfToken  // Add this header
        },
        credentials: 'include'
      });

      console.log('Logout response status:', response.status);
      
      if (response.ok) {
        this.user = null;
        this.closeContainer();
      } else {
        console.error('Logout failed:', response.status);
        // Still clear local state even if server logout failed
        this.user = null;
        this.closeContainer();
      }
      
    } catch (error) {
      console.error('Logout error:', error);
      // Still clear local state
      this.user = null;
      this.closeContainer();
    }
  }

  showLoginError(errors) {
    this.showError(errors, 'login-form');
  }

  showRegisterError(errors) {
    this.showError(errors, 'register-form');
  }

  showError(errors, formId) {
    const errorDiv = document.createElement('div');
    errorDiv.style.cssText = `
      color: #EE4A95; 
      font-size: 12px; 
      margin-top: 10px; 
      padding: 8px; 
      background: rgba(238, 74, 149, 0.1); 
      border-radius: 4px;
    `;
    
    if (typeof errors === 'object' && errors !== null) {
      const errorMessages = [];
      for (const [field, messages] of Object.entries(errors)) {
        if (Array.isArray(messages)) {
          errorMessages.push(...messages);
        } else {
          errorMessages.push(messages);
        }
      }
      errorDiv.innerHTML = errorMessages.join('<br>');
    } else {
      errorDiv.textContent = errors || 'An error occurred';
    }
    
    const form = document.getElementById(formId);
    if (form) {
      const existingError = form.querySelector('.error-message');
      if (existingError) existingError.remove();
      
      errorDiv.className = 'error-message';
      form.appendChild(errorDiv);
    }
  }

  toggleContainer() {
    if (this.isOpen) {
      this.closeContainer();
    } else {
      if (this.user) {
        this.showUserProfile();
      } else {
        this.showLoginForm();
      }
    }
  }

  openContainer(mode = "login") {
    if (this.isAnimating) return;
    this.isAnimating = true;

    const rect = this.button.getBoundingClientRect();
    this.container.style.top = `${rect.bottom + 8}px`;
    this.container.style.left = `${rect.left}px`;

    this.container.classList.remove("hidden");
    this.container.style.visibility = "visible";
    this.container.style.display = "";

    let targetWidth, targetHeight;
    if (mode === "login" || mode === "register") {
      targetWidth = "280px";
      targetHeight = "auto";
      this.container.style.padding = "20px";
    } else if (mode === "profile") {
      targetWidth = "300px";
      targetHeight = "auto";
      this.container.style.padding = "20px";
    }

    requestAnimationFrame(() => {
      this.container.style.width = targetWidth;
      this.container.style.height = targetHeight;
      this.container.style.opacity = "1";

      this.isOpen = true;
      window.activeContainer = this.container.id;
      this.updateState();

      this.container.addEventListener("transitionend", () => {
        this.isAnimating = false;
      }, { once: true });
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
}

const userManager = new UserContainerManager(
  "user-container",
  "user-overlay", 
  "userButton",
  ["main-content"]
);

export default userManager;