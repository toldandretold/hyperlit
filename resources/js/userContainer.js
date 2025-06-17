// userContainer.js
import { ContainerManager } from "./container-manager.js";

export class UserContainerManager extends ContainerManager {
  constructor(containerId, overlayId, buttonId, frozenContainerIds = []) {
    super(containerId, overlayId, buttonId, frozenContainerIds);
    
    // Add cycle tracking
    this.loginCycleCount = parseInt(localStorage.getItem('loginCycleCount') || '0');
    console.log('🔄 Login cycle count on init:', this.loginCycleCount);

    this.setupUserContainerStyles();
    this.isAnimating = false;
    this.button = document.getElementById(buttonId);
    this.setupUserListeners();
    this.user = null;
    
    // Check auth status on initialization
    this.checkAuthStatus();
  }

  async checkAuthStatus() {
    try {
      const response = await fetch('/auth-check', {
        credentials: 'same-origin',
        headers: {
          'Accept': 'application/json',
          'X-Requested-With': 'XMLHttpRequest'
        }
      });
      
      if (response.ok) {
        const data = await response.json();
        this.user = data.authenticated ? data.user : null;
        //this.updateButtonState();
      } else {
        this.user = null;
        //this.updateButtonState();
      }
    } catch (error) {
      console.error('Auth check failed:', error);
      this.user = null;
      //this.updateButtonState();
    }
  }

  updateButtonState() {
    if (this.user) {
      this.button.textContent = this.user.name || 'Profile';
      this.button.style.backgroundColor = '#4EACAE';
    } else {
      this.button.textContent = 'Login';
      this.button.style.backgroundColor = '#EF8D34';
    }
  }

  // Get current CSRF token
  getCsrfToken() {
    const csrfMeta = document.querySelector('meta[name="csrf-token"]');
    return csrfMeta ? csrfMeta.getAttribute('content') : null;
  }

  // Update CSRF token
  updateCsrfToken(newToken) {
    const csrfMeta = document.querySelector('meta[name="csrf-token"]');
    if (csrfMeta && newToken) {
      csrfMeta.setAttribute('content', newToken);
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
      console.log('Click detected on:', e.target.id, e.target);
      
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
      
      // ADD DEBUGGING HERE
      if (e.target.id === 'user-overlay' && this.isOpen) {
        console.log('Overlay clicked, isOpen:', this.isOpen);
        console.log('Container state:', this.container.style.visibility);
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
    
    // ONLY call openContainer if the container is not already open
  if (!this.isOpen) {
    this.container.innerHTML = loginHTML;
    this.openContainer("login");
  } else {
    // Just update the content if already open
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
    
    // ONLY call openContainer if the container is not already open
    if (!this.isOpen) {
      this.container.innerHTML = registerHTML;
      this.openContainer("register");
    } else {
      // Just update the content if already open
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
    // ONLY call openContainer if the container is not already open
  if (!this.isOpen) {
    this.container.innerHTML = profileHTML;
    this.openContainer("profile");
  } else {
    // Just update the content if already open
    this.container.innerHTML = profileHTML;
  }
}
    

  async handleLogin() {
    // Increment and track cycle count
    this.loginCycleCount++;
    localStorage.setItem('loginCycleCount', this.loginCycleCount.toString());
    console.log('🔄 Login attempt #', this.loginCycleCount);

    const email = document.getElementById('loginEmail').value;
    const password = document.getElementById('loginPassword').value;
    
    const csrfToken = this.getCsrfToken();
    
    if (!csrfToken) {
      this.showLoginError('CSRF token not found. Please refresh the page.');
      return;
    }
    
    try {
      const response = await fetch('/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-TOKEN': csrfToken,
          'Accept': 'application/json',
          'X-Requested-With': 'XMLHttpRequest'
        },
        credentials: 'same-origin',
        body: JSON.stringify({ email, password })
      });

      console.log('📡 Login response #' + this.loginCycleCount + ' status:', response.status);
      console.log('📡 Response headers:', Object.fromEntries(response.headers.entries()));
      
      // Check content type before parsing
      const contentType = response.headers.get('content-type');
      console.log('📄 Content-Type:', contentType);
      
      if (contentType && contentType.includes('application/json')) {
        const data = await response.json();
        console.log('📦 Login response #' + this.loginCycleCount + ' data:', data);
        
        // Update CSRF token if provided
        if (data.csrf_token) {
          this.updateCsrfToken(data.csrf_token);
        }
        
        if (response.ok) {
          // Handle JSON success response
          if (data.two_factor === false || data.success) {
            console.log('✅ Login successful via JSON response');
            await this.checkAuthStatus();
            
            if (this.user) {
              this.showUserProfile();
            } else {
              this.showLoginError('Login successful but could not retrieve user data');
            }
          } else {
            this.showLoginError(data.message || 'Login failed');
          }
        } else if (response.status === 422) {
          this.showLoginError(data.errors || data.message || 'Validation failed');
        } else if (response.status === 419) {
          this.showLoginError('Session expired. Please refresh the page.');
        } else {
          this.showLoginError(data.message || 'Login failed');
        }
        
      } else {
        // Server returned HTML (probably a redirect)
        const htmlText = await response.text();
        console.log('📄 Received HTML instead of JSON:', htmlText.substring(0, 200) + '...');
        
        if (response.ok) {
          // If status is 200 but we got HTML, login probably succeeded
          // but Laravel is trying to redirect
          console.log('✅ Login likely successful (got HTML redirect)');
          await this.checkAuthStatus();
          
          if (this.user) {
            this.showUserProfile();
          } else {
            this.showLoginError('Login may have succeeded but received unexpected response');
          }
        } else {
          this.showLoginError('Server returned unexpected response format');
        }
      }
      
    } catch (error) {
      console.error('💥 Login error #' + this.loginCycleCount + ':', error);
      this.showLoginError('Network error occurred: ' + error.message);
    }
  }

  async handleRegister() {
    const name = document.getElementById('registerName').value;
    const email = document.getElementById('registerEmail').value;
    const password = document.getElementById('registerPassword').value;
    
    const csrfToken = this.getCsrfToken();
    
    if (!csrfToken) {
      this.showRegisterError('CSRF token not found. Please refresh the page.');
      return;
    }
    
    try {
      const response = await fetch('/register', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-TOKEN': csrfToken,
          'Accept': 'application/json',
          'X-Requested-With': 'XMLHttpRequest'
        },
        credentials: 'same-origin',
        body: JSON.stringify({ 
          name, 
          email, 
          password, 
          password_confirmation: password 
        })
      });

      const data = await response.json();
      
      // Update CSRF token if provided
      if (data.csrf_token) {
        this.updateCsrfToken(data.csrf_token);
      }
      
      if (response.ok) {
        // Registration successful
        await this.checkAuthStatus();
        
        if (this.user) {
          this.showUserProfile();
        }
      } else if (response.status === 422) {
        this.showRegisterError(data.errors || data.message || 'Validation failed');
      } else {
        this.showRegisterError(data.message || 'Registration failed');
      }
    } catch (error) {
      console.error('Register error:', error);
      this.showRegisterError('Network error occurred');
    }
  }

