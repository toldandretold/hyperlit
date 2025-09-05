// userContainer.js
import { ContainerManager } from "./container-manager.js";
import { book } from "./app.js";
// MODIFIED: Import more functions from auth.js
import {
  setCurrentUser,
  clearCurrentUser,
  getCurrentUser,
  getAnonymousToken,
} from "./auth.js";

export class UserContainerManager extends ContainerManager {
  constructor(containerId, overlayId, buttonId, frozenContainerIds = []) {
    super(containerId, overlayId, buttonId, frozenContainerIds);

    this.setupUserContainerStyles();
    this.isAnimating = false;
    this.button = document.getElementById(buttonId);
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
      // You can optionally update the UI here if needed, e.g., change button text
      console.log("UserContainerManager initialized with user:", this.user.name);
    } else {
      console.log("UserContainerManager initialized with no user.");
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
    // This remains the same
    document.addEventListener("click", (e) => {
      if (e.target.id === "loginSubmit") {
        e.preventDefault();
        this.handleLogin();
      }
      if (e.target.id === "registerSubmit") {
        e.preventDefault();
        this.handleRegister();
      }
      if (e.target.id === "showRegister") {
        e.preventDefault();
        this.showRegisterForm();
      }
      if (e.target.id === "showLogin") {
        e.preventDefault();
        this.showLoginForm();
      }
      if (e.target.id === "logout") {
        e.preventDefault();
        this.handleLogout();
      }

      if (e.target.id === "user-overlay" && this.isOpen) {
        this.closeContainer();
      }
    });
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
          <input type="text" id="registerName" placeholder="Name" required style="width: 100%; padding: 8px; margin-bottom: 10px; border-radius: 4px; border: 1px solid #444; background: #333; color: white; box-sizing: border-box;">
          <input type="email" id="registerEmail" placeholder="Email" required style="width: 100%; padding: 8px; margin-bottom: 10px; border-radius: 4px; border: 1px solid #444; background: #333; color: white; box-sizing: border-box;">
          <input type="password" id="registerPassword" placeholder="Password" required style="width: 100%; padding: 8px; margin-bottom: 15px; border-radius: 4px; border: 1px solid #444; background: #333; color: white; box-sizing: border-box;">
          <button type="submit" id="registerSubmit" style="width: 100%; padding: 10px; background: #4EACAE; color: #221F20; border: none; border-radius: 4px; cursor: pointer; margin-bottom: 10px;">Register</button>
          <button type="button" id="showLogin" style="width: 100%; padding: 8px; background: transparent; color: #CBCCCC; border: 1px solid #444; border-radius: 4px; cursor: pointer;">Switch to Login</button>
        </form>
      </div>
    `;
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

    if (!this.isOpen && container === this.container) {
      this.openContainer("register");
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
        await this.handleAnonymousBookTransfer();

        // THIS IS THE KEY CHANGE: Clean up the alert box if it exists.
        const customAlert = document.querySelector(".custom-alert");
        if (customAlert) {
          const overlay = document.querySelector(".custom-alert-overlay");
          if (overlay) overlay.remove();
          customAlert.remove();
        }

        // The rest of the logic now works for both scenarios.
        if (typeof this.postLoginAction === "function") {
          this.postLoginAction();
          this.postLoginAction = null;
        } else {
          this.showUserProfile();
        }
      } else {
        this.showLoginError(data.errors || data.message || "Login failed");
      }
    } catch (error) {
      console.error("Login error:", error);
      this.showLoginError("Network error occurred");
    }
  }

  async handleRegister() {
    // This method is mostly fine, but we'll ensure state is synced
    const name = document.getElementById("registerName").value;
    const email = document.getElementById("registerEmail").value;
    const password = document.getElementById("registerPassword").value;

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
        this.closeContainer();
      } else {
        console.error("Logout failed:", response.status);
        clearCurrentUser();
        this.user = null;
        this.closeContainer();
      }
    } catch (error) {
      console.error("Logout error:", error);
      clearCurrentUser();
      this.user = null;
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

    // MODIFIED: This logic correctly handles both scenarios
    // If the button exists, position the container relative to it.
    if (this.button) {
      const rect = this.button.getBoundingClientRect();
      this.container.style.top = `${rect.bottom + 8}px`;
      this.container.style.left = `${rect.left}px`;
      // Ensure any previous transform is cleared for correct positioning
      this.container.style.transform = "";
    } else {
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
    }

    requestAnimationFrame(() => {
      this.container.style.width = targetWidth;
      this.container.style.height = targetHeight;
      this.container.style.opacity = "1";

      this.isOpen = true;
      window.activeContainer = this.container.id;
      this.updateState();

      this.container.addEventListener(
        "transitionend",
        () => {
          this.isAnimating = false;
        },
        { once: true }
      );
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
    console.log('Looking for anonymous books with anonId:', anonId);
    
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('MarkdownDB');
      request.onsuccess = (event) => {
        const db = event.target.result;
        const transaction = db.transaction(['library'], 'readonly');
        const store = transaction.objectStore('library');
        const getAllRequest = store.getAll();
        
        getAllRequest.onsuccess = () => {
          const allBooks = getAllRequest.result;
          console.log('All books in database:', allBooks);
          
          const books = allBooks.filter(book => {
            const hasMatchingToken = book.creator_token === anonId;
            const hasNoCreator = !book.creator || book.creator === null;
            console.log(`Book ${book.book}: creator_token=${book.creator_token}, creator=${book.creator}, matches=${hasMatchingToken && hasNoCreator}`);
            return hasMatchingToken && hasNoCreator;
          });
          
          console.log('Filtered anonymous books:', books);
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
    console.log('Transferring books to username:', userName);
    console.log('Books to transfer:', books);
    
    for (const bookRecord of books) {
      try {
        // Use the 'book' property as the ID (e.g., "book_1751354106780")
        const bookId = bookRecord.book;
        console.log('Book record:', bookRecord);
        console.log('Extracted bookId:', bookId);
        
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
    console.log('updateBookOwnership called with:', { bookId, userName });
    
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
          console.log('Retrieved book:', book);
          
          if (book) {
            // Add the username as creator (keeping creator_token as is)
            book.creator = userName;  // Store username in creator field
            book.updated_at = new Date().toISOString();
            
            console.log('Updating book with new creator:', book);
            
            const putRequest = store.put(book);
            putRequest.onsuccess = () => {
              console.log('Book ownership updated successfully');
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
}

const userManager = new UserContainerManager(
  "user-container",
  "user-overlay",
  "userButton",
  ["main-content"]
);

export default userManager;