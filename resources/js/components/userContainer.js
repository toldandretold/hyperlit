// userContainer.js
import { ContainerManager } from "../containerManager.js";
import { book } from "../app.js";
// MODIFIED: Import more functions from auth.js
import {
  setCurrentUser,
  clearCurrentUser,
  getCurrentUser,
  getAnonymousToken,
} from "../utilities/auth.js";
import { clearDatabase } from "../indexedDB/index.js";
import { syncBookDataFromDatabase } from "../postgreSQL.js";

export class UserContainerManager extends ContainerManager {
  constructor(containerId, overlayId, buttonId, frozenContainerIds = []) {
    super(containerId, overlayId, buttonId, frozenContainerIds);

    this.setupUserContainerStyles();
    this.isAnimating = false;
    this.button = document.getElementById(buttonId);
    this.boundClickHandler = this.handleDocumentClick.bind(this); // Create a bound reference
    this.setupUserListeners();
    this.user = null;

    // MODIFIED: Simplified initialization. We will rely on auth.js
    this.initializeUser();
  }

   // ADD THIS: A method to set the post-login action
  setPostLoginAction(action) {
    this.postLoginAction = action;
  }

  // ADDED: New initialization function that uses the auth module
  async initializeUser() {
    // This will trigger initializeAuth() in auth.js if it hasn't run yet
    const user = await getCurrentUser();
    if (user) {
      this.user = user;
      // Update button color to indicate logged-in state
      this.updateButtonColor();
    } else {
    }
  }

  // Update userButton SVG color based on login state
  updateButtonColor() {
    const userLogo = document.getElementById('userLogo');
    if (!userLogo) return;

    // Keep button white for now - placeholder for future login indicator
    userLogo.style.fill = '';
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
    document.addEventListener("click", this.boundClickHandler);
  }

  destroy() {
    document.removeEventListener("click", this.boundClickHandler);
    console.log('🧹 UserContainerManager: Document click listener removed.');
  }

  handleDocumentClick(e) {
      console.log(`🔗 UserContainer: Document click handler triggered`, e.target, e.target.id, e.target.tagName);
      
      if (e.target.closest("#loginSubmit")) {
        console.log(`🔗 UserContainer: Login submit clicked`);
        e.preventDefault();
        this.handleLogin();
      }
      if (e.target.closest("#registerSubmit")) {
        console.log(`🔗 UserContainer: Register submit clicked`);
        e.preventDefault();
        this.handleRegister();
      }
      if (e.target.closest("#showRegister")) {
        console.log(`🔗 UserContainer: Show register clicked`);
        e.preventDefault();
        this.showRegisterForm();
      }
      if (e.target.closest("#showLogin")) {
        console.log(`🔗 UserContainer: Show login clicked`);
        e.preventDefault();
        this.showLoginForm();
      }
      if (e.target.closest("#logout")) {
        console.log(`🔗 UserContainer: Logout clicked`);
        e.preventDefault();
        this.handleLogout();
      }

      if (e.target.closest("#user-overlay") && this.isOpen) {
        console.log(`🔗 UserContainer: User overlay clicked`);
        this.closeContainer();
      }

      if (e.target.closest("#myBooksBtn")) {
        console.log(`🔗 UserContainer: My books button clicked`);
        e.preventDefault();
        if (this.user && this.user.name) {
          this.navigateToUserBooks(this.user.name);
        } else {
          this.setPostLoginAction(() => {
            if (this.user && this.user.name) {
              this.navigateToUserBooks(this.user.name);
            }
          });
          this.showLoginForm();
        }
      }
  }