  async handleLogout() {
    console.log('🚪 Logout for cycle #' + this.loginCycleCount);
    
    try {
      // Get current token
      const csrfToken = this.getCsrfToken();
      console.log('🔑 Using CSRF token for logout:', csrfToken);
      
      const response = await fetch('/logout', {
        method: 'POST',
        headers: {
          'X-CSRF-TOKEN': csrfToken,
          'Accept': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
          'Content-Type': 'application/json'
        },
        credentials: 'same-origin'
      });

      console.log('📡 Logout response status:', response.status);
      
      if (response.ok) {
        console.log('✅ Logout successful');
        const data = await response.json();
        
        // Update CSRF token if provided
        if (data.csrf_token) {
          console.log('🔄 Updating CSRF token after logout');
          this.updateCsrfToken(data.csrf_token);
        }
        
      } else if (response.status === 419) {
        console.log('⚠️ CSRF token expired during logout (this is normal)');
        // This is actually expected behavior - session was already invalid
      } else {
        console.warn('⚠️ Logout returned status:', response.status);
      }
      
    } catch (error) {
      console.log('⚠️ Logout network error (might be normal):', error.message);
    }
    
    // Always clear local state regardless of server response
    console.log('🧹 Clearing local user state');
    this.user = null;
    //this.updateButtonState();
    this.closeContainer();
    
    // Refresh CSRF token for future requests
    console.log('🔄 Refreshing CSRF token after logout');
    await this.refreshCsrfToken();
    
    console.log('✅ Logout process complete');
  }

  async refreshCsrfToken() {
    console.log('🔄 Attempting to refresh CSRF token...');
    console.log('Current CSRF token:', this.getCsrfToken());
    
    try {
      const response = await fetch('/refresh-csrf', {
        method: 'GET',
        credentials: 'same-origin',
        headers: {
          'Accept': 'application/json',
          'X-Requested-With': 'XMLHttpRequest'
        }
      });
      
      console.log('📡 Response status:', response.status);
      console.log('📡 Response headers:', Object.fromEntries(response.headers.entries()));
      
      if (response.ok) {
        const contentType = response.headers.get('content-type');
        console.log('📄 Content-Type:', contentType);
        
        if (contentType && contentType.includes('application/json')) {
          const data = await response.json();
          console.log('📦 Response data:', data);
          
          if (data.csrf_token) {
            console.log('✅ New CSRF token received:', data.csrf_token);
            this.updateCsrfToken(data.csrf_token);
            console.log('✅ CSRF token updated in DOM');
            return true;
          } else {
            console.error('❌ No csrf_token in response');
          }
        } else {
          const text = await response.text();
          console.error('❌ Expected JSON but got:', contentType);
          console.error('❌ Response body:', text);
        }
      } else {
        const errorText = await response.text();
        console.error('❌ Request failed:', response.status, errorText);
      }
      
      return false;
    } catch (error) {
      console.error('💥 Network error:', error);
      return false;
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

      // ADD THIS: Set isOpen and call parent's updateState
      this.isOpen = true;
      window.activeContainer = this.container.id;
      this.updateState(); // This activates the overlay and freezes elements

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

    // ADD THIS: Set isOpen and call parent's updateState
    this.isOpen = false;
    window.activeContainer = "main-content";
    this.updateState(); // This deactivates the overlay and unfreezes elements

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