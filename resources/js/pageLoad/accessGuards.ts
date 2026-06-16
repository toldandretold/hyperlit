/**
 * 🔒 Handle access denied to private book
 * Shows appropriate UI based on login status
 */
export async function handlePrivateBookAccessDenied(bookId: string) {
  console.log(`🔒 handlePrivateBookAccessDenied called for book: ${bookId}`);

  const { getCurrentUser } = await import('../utilities/auth/index');
  const user = await getCurrentUser();

  if (!user) {
    // Not logged in - show login prompt
    showPrivateBookLoginPrompt(bookId);
  } else {
    // Logged in but not authorized - show access denied message
    showPrivateBookAccessDenied(bookId, user);
  }
}

/**
 * 🔒 Show login prompt for private book access
 * Pattern from editButton.js
 */
function showPrivateBookLoginPrompt(bookId: string) {
  console.log(`🔑 Showing login prompt for private book: ${bookId}`);

  const overlay = document.createElement("div");
  overlay.className = "custom-alert-overlay";
  overlay.style.cssText = "position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0, 0, 0, 0.8); display: flex; align-items: center; justify-content: center; z-index: 10000;";

  const alertBox = document.createElement("div");
  alertBox.className = "custom-alert";
  alertBox.style.cssText = "background: #2a2a2a; padding: 30px; border-radius: 8px; max-width: 500px; color: #fff;";

  alertBox.innerHTML = `
    <div class="user-form">
      <h3 style="margin: 0 0 15px 0; color: #EF8D34;">Private Book</h3>
      <p style="margin: 0 0 20px 0; line-height: 1.6;">This is private hypertext.</p>
      <div class="alert-buttons" style="display: flex; gap: 10px; justify-content: flex-end;">
        <button type="button" id="goHomeButtonLogin" class="alert-button secondary" style="padding: 10px 20px; border: 1px solid #666; background: transparent; color: #fff; border-radius: 4px; cursor: pointer;">Go to Home</button>
        <button type="button" id="showLoginButton" class="alert-button primary" style="padding: 10px 20px; background: #EF8D34; color: #fff; border: none; border-radius: 4px; cursor: pointer;">Log In</button>
      </div>
    </div>
  `;

  overlay.appendChild(alertBox);
  document.body.appendChild(overlay);

  // Handle button clicks
  alertBox.addEventListener("click", async (e: any) => {
    const targetId = e.target.id;

    if (targetId === "goHomeButtonLogin") {
      window.location.href = "/";
    } else if (targetId === "showLoginButton") {
      // Dynamically import userContainer to avoid circular dependency
      const { initializeUserContainer } = await import('../components/userButton/userButton');

      // Initialize userManager singleton if not already initialized
      const userManager = initializeUserContainer();

      if (!userManager) {
        console.error("❌ userManager could not be initialized (userButton not found in DOM)");
        alert("Login form could not be loaded. Please refresh the page and try again.");
        return;
      }

      // Set post-login action to reload the page
      userManager.setPostLoginAction(() => {
        console.log("✅ User logged in, reloading page to check access");
        window.location.reload();
      });

      // Show login form inside the .custom-alert
      userManager.showLoginForm();

      // Add cancel button
      const buttonContainer = alertBox.querySelector(".alert-buttons");
      if (buttonContainer) {
        const cancelButton = document.createElement("button");
        cancelButton.type = "button";
        cancelButton.id = "cancelLoginButton";
        cancelButton.className = "alert-button secondary";
        cancelButton.textContent = "Cancel";
        cancelButton.style.cssText = "padding: 10px 20px; border: 1px solid #666; background: transparent; color: #fff; border-radius: 4px; cursor: pointer;";
        buttonContainer.appendChild(cancelButton);

        cancelButton.addEventListener("click", () => {
          document.body.removeChild(overlay);
        });
      }
    }
  });
}

/**
 * 🔒 Show access denied message for logged-in user without permission
 */
function showPrivateBookAccessDenied(bookId: string, user: any) {
  console.log(`🔒 Showing access denied for user ${user.name} to book: ${bookId}`);

  const overlay = document.createElement("div");
  overlay.className = "custom-alert-overlay";
  overlay.style.cssText = "position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0, 0, 0, 0.8); display: flex; align-items: center; justify-content: center; z-index: 10000;";

  const alertBox = document.createElement("div");
  alertBox.className = "custom-alert";
  alertBox.style.cssText = "background: #2a2a2a; padding: 30px; border-radius: 8px; max-width: 500px; color: #fff;";

  alertBox.innerHTML = `
    <div class="user-form">
      <h3 style="margin: 0 0 15px 0; color: #EF8D34;">Access Denied</h3>
      <p style="margin: 0 0 20px 0; line-height: 1.6;">You don't have permission to access this private book.</p>
      <div class="alert-buttons" style="display: flex; gap: 10px; justify-content: flex-end;">
        <button type="button" id="goHomeButtonDenied" class="alert-button primary" style="padding: 10px 20px; background: #EF8D34; color: #fff; border: none; border-radius: 4px; cursor: pointer;">Go to Home</button>
      </div>
    </div>
  `;

  overlay.appendChild(alertBox);
  document.body.appendChild(overlay);

  // Handle button click
  document.getElementById("goHomeButtonDenied")!.addEventListener("click", () => {
    window.location.href = "/";
  });
}

/**
 * 🗑️ Handle access to deleted book
 * Shows a message that the book has been deleted
 */
export async function handleDeletedBookAccess(bookId: string) {
  console.log(`🗑️ handleDeletedBookAccess called for book: ${bookId}`);

  const overlay = document.createElement("div");
  overlay.className = "custom-alert-overlay";
  overlay.style.cssText = "position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0, 0, 0, 0.8); display: flex; align-items: center; justify-content: center; z-index: 10000;";

  const alertBox = document.createElement("div");
  alertBox.className = "custom-alert";
  alertBox.style.cssText = "background: #2a2a2a; padding: 30px; border-radius: 8px; max-width: 500px; color: #fff;";

  alertBox.innerHTML = `
    <div class="user-form">
      <h3 style="margin: 0 0 15px 0; color: #d73a49;">
        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle; margin-right: 8px;"><path d="M3 6h18"></path><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
        Book Deleted
      </h3>
      <p style="margin: 0 0 20px 0; line-height: 1.6;">This book has been deleted and is no longer available.</p>
      <div class="alert-buttons" style="display: flex; gap: 10px; justify-content: flex-end;">
        <button type="button" id="goHomeButtonDeleted" class="alert-button primary" style="padding: 10px 20px; background: #EF8D34; color: #fff; border: none; border-radius: 4px; cursor: pointer;">Go to Home</button>
      </div>
    </div>
  `;

  overlay.appendChild(alertBox);
  document.body.appendChild(overlay);

  // Handle button click
  document.getElementById("goHomeButtonDeleted")!.addEventListener("click", () => {
    window.location.href = "/";
  });
}