  getLoginFormHTML() {
    // The button IDs 'loginSubmit' and 'showRegister' will be automatically
    // handled by the global listener in setupUserListeners().
    // This function now correctly returns ONLY the HTML string.
    return `
      <div class="user-form">
        <h3 style="color: #EF8D34; margin-bottom: 15px;">Login</h3>
        <form id="login-form-embedded">
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
  }

  // REPLACE the existing getRegisterFormHTML with this one.
  getRegisterFormHTML() {
    // This function now correctly returns ONLY the HTML string.
    return `
      <div class="user-form">
        <h3 style="color: #EF8D34; margin-bottom: 15px;">Register</h3>
        <form id="register-form-embedded">
          <div style="margin-bottom: 10px;">
            <input type="text" id="registerName" placeholder="Username" required style="width: 100%; padding: 8px; border-radius: 4px; border: 1px solid #444; background: #333; color: white; box-sizing: border-box;">
            <div style="font-size: 11px; color: #999; margin-top: 4px; line-height: 1.3;">
              Used publicly when sharing hypertext (e.g., /u/username)
            </div>
            <div id="usernameError" style="font-size: 11px; color: #EE4A95; margin-top: 4px; display: none;"></div>
          </div>
          <input type="email" id="registerEmail" placeholder="Email" required style="width: 100%; padding: 8px; margin-bottom: 10px; border-radius: 4px; border: 1px solid #444; background: #333; color: white; box-sizing: border-box;">
          <input type="password" id="registerPassword" placeholder="Password" required style="width: 100%; padding: 8px; margin-bottom: 15px; border-radius: 4px; border: 1px solid #444; background: #333; color: white; box-sizing: border-box;">
          <button type="submit" id="registerSubmit" style="width: 100%; padding: 10px; background: #4EACAE; color: #221F20; border: none; border-radius: 4px; cursor: pointer; margin-bottom: 10px;">Register</button>
          <button type="button" id="showLogin" style="width: 100%; padding: 8px; background: transparent; color: #CBCCCC; border: 1px solid #444; border-radius: 4px; cursor: pointer;">Switch to Login</button>
        </form>
      </div>
    `;
  }

  /**
   * Validates username for URL safety
   * Returns { valid: boolean, error: string|null }
   */
  validateUsername(username) {
    if (!username || username.trim() === '') {
      return { valid: false, error: 'Username is required' };
    }

    // Check for spaces
    if (/\s/.test(username)) {
      return { valid: false, error: 'Username cannot contain spaces' };
    }

    // Check length (3-30 characters)
    if (username.length < 3) {
      return { valid: false, error: 'Username must be at least 3 characters' };
    }
    if (username.length > 30) {
      return { valid: false, error: 'Username must be 30 characters or less' };
    }

    // Check for URL-safe characters only (alphanumeric, hyphens, underscores)
    if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
      return { valid: false, error: 'Username can only contain letters, numbers, hyphens, and underscores' };
    }

    // Check that it doesn't start or end with hyphen/underscore (optional, but good UX)
    if (/^[-_]|[-_]$/.test(username)) {
      return { valid: false, error: 'Username cannot start or end with - or _' };
    }

    return { valid: true, error: null };
  }

   showLoginForm() {
    const loginHTML = this.getLoginFormHTML();
    // Find the right container: the alert box if it exists, otherwise the main container.
    const container = document.querySelector(".custom-alert") || this.container;
    container.innerHTML = loginHTML;

    // Only open the main container if we're using it and it's closed.
    if (!this.isOpen && container === this.container) {
      this.openContainer("login");
    }
  }

  // REVISED to be smarter about where it injects the form.
  showRegisterForm() {
    const registerHTML = this.getRegisterFormHTML();
    const container = document.querySelector(".custom-alert") || this.container;
    container.innerHTML = registerHTML;

    // Attach real-time validation to username input
    const usernameInput = document.getElementById('registerName');
    const errorDiv = document.getElementById('usernameError');

    if (usernameInput && errorDiv) {
      usernameInput.addEventListener('input', (e) => {
        const username = e.target.value;
        const validation = this.validateUsername(username);

        if (!validation.valid && username.length > 0) {
          // Show error
          errorDiv.textContent = validation.error;
          errorDiv.style.display = 'block';
          usernameInput.style.borderColor = '#EE4A95';
        } else {
          // Hide error
          errorDiv.style.display = 'none';
          usernameInput.style.borderColor = '#444';
        }
      });
    }

    if (!this.isOpen && container === this.container) {
      this.openContainer("register");
    }
  }

  showUserProfile() {
    console.log(`🔧 UserContainer: showUserProfile called for user ${this.user?.name}`);
    console.log(`🔧 UserContainer: Container element:`, this.container);
    console.log(`🔧 UserContainer: isOpen=${this.isOpen}`);
    
    const profileHTML = `
      <div class="user-profile">
        <h3 style="color: #EF8D34; margin-bottom: 15px;">Welcome, ${this.user.name}!</h3>
        <div style="margin-bottom: 15px;">
          <div style="border-top: 1px solid #444; padding-top: 15px;">
            <button style="width: 100%; padding: 8px; background: transparent; color: #CBCCCC; border: 1px solid #444; border-radius: 4px; cursor: pointer; margin-bottom: 8px;">
              Account Settings
            </button>
            <button id="myBooksBtn" style="width: 100%; padding: 8px; background: transparent; color: #CBCCCC; border: 1px solid #444; border-radius: 4px; cursor: pointer; margin-bottom: 8px;">
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
    
    console.log(`🔧 UserContainer: Generated profile HTML (${profileHTML.length} chars)`);
    
    if (!this.isOpen) {
      console.log(`🔧 UserContainer: Container closed, setting innerHTML and opening`);
      this.container.innerHTML = profileHTML;
      this.openContainer("profile");
    } else {
      console.log(`🔧 UserContainer: Container already open, just updating innerHTML`);
      this.container.innerHTML = profileHTML;
    }
    
    // NEW: Directly attach event listeners to the buttons we just created
    const logoutBtn = this.container.querySelector('#logout');
    if (logoutBtn) {
        console.log('🔧 Attaching direct listener to #logout button.', logoutBtn);
        logoutBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation(); // Stop the click from bubbling further
            console.log('✅ LOGOUT BUTTON DIRECT LISTENER CLICKED');
            this.handleLogout();
        });
    } else {
        console.log('❌ LOGOUT BUTTON NOT FOUND IN CONTAINER');
    }

    const myBooksBtn = this.container.querySelector('#myBooksBtn');
    if (myBooksBtn) {
        console.log('🔧 Attaching direct listener to #myBooksBtn.', myBooksBtn);
        myBooksBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation(); // Stop the click from bubbling further
            console.log('✅ MY BOOKS BUTTON DIRECT LISTENER CLICKED');
            if (this.user && this.user.name) {
              this.navigateToUserBooks(this.user.name);
            } else {
              this.setPostLoginAction(() => {
                if (this.user && this.user.name) {
                  this.navigateToUserBooks(this.user.name);
                }
              });
              this.showLoginForm();
            }
        });
    } else {
        console.log('❌ MY BOOKS BUTTON NOT FOUND IN CONTAINER');
    }

    console.log(`🔧 UserContainer: showUserProfile completed`);
  }

  getCsrfTokenFromCookie() {
    const value = `; ${document.cookie}`;
    const parts = value.split(`; XSRF-TOKEN=`);
    if (parts.length === 2) {
      return decodeURIComponent(parts.pop().split(";").shift());
    }
    return null;
  }

  // userContainer.js -> inside the UserContainerManager class

  async handleLogin() {
    const email = document.getElementById("loginEmail").value;
    const password = document.getElementById("loginPassword").value;


    try {
      await fetch("/sanctum/csrf-cookie", { credentials: "include" });
      const csrfToken = this.getCsrfTokenFromCookie();


      const response = await fetch("/api/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "X-Requested-With": "XMLHttpRequest",
          "X-XSRF-TOKEN": csrfToken,
        },
        credentials: "include",
        body: JSON.stringify({ email, password }),
      });


      const data = await response.json();

      if (response.ok && data.success) {
        setCurrentUser(data.user);
        this.user = data.user;
        console.log("✅ Login successful for user:", data.user?.name || "user");

        // Update button color to green
        this.updateButtonColor();

        // Check if there's anonymous content to transfer
        if (data.anonymous_content) {
          this.showAnonymousContentTransfer(data.anonymous_content);
        } else {
          // No anonymous content, so REFRESH to get correct auth context everywhere
          console.log("✅ Login successful - clearing all cached data for fresh auth context");
          await this.clearAllCachedData();
          this.proceedAfterLogin();
        }
      } else {
        console.error("❌ Login failed:", data);
        this.showLoginError(data.errors || data.message || "Login failed");
      }
    } catch (error) {
      console.error("❌ Login error:", error);
      this.showLoginError("Network error occurred");
    }
  }

  async handleRegister() {
    // This method is mostly fine, but we'll ensure state is synced
    const name = document.getElementById("registerName").value;
    const email = document.getElementById("registerEmail").value;
    const password = document.getElementById("registerPassword").value;

    // Validate username before submitting
    const validation = this.validateUsername(name);
    if (!validation.valid) {
      this.showRegisterError(validation.error);
      return;
    }

    try {
      await fetch("/sanctum/csrf-cookie", {
        credentials: "include",
      });

      const csrfToken = this.getCsrfTokenFromCookie();

      const response = await fetch("/api/register", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "X-Requested-With": "XMLHttpRequest",
          "X-XSRF-TOKEN": csrfToken,
        },
        credentials: "include",
        body: JSON.stringify({ name, email, password }),
      });

      const data = await response.json();

      if (response.ok && data.success) {
        // MODIFIED: Update state in both places
        setCurrentUser(data.user);
        this.user = data.user;
        console.log("✅ Registration successful for user:", data.user?.name || "user");

        // Update button color to green
        this.updateButtonColor();

        this.showUserProfile();
      } else {
        this.showRegisterError(
          data.errors || data.message || "Registration failed"
        );
      }
    } catch (error) {
      console.error("Register error:", error);
      this.showRegisterError("Network error occurred");
    }
  }

  async handleLogout() {
    try {
      await fetch("/sanctum/csrf-cookie", {
        credentials: "include",
      });

      const csrfToken = this.getCsrfTokenFromCookie();

      const response = await fetch("/logout", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "X-Requested-With": "XMLHttpRequest",
          "X-XSRF-TOKEN": csrfToken,
        },
        credentials: "include",
      });

      if (response.ok) {
        // MODIFIED: Centralize state clearing
        clearCurrentUser();
        this.user = null;

        // Reset button color to default
        this.updateButtonColor();

        // Clear all cached data after logout for fresh anonymous context
        console.log("✅ Logout successful - clearing all cached data for fresh anonymous context");
        try {
          await this.clearAllCachedData();
        } catch (error) {
          console.error("❌ Error clearing cached data after logout:", error);
        }

        this.closeContainer();
      } else {
        console.error("Logout failed:", response.status);
        clearCurrentUser();
        this.user = null;
        this.updateButtonColor();
        this.closeContainer();
      }
    } catch (error) {
      console.error("Logout error:", error);
      clearCurrentUser();
      this.user = null;
      this.updateButtonColor();
      this.closeContainer();
    }
  }

  // ... (error handling and other methods remain the same) ...
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
    // Add a guard to prevent rapid re-triggering during animation
    if (this.isAnimating) {
      console.log('UserContainer: Animation in progress, ignoring toggle request.');
      return;
    }

    console.log(`🔧 UserContainer: toggleContainer called, isOpen=${this.isOpen}, user=${this.user?.name || 'null'}`);
    
    if (this.isOpen) {
      console.log(`🔧 UserContainer: Container is open, closing it`);
      this.closeContainer();
    } else {
      if (this.user) {
        console.log(`🔧 UserContainer: User logged in, showing profile for ${this.user.name}`);
        this.showUserProfile();
      } else {
        console.log(`🔧 UserContainer: No user, showing login form`);
        this.showLoginForm();
      }
    }
  }

  openContainer(mode = "login") {
    console.log(`🔧 UserContainer: openContainer called with mode=${mode}`);
    console.log(`🔧 UserContainer: isAnimating=${this.isAnimating}, container=`, this.container);
    
    if (this.isAnimating) {
      console.log(`🔧 UserContainer: Already animating, returning early`);
      return;
    }
    this.isAnimating = true;

    // MODIFIED: This logic correctly handles both scenarios
    // If the button exists, position the container relative to it.
    if (this.button) {
      console.log(`🔧 UserContainer: Positioning relative to button`, this.button);
      const rect = this.button.getBoundingClientRect();
      console.log(`🔧 UserContainer: Button rect:`, { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right });
      this.container.style.top = `${rect.bottom + 8}px`;
      this.container.style.left = `${rect.left}px`;
      // Ensure any previous transform is cleared for correct positioning
      this.container.style.transform = "";
    } else {
      console.log(`🔧 UserContainer: No button found, centering on screen`);
      // NEW: If no button, center the container on the screen.
      this.container.style.top = "50%";
      this.container.style.left = "50%";
      this.container.style.transform = "translate(-50%, -50%)";
    }

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
    } else if (mode === "transfer-prompt") {
      targetWidth = "320px";
      targetHeight = "auto";
      this.container.style.padding = "20px";
    }

    console.log(`🔧 UserContainer: About to start requestAnimationFrame with targetWidth=${targetWidth}, targetHeight=${targetHeight}`);
    
    requestAnimationFrame(() => {
      console.log(`🔧 UserContainer: Inside requestAnimationFrame callback`);
      
      try {
        this.container.style.width = targetWidth;
        this.container.style.height = targetHeight;
        this.container.style.opacity = "1";
        console.log(`🔧 UserContainer: Styles applied`);

        this.isOpen = true;
        window.activeContainer = this.container.id;
        this.updateState();
        console.log(`🔧 UserContainer: State updated, isOpen=${this.isOpen}`);

        const resetAnimation = () => {
          this.isAnimating = false;
          console.log(`🔧 UserContainer: Animation reset via transitionend`);
        };

        this.container.addEventListener("transitionend", resetAnimation, { once: true });
        console.log(`🔧 UserContainer: Transitionend listener attached`);
        
        // Fallback timeout in case transitionend doesn't fire
        setTimeout(() => {
          if (this.isAnimating) {
            this.isAnimating = false;
            console.log(`🔧 UserContainer: Animation reset via timeout fallback`);
          }
        }, 1000);
        
      } catch (error) {
        console.error(`❌ UserContainer: Error in requestAnimationFrame:`, error);
        this.isAnimating = false;
      }
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

  async handleAnonymousBookTransfer() {
    if (!this.user) return;
    
    const anonId = await getAnonymousToken();
    if (!anonId) return;
    
    try {
      // Get all books with this anonymous ID as creator_token
      const anonymousBooks = await this.getAnonymousBooks(anonId);
      
      if (anonymousBooks.length > 0) {
        // Show confirmation dialog to user
        const shouldTransfer = await this.confirmBookTransfer(anonymousBooks);
        
        if (shouldTransfer) {
          await this.transferBooksToUser(anonymousBooks, anonId);
          // Clear the anonymous ID after successful transfer
          localStorage.removeItem('authorId');
        }
      }
    } catch (error) {
      console.error('Error transferring anonymous books:', error);
    }
  }

  async getAnonymousBooks(anonId) {
    console.log('🔍 Checking for anonymous books with token: [token]');
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('MarkdownDB');
      request.onsuccess = (event) => {
        const db = event.target.result;
        const transaction = db.transaction(['library'], 'readonly');
        const store = transaction.objectStore('library');
        const getAllRequest = store.getAll();
        
        getAllRequest.onsuccess = () => {
          const allBooks = getAllRequest.result;
          
          const books = allBooks.filter(book => {
            const hasMatchingToken = book.creator_token === anonId;
            const hasNoCreator = !book.creator || book.creator === null;
            return hasMatchingToken && hasNoCreator;
          });
          
          resolve(books);
        };
        
        getAllRequest.onerror = () => reject(getAllRequest.error);
      };
      request.onerror = () => reject(request.error);
    });
  }

  async confirmBookTransfer(books) {
    return new Promise((resolve) => {
      // Use the 'book' property for the titles display
      const bookTitles = books.map(book => book.title || 'Untitled').join(', ');
      const message = `You have ${books.length} book(s) created while not logged in: ${bookTitles}. 
      
  Would you like to transfer ownership to your account?`;
      
      // Create a custom modal instead of using confirm()
      this.showTransferConfirmation(message, resolve);
    });
  }
  

  showTransferConfirmation(message, callback) {
    const modal = document.createElement('div');
    modal.style.cssText = `
      position: fixed; top: 0; left: 0; width: 100%; height: 100%;
      background: rgba(0,0,0,0.7); z-index: 2000; display: flex;
      align-items: center; justify-content: center;
    `;
    
    modal.innerHTML = `
      <div style="background: #221F20; padding: 20px; border-radius: 8px; max-width: 400px; color: white;">
        <h3 style="color: #EF8D34; margin-bottom: 15px;">Transfer Anonymous Books?</h3>
        <p style="margin-bottom: 20px; line-height: 1.4;">${message}</p>
        <div style="display: flex; gap: 10px; justify-content: flex-end;">
          <button id="cancelTransfer" style="padding: 8px 16px; background: transparent; color: #CBCCCC; border: 1px solid #444; border-radius: 4px; cursor: pointer;">
            Cancel
          </button>
          <button id="confirmTransfer" style="padding: 8px 16px; background: #4EACAE; color: #221F20; border: none; border-radius: 4px; cursor: pointer;">
            Transfer Books
          </button>
        </div>
      </div>
    `;
    
    document.body.appendChild(modal);
    
    modal.querySelector('#confirmTransfer').onclick = () => {
      document.body.removeChild(modal);
      callback(true);
    };
    
    modal.querySelector('#cancelTransfer').onclick = () => {
      document.body.removeChild(modal);
      callback(false);
    };
  }

  async transferBooksToUser(books, anonId) {
    const userName = this.user.name;  // Use username from logged-in user
    
    for (const bookRecord of books) {
      try {
        // Use the 'book' property as the ID (e.g., "book_1751354106780")
        const bookId = bookRecord.book;
        
        if (!bookId) {
          console.error('No valid ID found for book:', bookRecord);
          continue;
        }
        
        // Update local IndexedDB
        await this.updateBookOwnership(bookId, userName);
        
        // Update backend
        await this.updateBookOwnershipBackend(bookId, anonId);
        
      } catch (error) {
        console.error(`Failed to transfer book:`, error);
        console.error('Book record was:', bookRecord);
      }
    }
  }

 async updateBookOwnership(bookId, userName) {
    
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('MarkdownDB');
      request.onsuccess = (event) => {
        const db = event.target.result;
        const transaction = db.transaction(['library'], 'readwrite');
        const store = transaction.objectStore('library');
        
        if (!bookId) {
          reject(new Error('Invalid book ID provided'));
          return;
        }
        
        const getRequest = store.get(bookId);
        getRequest.onsuccess = () => {
          const book = getRequest.result;
          
          if (book) {
            // Add the username as creator (keeping creator_token as is)
            book.creator = userName;  // Store username in creator field
            book.updated_at = new Date().toISOString();
            
            
            const putRequest = store.put(book);
            putRequest.onsuccess = () => {
              resolve();
            };
            putRequest.onerror = () => {
              console.error('Error updating book:', putRequest.error);
              reject(putRequest.error);
            };
          } else {
            console.error('Book not found with ID:', bookId);
            reject(new Error(`Book not found with ID: ${bookId}`));
          }
        };
        getRequest.onerror = () => {
          console.error('Error getting book:', getRequest.error);
          reject(getRequest.error);
        };
      };
      request.onerror = () => {
        console.error('Error opening database:', request.error);
        reject(request.error);
      };
    });
  }
  

  async updateBookOwnershipBackend(bookId, anonId) {
      const csrfToken = this.getCsrfTokenFromCookie();
      
      const response = await fetch(`/books/${bookId}/transfer-ownership`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
          'X-XSRF-TOKEN': csrfToken
        },
        credentials: 'include',
        body: JSON.stringify({ 
          anonymous_token: anonId 
        })
      });
      
      if (!response.ok) {
        throw new Error(`Backend transfer failed: ${response.status}`);
      }
    }

  showAnonymousContentTransfer(anonymousContent) {
    
    // Clean up any existing alert boxes
    const customAlert = document.querySelector(".custom-alert");
    if (customAlert) {
      const overlay = document.querySelector(".custom-alert-overlay");
      if (overlay) overlay.remove();
      customAlert.remove();
    }

    // Use the user container instead of source-container
    if (!this.isOpen) {
      // Container isn't open, so we need to open it to show the prompt
      this.openContainer("transfer-prompt");
    }

    // Create summary of content
    const totalBooks = anonymousContent.books?.length || 0;
    const totalHighlights = anonymousContent.highlights?.length || 0;
    const totalCites = anonymousContent.cites?.length || 0;
    
    
    let contentSummary = [];
    if (totalBooks > 0) contentSummary.push(`${totalBooks} book${totalBooks > 1 ? 's' : ''}`);
    if (totalHighlights > 0) contentSummary.push(`${totalHighlights} highlight${totalHighlights > 1 ? 's' : ''}`);
    if (totalCites > 0) contentSummary.push(`${totalCites} citation${totalCites > 1 ? 's' : ''}`);


    const htmlContent = `
      <div class="user-form">
        <h3 style="color: #EF8D34; margin-bottom: 15px;">Welcome back!</h3>
        <p style="margin-bottom: 20px; line-height: 1.4; color: #CBCCCC;">
          You created ${contentSummary.join(', ')} while logged out. Would you like to bring them into your account?
        </p>
        <button id="confirmContentTransfer" style="width: 100%; padding: 10px; background: #4EACAE; color: #221F20; border: none; border-radius: 4px; cursor: pointer; margin-bottom: 10px;">
          Yes, bring them in
        </button>
        <button id="skipContentTransfer" style="width: 100%; padding: 8px; background: transparent; color: #CBCCCC; border: 1px solid #444; border-radius: 4px; cursor: pointer;">
          Skip for now
        </button>
      </div>
    `;
    
    this.container.innerHTML = htmlContent;

    // Add event listeners
    const confirmButton = document.getElementById('confirmContentTransfer');
    const skipButton = document.getElementById('skipContentTransfer');
    
    
    if (confirmButton) {
      confirmButton.onclick = async () => {
        await this.transferAnonymousContent(anonymousContent.token);
        // ALWAYS REFRESH on login - auth context has changed
        console.log("✅ Content transferred - clearing all cached data for fresh auth context");
        await this.clearAllCachedData();
        // After transfer, show the user profile in the same container
        setTimeout(() => this.showUserProfile(), 500);
      };
    }

    if (skipButton) {
      skipButton.onclick = async () => {
        // REFRESH when rejecting transfer (auth change from anonymous to logged-in)
        console.log("🧹 User skipped transfer - clearing all cached data for auth change");
        
        try {
          // Use the nuclear option - clear everything and set invalidation timestamp
          await this.clearAllCachedData();
          
          // Go directly to user profile in the same container
          this.showUserProfile();
          
        } catch (error) {
          console.error("❌ Error during cache clearing:", error);
          // Force reload anyway to ensure clean state
          window.location.reload(true);
        }
      };
    }
    
  }

  hideSourceContainer() {
    const sourceContainer = document.getElementById('source-container');
    if (sourceContainer) {
      sourceContainer.classList.add('hidden');
      sourceContainer.style.width = '0px';
      sourceContainer.style.height = '0px';
      sourceContainer.style.opacity = '0';
      sourceContainer.innerHTML = '';
    }
  }

  async transferAnonymousContent(token) {
    try {
      const csrfToken = this.getCsrfTokenFromCookie();
      const response = await fetch('/api/auth/associate-content', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
          'X-XSRF-TOKEN': csrfToken
        },
        credentials: 'include',
        body: JSON.stringify({ anonymous_token: token })
      });

      if (response.ok) {
      } else {
        console.error("❌ API Error during content association:", await response.text());
      }
    } catch (error) {
      console.error("❌ Fetch error during content association:", error);
    }
  }

  async forceServerDataRefresh() {
    try {
      console.log("🔄 Forcing server data refresh with new auth context");
      
      // Refresh data from server for the current book if available
      if (book && book.id) {
        console.log(`🔄 Refreshing book data from server: ${book.id}`);
        await syncBookDataFromDatabase(book.id);
        console.log("✅ Book data refreshed from server with correct auth context");
        // Force content re-render with new auth context
        await this.triggerContentRefresh(book.id);
      } else if (book) {
        // book might be a string directly, not an object with .id
        console.log(`🔄 Refreshing book data from server: ${book}`);
        await syncBookDataFromDatabase(book);
        console.log("✅ Book data refreshed from server with correct auth context");
        // Force content re-render with new auth context
        await this.triggerContentRefresh(book);
      } else {
        console.log("ℹ️ No current book to refresh");
      }
      
    } catch (error) {
      console.error("❌ Error during server data refresh:", error);
      // If server refresh fails, force a page reload as fallback
      console.log("🔄 Server refresh failed, falling back to page reload");
      window.location.reload();
    }
  }

  async triggerContentRefresh(bookId) {
    try {
      console.log(`🎨 Triggering content refresh for ${bookId} with new auth context`);

      // Import the lazy loader to refresh content
      const { currentLazyLoader } = await import('../initializePage.js');
      if (currentLazyLoader && typeof currentLazyLoader.refresh === 'function') {
        console.log("🔄 Refreshing lazy loader content with new data");
        await currentLazyLoader.refresh();
        console.log("✅ Content refreshed successfully");
      } else {
        console.log("⚠️ Lazy loader not available or no refresh method, forcing page reload");
        window.location.reload();
      }
      
    } catch (error) {
      console.error("❌ Error during content refresh:", error);
      // If content refresh fails, force a page reload as fallback
      window.location.reload();
    }
  }

  async clearAllCachedData() {
    try {
      console.log("🧹 NUCLEAR OPTION: Clearing ALL cached data due to auth change");
      
      // 1. Set cache invalidation timestamp - this will force ALL pages to refresh
      const invalidationTimestamp = Date.now();
      localStorage.setItem('auth_cache_invalidation', invalidationTimestamp);
      console.log(`🕒 Set cache invalidation timestamp: ${invalidationTimestamp}`);
      
      // 2. Clear IndexedDB completely
      await clearDatabase();
      console.log("✅ IndexedDB cleared");
      
      // 3. Clear browser cache storage
      await this.clearBrowserCache();
      console.log("✅ Browser cache cleared");
      
      // 4. Clear localStorage except the invalidation timestamp and critical data
      const criticalKeys = ['auth_cache_invalidation'];
      const preservedData = {};
      criticalKeys.forEach(key => {
        if (localStorage.getItem(key)) {
          preservedData[key] = localStorage.getItem(key);
        }
      });
      localStorage.clear();
      // Restore critical data
      Object.entries(preservedData).forEach(([key, value]) => {
        localStorage.setItem(key, value);
      });
      console.log("✅ localStorage cleared (preserved critical keys)");
      
      // 5. Clear sessionStorage (except critical session data)
      const criticalSessionKeys = ['pending_new_book_sync', 'imported_book_flag'];
      const sessionData = {};
      criticalSessionKeys.forEach(key => {
        if (sessionStorage.getItem(key)) {
          sessionData[key] = sessionStorage.getItem(key);
        }
      });
      sessionStorage.clear();
      // Restore critical session data
      Object.entries(sessionData).forEach(([key, value]) => {
        sessionStorage.setItem(key, value);
      });
      console.log("✅ sessionStorage cleared (preserved critical keys)");
      
      console.log("💥 ALL CACHED DATA CLEARED + INVALIDATION TIMESTAMP SET");
      console.log("🎯 Any page that loads will check this timestamp and refresh if needed");
      
    } catch (error) {
      console.error("❌ Error during complete cache clearing:", error);
      // Nuclear fallback: reload the page
      console.log("🔄 Cache clearing failed, forcing page reload");
      window.location.reload();
    }
  }

  async clearAndRefreshDatabase() {
    try {
      // Clear all IndexedDB data
      await clearDatabase();
      console.log("🧹 IndexedDB cleared successfully");
      
      // Clear browser cache storage
      await this.clearBrowserCache();
      
      // Force server refresh
      await this.forceServerDataRefresh();
      
    } catch (error) {
      console.error("❌ Error during database refresh:", error);
      // If there's an error, still try to reload the page
      setTimeout(() => {
        window.location.reload();
      }, 1000);
    }
  }

  /**
   * Clears all caches managed by the CacheStorage API.
   */
  async clearBrowserCache() {
    if ('caches' in window) {
      try {
        console.log('🧹 Clearing browser caches...');
        const keys = await caches.keys();
        await Promise.all(keys.map(key => caches.delete(key)));
        console.log('✅ Browser caches cleared.');
      } catch (error) {
        console.error('❌ Error clearing browser caches:', error);
      }
    }
  }

  proceedAfterLogin() {
    // Clean up any alert boxes
    const customAlert = document.querySelector(".custom-alert");
    if (customAlert) {
      const overlay = document.querySelector(".custom-alert-overlay");
      if (overlay) overlay.remove();
      customAlert.remove();
    }

    // Proceed with normal post-login flow
    if (typeof this.postLoginAction === "function") {
      this.postLoginAction();
      this.postLoginAction = null;
    } else {
      this.showUserProfile();
    }
  }

  /**
   * Sanitize username by removing all spaces
   * Ensures URLs like /u/MrJohns work with DB username "Mr Johns"
   */
  sanitizeUsername(username) {
    return username.replace(/\s+/g, '');
  }

  /**
   * Navigate to user's books page using SPA transition
   */
  async navigateToUserBooks(username) {
    // Sanitize username for URL (remove spaces)
    const sanitizedUsername = this.sanitizeUsername(username);

    try {
      console.log(`📚 UserContainer: Navigating to user books for ${username} using SPA`);

      // Close the user container first
      this.closeContainer();

      // Use NEW structure-aware navigation system
      // This will automatically detect home→user transition and use DifferentTemplateTransition
      const { NavigationManager } = await import('../navigation/NavigationManager.js');
      await NavigationManager.navigateByStructure({
        toBook: encodeURIComponent(sanitizedUsername),
        targetUrl: `/u/${encodeURIComponent(sanitizedUsername)}`,
        targetStructure: 'user', // Explicitly specify user page structure
        hash: ''
      });

      console.log(`✅ UserContainer: Successfully navigated to ${username}'s books`);
    } catch (error) {
      console.error('❌ UserContainer: SPA navigation failed, falling back to page reload:', error);
      // Fallback to new /u/{username} URL format (sanitized)
      window.location.href = "/u/" + encodeURIComponent(sanitizedUsername);
    }
  }
}

