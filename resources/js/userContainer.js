// userContainer.js
import { ContainerManager } from "./container-manager.js";

export class UserContainerManager extends ContainerManager {
  constructor(containerId, overlayId, buttonId, frozenContainerIds = []) {
    super(containerId, overlayId, buttonId, frozenContainerIds);
    
    this.setupUserContainerStyles();
    this.isAnimating = false;
    this.button = document.getElementById(buttonId);
    this.setupUserListeners();
    this.user = null; // Store user data instead of boolean
    
    // Check auth status on initialization
    this.checkAuthStatus();
  }

  async checkAuthStatus() {
    try {
      const response = await fetch('auth-check', {
        credentials: 'same-origin'
      });
      const data = await response.json();
      
      this.user = data.authenticated ? data.user : null;
      //this.updateButtonState();
    } catch (error) {
      console.error('Auth check failed:', error);
      this.user = null;
    }
  }

  updateButtonState() {
    // Update button appearance based on auth state
    if (this.user) {
      this.button.textContent = this.user.name || 'Profile';
      this.button.style.backgroundColor = '#4EACAE'; // Logged in color
    } else {
      this.button.textContent = 'Login';
      this.button.style.backgroundColor = '#EF8D34'; // Not logged in color
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
    // Your existing click listeners...
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
      
      // Add overlay click handler
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
                 style="width: 100%; padding: 8px; margin-bottom: 10px; border-radius: 4px; border: 1px solid #444; background: #333; color: white;">
          <input type="password" id="loginPassword" placeholder="Password" required 
                 style="width: 100%; padding: 8px; margin-bottom: 15px; border-radius: 4px; border: 1px solid #444; background: #333; color: white;">
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
    
    this.container.innerHTML = loginHTML;
    this.openContainer("login");
  }

  showRegisterForm() {
    const registerHTML = `
      <div class="user-form">
        <h3 style="color: #EF8D34; margin-bottom: 15px;">Register</h3>
        <form id="register-form">
          <input type="text" id="registerName" placeholder="Name" required 
                 style="width: 100%; padding: 8px; margin-bottom: 10px; border-radius: 4px; border: 1px solid #444; background: #333; color: white;">
          <input type="email" id="registerEmail" placeholder="Email" required 
                 style="width: 100%; padding: 8px; margin-bottom: 10px; border-radius: 4px; border: 1px solid #444; background: #333; color: white;">
          <input type="password" id="registerPassword" placeholder="Password" required 
                 style="width: 100%; padding: 8px; margin-bottom: 15px; border-radius: 4px; border: 1px solid #444; background: #333; color: white;">
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
    
    this.container.innerHTML = registerHTML;
    this.openContainer("register");
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
    
    this.container.innerHTML = profileHTML;
    this.openContainer("profile");
  }

  async handleLogin() {
    const email = document.getElementById('loginEmail').value;
    const password = document.getElementById('loginPassword').value;
    
    const csrfToken = document.querySelector('meta[name="csrf-token"]');
    console.log('CSRF token found:', !!csrfToken);
    
    if (!csrfToken || !csrfToken.content) {
      this.showLoginError('CSRF token not found. Please refresh the page.');
      return;
    }
    
    try {
      const response = await fetch('/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-TOKEN': csrfToken.content,
          'Accept': 'application/json'
        },
        credentials: 'same-origin',
        body: JSON.stringify({ email, password })
      });

      console.log('Response status:', response.status);
      
      if (response.status === 419) {
        this.showLoginError('Session expired. Please refresh the page.');
        return;
      }
      
      const responseText = await response.text();
      console.log('Raw response:', responseText);
      
      let data;
      try {
        data = JSON.parse(responseText);
      } catch (parseError) {
        console.error('Failed to parse JSON:', parseError);
        this.showLoginError('Server returned invalid response');
        return;
      }
      
      // Handle Fortify's response format
      if (response.status === 200 && data.two_factor === false) {
        // Login successful with Fortify
        console.log('Login successful via Fortify');
        
        // Get user data from your auth check endpoint
        await this.checkAuthStatus();
        
        if (this.user) {
          this.showUserProfile();
        } else {
          this.showLoginError('Login successful but could not retrieve user data');
        }
      } else if (response.status === 422) {
        // Validation errors
        this.showLoginError(data.errors || 'Validation failed');
      } else {
        // Other errors
        this.showLoginError(data.message || 'Login failed');
      }
    } catch (error) {
      console.error('Login error:', error);
      this.showLoginError('Network error occurred');
    }
  }

  async handleRegister() {
    const name = document.getElementById('registerName').value;
    const email = document.getElementById('registerEmail').value;
    const password = document.getElementById('registerPassword').value;
    
    const csrfToken = document.querySelector('meta[name="csrf-token"]');
    
    try {
      const response = await fetch('/register', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-TOKEN': csrfToken.content,
          'Accept': 'application/json'
        },
        credentials: 'same-origin',
        body: JSON.stringify({ 
          name, 
          email, 
          password, 
          password_confirmation: password 
        })
      });

      const responseText = await response.text();
      const data = JSON.parse(responseText);
      
      if (response.status === 201 || response.status === 200) {
        // Registration successful
        await this.checkAuthStatus();
        
        if (this.user) {
          this.showUserProfile();
        }
      } else if (response.status === 422) {
        // Validation errors
        this.showRegisterError(data.errors || 'Validation failed');
      } else {
        this.showRegisterError(data.message || 'Registration failed');
      }
    } catch (error) {
      console.error('Register error:', error);
      this.showRegisterError('Network error occurred');
    }
  }

  async handleLogout() {
    try {
      const response = await fetch('/logout', {
        method: 'POST',
        headers: {
          'X-CSRF-TOKEN': document.querySelector('meta[name="csrf-token"]').content
        },
        credentials: 'same-origin'
      });

      if (response.ok) {
        this.user = null;
        //this.updateButtonState();
        this.closeContainer();
      }
    } catch (error) {
      console.error('Logout error:', error);
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
    
    if (typeof errors === 'object') {
      errorDiv.innerHTML = Object.values(errors).flat().join('<br>');
    } else {
      errorDiv.textContent = errors;
    }
    
    const form = document.getElementById(formId);
    const existingError = form.querySelector('.error-message');
    if (existingError) existingError.remove();
    
    errorDiv.className = 'error-message';
    form.appendChild(errorDiv);
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

  // Keep your existing openContainer and closeContainer methods
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

      if (this.overlay) {
        this.overlay.classList.add("active");
      }

      this.isOpen = true;
      window.activeContainer = this.container.id;

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

    if (this.overlay) {
      this.overlay.classList.remove("active");
    }

    this.isOpen = false;
    window.activeContainer = "main-content";

    this.container.addEventListener("transitionend", () => {
      this.container.classList.add("hidden");
      this.container.style.visibility = "hidden";
      this.isAnimating = false;
    }, { once: true });
  }
}

// Initialize the user container manager
const userManager = new UserContainerManager(
  "user-container",
  "user-overlay", 
  "userButton",
  ["main-content"]
);

export default userManager;