// Container manager instance
let userManager = null;

// Initialize function that can be called after DOM changes
export function initializeUserContainer() {
  if (document.getElementById("userButton")) {
    if (!userManager) {
      userManager = new UserContainerManager(
        "user-container",
        "user-overlay",
        "userButton",
        ["main-content"]
      );
      console.log('✅ UserContainer: Initialized new manager');
    } else {
      // Manager exists, just update button reference
      userManager.button = document.getElementById("userButton");
      userManager.rebindElements();
      // Update button color after rebind to maintain logged-in state
      userManager.updateButtonColor();
      console.log('✅ UserContainer: Updated existing manager');
    }
    return userManager;
  } else {
    console.log('ℹ️ UserContainer: Button not found, skipping initialization');
    return null;
  }
}

// Auto-initialize if button exists on initial load
if (document.getElementById("userButton")) {
  userManager = initializeUserContainer();
}

// Destroy function for cleanup during navigation
export function destroyUserContainer() {
  if (userManager) {
    console.log('🧹 Destroying user container manager');
    // Clean up any open containers
    if (userManager.isOpen) {
      userManager.closeContainer();
    }
    // Call the new destroy method to remove listeners
    userManager.destroy();
    // Nullify the singleton instance
    userManager = null;
    return true;
  }
  return false;
}

export default userManager;
